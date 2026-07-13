import "./types";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { createAuth } from "./auth";
import {
  user as authUser,
  type DeviceKind,
  devices,
  imageObjects,
  messages,
  schema,
} from "./schema";

const retentionMs = 30 * 24 * 60 * 60 * 1000;
const maxImageBytes = 20 * 1024 * 1024;
const imageTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const tabletPattern = /ipad|tablet/i;
const mobilePattern = /mobile|iphone|android/i;
const iphonePattern = /iphone/i;
const ipadPattern = /ipad/i;
const macPattern = /macintosh|mac os x/i;
const windowsPattern = /windows/i;
const androidPattern = /android/i;

type Variables = {
  user: { id: string; email: string; name: string };
  device: typeof devices.$inferSelect;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.post("/api/auth/email-exists", async (context) => {
  const db = drizzle(context.env.DB, { schema });
  const input = await context.req.json<{ email?: string }>();
  const email = input.email?.trim().toLowerCase();
  if (!email) {
    return context.json({ exists: false });
  }
  const existing = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.email, email))
    .get();
  return context.json({ exists: Boolean(existing) });
});

app.on(["GET", "POST"], "/api/auth/*", (context) => {
  const db = drizzle(context.env.DB, { schema });
  return createAuth(context.env, db, context.req.raw).handler(context.req.raw);
});

app.use("/api/*", async (context, next) => {
  const db = drizzle(context.env.DB, { schema });
  const auth = createAuth(context.env, db, context.req.raw);
  const session = await auth.api.getSession({
    headers: context.req.raw.headers,
  });
  if (!session) {
    return context.json({ error: "Authentication required" }, 401);
  }
  context.set("user", session.user);
  await next();
});

app.get("/api/bootstrap", async (context) => {
  const db = drizzle(context.env.DB, { schema });
  const user = context.get("user");
  const device = await ensureCurrentDevice(context, db);
  const allDevices = await db
    .select()
    .from(devices)
    .where(eq(devices.userId, user.id))
    .orderBy(desc(devices.lastSeenAt));
  return context.json({
    user,
    currentDevice: device,
    devices: allDevices,
  });
});

app.patch("/api/devices/:deviceId", async (context) => {
  const db = drizzle(context.env.DB, { schema });
  const user = context.get("user");
  const deviceId = context.req.param("deviceId");
  const input = await context.req.json<{ displayName?: string }>();
  const displayName = normalizeDeviceName(input.displayName);
  if (!displayName) {
    return context.json({ error: "Device name must be 2-32 characters" }, 400);
  }
  const existing = await db
    .select({ id: devices.id })
    .from(devices)
    .where(
      and(eq(devices.userId, user.id), eq(devices.displayName, displayName))
    )
    .get();
  if (existing && existing.id !== deviceId) {
    return context.json({ error: "Device name is already used" }, 409);
  }
  await db
    .update(devices)
    .set({ displayName })
    .where(and(eq(devices.userId, user.id), eq(devices.id, deviceId)));
  return context.json({ ok: true });
});

app.post("/api/devices/:deviceId/revoke", async (context) => {
  const db = drizzle(context.env.DB, { schema });
  await db
    .update(devices)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(devices.userId, context.get("user").id),
        eq(devices.id, context.req.param("deviceId"))
      )
    );
  return context.json({ ok: true });
});

app.get("/api/messages", async (context) => {
  const db = drizzle(context.env.DB, { schema });
  const user = context.get("user");
  const sourceDeviceId = context.req.query("sourceDeviceId");
  const localDate = context.req.query("localDate");
  const timezone = context.req.query("timezone");
  if (!sourceDeviceId) {
    return context.json({ error: "sourceDeviceId is required" }, 400);
  }
  const filters = [
    eq(messages.userId, user.id),
    eq(messages.senderDeviceId, sourceDeviceId),
    isNull(messages.deletedAt),
  ];
  if (localDate) {
    filters.push(eq(messages.localDate, localDate));
  }
  const rows = await db
    .select()
    .from(messages)
    .leftJoin(imageObjects, eq(messages.id, imageObjects.messageId))
    .where(and(...filters))
    .orderBy(desc(messages.createdAt))
    .limit(100);
  logSync("messages_list", {
    sourceDeviceId,
    localDate,
    timezone,
    count: rows.length,
    latestId: rows[0]?.messages.id,
    latestLocalDate: rows[0]?.messages.localDate,
    latestDeviceId: rows[0]?.messages.senderDeviceId,
  });
  return context.json({
    messages: rows.reverse().map((row) => ({
      ...row.messages,
      image: row.image_objects,
    })),
  });
});

app.post("/api/messages", async (context) => {
  const db = drizzle(context.env.DB, { schema });
  const device = await ensureCurrentDevice(context, db);
  if (device.revokedAt) {
    return context.json({ error: "Device is revoked" }, 403);
  }
  const input = await context.req.json<{ body?: string; timezone?: string }>();
  const body = input.body?.trim();
  if (!body) {
    return context.json({ error: "Message body is required" }, 400);
  }
  if (body.length > 8 * 1024) {
    return context.json({ error: "Message body is too long" }, 400);
  }
  const now = new Date();
  const message = {
    id: nanoid(),
    userId: context.get("user").id,
    senderDeviceId: device.id,
    senderDeviceNameSnapshot: device.displayName,
    kind: "text" as const,
    body,
    localDate: localDate(now, input.timezone),
    expiresAt: new Date(now.getTime() + retentionMs),
    deletedAt: null,
    createdAt: now,
  };
  await db.insert(messages).values(message);
  return context.json({ message });
});

app.post("/api/messages/image", async (context) => {
  const db = drizzle(context.env.DB, { schema });
  const device = await ensureCurrentDevice(context, db);
  if (device.revokedAt) {
    return context.json({ error: "Device is revoked" }, 403);
  }
  const input = await context.req.json<{
    mime?: string;
    name?: string;
    size?: number;
    timezone?: string;
  }>();
  if (!(input.mime && imageTypes.has(input.mime))) {
    return context.json({ error: "Unsupported image type" }, 400);
  }
  if (!(input.size && input.size > 0 && input.size <= maxImageBytes)) {
    return context.json({ error: "Image is larger than 20 MB" }, 400);
  }
  const now = new Date();
  const messageId = nanoid();
  const expiresAt = new Date(now.getTime() + retentionMs);
  const message = {
    id: messageId,
    userId: context.get("user").id,
    senderDeviceId: device.id,
    senderDeviceNameSnapshot: device.displayName,
    kind: "image" as const,
    body: "pending",
    localDate: localDate(now, input.timezone),
    expiresAt,
    deletedAt: null,
    createdAt: now,
  };
  await db.insert(messages).values(message);
  logSync("image_pending_created", {
    messageId,
    deviceId: device.id,
    localDate: message.localDate,
    timezone: input.timezone,
    imageType: input.mime,
    imageSize: input.size,
  });
  return context.json({ message: { ...message, image: null } });
});

app.post("/api/messages/:messageId/image", async (context) => {
  const db = drizzle(context.env.DB, { schema });
  const device = await ensureCurrentDevice(context, db);
  if (device.revokedAt) {
    return context.json({ error: "Device is revoked" }, 403);
  }
  const messageId = context.req.param("messageId");
  const existing = await db
    .select()
    .from(messages)
    .leftJoin(imageObjects, eq(messages.id, imageObjects.messageId))
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.userId, context.get("user").id),
        eq(messages.senderDeviceId, device.id),
        isNull(messages.deletedAt)
      )
    )
    .get();
  if (!(existing?.messages.kind === "image")) {
    return context.json({ error: "Image message not found" }, 404);
  }
  if (existing.image_objects) {
    return context.json({ error: "Image already uploaded" }, 409);
  }
  const form = await context.req.formData();
  const image = form.get("image");
  const thumbnail = form.get("thumbnail");
  if (!(image instanceof File && thumbnail instanceof File)) {
    return context.json(
      { error: "image and thumbnail files are required" },
      400
    );
  }
  if (!(imageTypes.has(image.type) && imageTypes.has(thumbnail.type))) {
    return context.json({ error: "Unsupported image type" }, 400);
  }
  if (image.size > maxImageBytes) {
    return context.json({ error: "Image is larger than 20 MB" }, 400);
  }
  const imageId = nanoid();
  const originalKey = `${context.get("user").id}/${messageId}/original`;
  const thumbnailKey = `${context.get("user").id}/${messageId}/thumbnail`;
  await context.env.IMAGES.put(originalKey, await image.arrayBuffer(), {
    httpMetadata: { contentType: image.type },
  });
  await context.env.IMAGES.put(thumbnailKey, await thumbnail.arrayBuffer(), {
    httpMetadata: { contentType: thumbnail.type },
  });
  await db.insert(imageObjects).values({
    id: imageId,
    messageId,
    originalKey,
    thumbnailKey,
    name: image.name || "image",
    mime: image.type,
    size: image.size,
    width: numberValue(form.get("width")),
    height: numberValue(form.get("height")),
    expiresAt: existing.messages.expiresAt,
    createdAt: new Date(),
  });
  await db
    .update(messages)
    .set({ body: null })
    .where(eq(messages.id, messageId));
  logSync("image_created", {
    messageId,
    imageId,
    deviceId: device.id,
    localDate: existing.messages.localDate,
    imageType: image.type,
    imageSize: image.size,
  });
  return context.json({
    message: {
      ...existing.messages,
      body: null,
      image: {
        id: imageId,
        name: image.name || "image",
        mime: image.type,
        size: image.size,
      },
    },
  });
});

app.get("/api/images/:imageId", async (context) => {
  const db = drizzle(context.env.DB, { schema });
  const size = context.req.query("size") === "original" ? "original" : "thumb";
  const row = await db
    .select()
    .from(imageObjects)
    .innerJoin(messages, eq(imageObjects.messageId, messages.id))
    .where(
      and(
        eq(imageObjects.id, context.req.param("imageId")),
        eq(messages.userId, context.get("user").id),
        isNull(messages.deletedAt)
      )
    )
    .get();
  if (!row) {
    return context.json({ error: "Image not found" }, 404);
  }
  const key =
    size === "original"
      ? row.image_objects.originalKey
      : row.image_objects.thumbnailKey;
  const object = await context.env.IMAGES.get(key);
  if (!object) {
    return context.json({ error: "Image object missing" }, 404);
  }
  return new Response(object.body as unknown as BodyInit, {
    headers: {
      "cache-control": "private, max-age=300",
      "content-type":
        object.httpMetadata?.contentType ?? row.image_objects.mime,
    },
  });
});

app.delete("/api/messages/:messageId", async (context) => {
  const db = drizzle(context.env.DB, { schema });
  await db
    .update(messages)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(messages.id, context.req.param("messageId")),
        eq(messages.userId, context.get("user").id)
      )
    );
  return context.json({ ok: true });
});

function logSync(event: string, data: Record<string, unknown>) {
  console.log(
    JSON.stringify({ level: "info", event: `sync_${event}`, ...data })
  );
}

export default {
  fetch: app.fetch,
  async scheduled(_event: unknown, env: Env) {
    const db = drizzle(env.DB, { schema });
    const expired = await db
      .select()
      .from(imageObjects)
      .where(lt(imageObjects.expiresAt, new Date()))
      .limit(100);
    for (const image of expired) {
      await env.IMAGES.delete(image.originalKey);
      await env.IMAGES.delete(image.thumbnailKey);
    }
    await db.delete(messages).where(lt(messages.expiresAt, new Date()));
  },
};

async function ensureCurrentDevice(
  context: {
    req: { raw: Request; header(name: string): string | undefined };
  } & {
    get(key: "user"): Variables["user"];
  },
  db: ReturnType<typeof drizzle<typeof schema>>
) {
  const user = context.get("user");
  const deviceId = context.req.header("x-quick-send-device-id");
  if (!deviceId || deviceId.length < 12) {
    throw new Response("Missing device id", { status: 400 });
  }
  const deviceIdHash = await sha256(deviceId);
  const previousDeviceId = context.req.header(
    "x-quick-send-previous-device-id"
  );
  const previousDeviceIdHash =
    previousDeviceId &&
    previousDeviceId !== deviceId &&
    previousDeviceId.length >= 12
      ? await sha256(previousDeviceId)
      : undefined;
  const now = new Date();
  const existing = await db
    .select()
    .from(devices)
    .where(
      and(eq(devices.userId, user.id), eq(devices.deviceIdHash, deviceIdHash))
    )
    .get();
  if (existing) {
    await mergePreviousDevice(db, user.id, existing.id, previousDeviceIdHash);
    await db
      .update(devices)
      .set({ lastSeenAt: now })
      .where(eq(devices.id, existing.id));
    return { ...existing, lastSeenAt: now };
  }
  const previous = previousDeviceIdHash
    ? await db
        .select()
        .from(devices)
        .where(
          and(
            eq(devices.userId, user.id),
            eq(devices.deviceIdHash, previousDeviceIdHash)
          )
        )
        .get()
    : undefined;
  if (previous) {
    const kind = inferDeviceKind(context.req.header("user-agent") ?? "");
    await db
      .update(devices)
      .set({ deviceIdHash, kind, lastSeenAt: now })
      .where(eq(devices.id, previous.id));
    return { ...previous, deviceIdHash, kind, lastSeenAt: now };
  }
  const baseName = inferDeviceName(context.req.header("user-agent") ?? "");
  const displayName = await availableDeviceName(db, user.id, baseName);
  const device = {
    id: nanoid(),
    userId: user.id,
    deviceIdHash,
    displayName,
    kind: inferDeviceKind(context.req.header("user-agent") ?? ""),
    createdAt: now,
    lastSeenAt: now,
    revokedAt: null,
  };
  await db.insert(devices).values(device);
  return device;
}

async function mergePreviousDevice(
  db: ReturnType<typeof drizzle<typeof schema>>,
  userId: string,
  currentDeviceId: string,
  previousDeviceIdHash: string | undefined
) {
  if (!previousDeviceIdHash) {
    return;
  }
  const previous = await db
    .select()
    .from(devices)
    .where(
      and(
        eq(devices.userId, userId),
        eq(devices.deviceIdHash, previousDeviceIdHash)
      )
    )
    .get();
  if (!previous || previous.id === currentDeviceId) {
    return;
  }
  await db.transaction(async (transaction) => {
    await transaction
      .update(messages)
      .set({ senderDeviceId: currentDeviceId })
      .where(eq(messages.senderDeviceId, previous.id));
    await transaction.delete(devices).where(eq(devices.id, previous.id));
  });
}

async function availableDeviceName(
  db: ReturnType<typeof drizzle<typeof schema>>,
  userId: string,
  baseName: string
) {
  const rows = await db
    .select({ displayName: devices.displayName })
    .from(devices)
    .where(eq(devices.userId, userId));
  const used = new Set(rows.map((row) => row.displayName.toLowerCase()));
  if (!used.has(baseName.toLowerCase())) {
    return baseName;
  }
  for (let index = 2; index < 100; index += 1) {
    const name = `${baseName} ${index}`;
    if (!used.has(name.toLowerCase())) {
      return name;
    }
  }
  return `${baseName} ${nanoid(4)}`;
}

function normalizeDeviceName(value: string | undefined) {
  const name = value?.trim().replace(/\s+/g, " ");
  return name && name.length >= 2 && name.length <= 32 ? name : undefined;
}

function inferDeviceKind(userAgent: string): DeviceKind {
  if (tabletPattern.test(userAgent)) {
    return "tablet";
  }
  if (mobilePattern.test(userAgent)) {
    return "mobile";
  }
  return "desktop";
}

function inferDeviceName(userAgent: string) {
  if (iphonePattern.test(userAgent)) {
    return "iPhone";
  }
  if (ipadPattern.test(userAgent)) {
    return "iPad";
  }
  if (macPattern.test(userAgent)) {
    return "Mac";
  }
  if (windowsPattern.test(userAgent)) {
    return "Windows";
  }
  if (androidPattern.test(userAgent)) {
    return "Android";
  }
  return "Device";
}

function localDate(date: Date, timezone: string | undefined) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function numberValue(value: FormDataEntryValue | null) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
