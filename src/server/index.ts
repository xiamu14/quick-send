import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { type } from "arktype";
import type { Context } from "hono";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { User } from "@/shared/types";
import { checkpointAndClose, openDatabase } from "./db";
import { AppError, errorPayload } from "./errors";
import {
  absoluteStoragePath,
  cleanupExpiredFileCache,
  isStoredFileAvailable,
  storeUploadedFile,
} from "./files";
import {
  cleanupIdentityState,
  deviceKindFromUserAgent,
  deviceNameFromUserAgent,
  ensureIdentity,
  type IdentityResult,
  resolveCredential,
  updateUserDeviceFromUserAgent,
} from "./identity";
import {
  createFileMessage,
  createTextMessage,
  getFileDownload,
  listMessages,
} from "./messages";
import { acquireProcessLock } from "./process-lock";
import {
  cleanupRoomState,
  createRoom,
  deleteRoom,
  getRoomDetail,
  hasRoomMembership,
  isRoomVisibleToUser,
  limits,
  listDiscoverRooms,
  listRelevantPendingRequests,
  listRoomSummaries,
  requestToJoin,
  resolveJoinRequest,
} from "./rooms";
import { createRealtimeHub } from "./socket";

type Variables = { user: User };
const bearerPattern = /^Bearer (.+)$/i;

const releaseProcessLock = await acquireProcessLock();
const database = openDatabase();
const port = Number(process.env.PORT ?? process.env.QUICK_SEND_PORT ?? 4173);
if (!Number.isFinite(port)) {
  throw new Error("PORT must be a valid TCP port");
}
const hostname = process.env.HOST ?? "127.0.0.1";

const app = new Hono<{ Variables: Variables }>();
const clientRoot = join(process.cwd(), "dist", "client");

app.use(
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      connectSrc: ["'self'", "ws:", "wss:"],
      imgSrc: ["'self'", "data:", "blob:"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
    referrerPolicy: "no-referrer",
    strictTransportSecurity: false,
    xFrameOptions: "DENY",
  })
);

app.use("/api/*", async (context, next) => {
  if (
    !(
      ["GET", "HEAD", "OPTIONS"].includes(context.req.method) ||
      hasMatchingOrigin(context.req.raw)
    )
  ) {
    return context.json(
      { error: { code: "INVALID_ORIGIN", message: "Invalid request origin" } },
      403
    );
  }
  await next();
});

const identityEnsureSchema = type({
  "visitorId?": "string>8",
  "deviceId?": "string>8",
});
const deleteRoomSchema = type({ confirmation: "string" });
const textMessageSchema = type({
  clientMessageId: "string",
  body: "string",
});
const filePrepareSchema = type({
  clientMessageId: "string",
  fileId: "string",
  name: "string",
  size: "number",
  mime: "string",
  "previewDataUrl?": "string",
});

app.post("/api/identity/ensure", async (context) =>
  route(context, async () => {
    const input = await parseJson(context.req.raw, identityEnsureSchema);
    const identityId = input.deviceId ?? input.visitorId;
    if (!identityId) {
      throw new AppError("INVALID_PAYLOAD", "Device identity is required");
    }
    const userAgent = context.req.header("user-agent") ?? "";
    const result: IdentityResult = await ensureIdentity(
      database,
      identityId,
      deviceKindFromUserAgent(userAgent),
      deviceNameFromUserAgent(userAgent),
      input.deviceId ? "device" : "browser"
    );
    return {
      user: result.user,
      credentialToken: result.credentialToken,
    };
  })
);

app.use("/api/*", async (context, next) => {
  const publicIdentityPaths = new Set(["/api/identity/ensure"]);
  if (publicIdentityPaths.has(context.req.path)) {
    await next();
    return;
  }
  const user = await resolveCredential(
    database,
    bearerToken(context.req.header("authorization"))
  );
  if (!user) {
    return context.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
      401
    );
  }
  context.set("user", user);
  await next();
});

app.get("/api/bootstrap", (context) =>
  route(context, () => {
    const user = updateUserDeviceFromUserAgent(
      database,
      context.get("user"),
      context.req.header("user-agent") ?? ""
    );
    return {
      user,
      rooms: listRoomSummaries(database, user.id, realtime.onlineUserIds()),
      pendingRequests: listRelevantPendingRequests(
        database,
        user.id,
        realtime.onlineUserIds()
      ),
      limits,
    };
  })
);

app.get("/api/discover", (context) =>
  route(context, () =>
    listDiscoverRooms(
      database,
      context.get("user").id,
      realtime.onlineUserIds()
    )
  )
);

app.post("/api/rooms", (context) =>
  route(context, () => {
    const user = context.get("user");
    const room = createRoom(database, user);
    realtime.joinUserToRoom(user.id, room.id);
    return room;
  })
);

app.get("/api/rooms/:roomId", (context) =>
  route(context, () => {
    const room = getRoomDetail(
      database,
      context.req.param("roomId"),
      context.get("user").id,
      realtime.onlineUserIds()
    );
    return room ?? { missing: true };
  })
);

app.delete("/api/rooms/:roomId", async (context) =>
  route(context, async () => {
    const input = await parseJson(context.req.raw, deleteRoomSchema);
    const roomId = context.req.param("roomId");
    deleteRoom(database, context.get("user").id, roomId, input.confirmation);
    realtime.deleteRoom(roomId);
    return { ok: true };
  })
);

app.post("/api/rooms/:roomId/requests", (context) =>
  route(context, () => {
    const user = context.get("user");
    const roomId = context.req.param("roomId");
    requireVisibleRoom(roomId, user.id);
    const requestId = requestToJoin(database, roomId, user);
    realtime.notifyJoinRequest(roomId, user.id);
    return { requestId };
  })
);

app.post("/api/requests/:requestId/approve", (context) =>
  route(context, () => {
    const result = resolveJoinRequest(
      database,
      context.req.param("requestId"),
      context.get("user").id,
      "approved"
    );
    realtime.joinUserToRoom(result.requesterId, result.roomId);
    realtime.notifyJoinRequest(result.roomId, result.requesterId);
    return result;
  })
);

app.post("/api/requests/:requestId/reject", (context) =>
  route(context, () => {
    const result = resolveJoinRequest(
      database,
      context.req.param("requestId"),
      context.get("user").id,
      "rejected"
    );
    realtime.notifyJoinRequest(result.roomId, result.requesterId);
    return result;
  })
);

app.get("/api/rooms/:roomId/messages", (context) =>
  route(context, () => {
    const roomId = context.req.param("roomId");
    const userId = context.get("user").id;
    requireVisibleRoom(roomId, userId);
    return listMessages(database, roomId, userId, context.req.query("cursor"));
  })
);

app.post("/api/rooms/:roomId/messages", async (context) =>
  route(context, async () => {
    const input = await parseJson(context.req.raw, textMessageSchema);
    const roomId = context.req.param("roomId");
    requireVisibleRoom(roomId, context.get("user").id);
    const message = createTextMessage(database, context.get("user"), {
      roomId,
      clientMessageId: input.clientMessageId,
      body: input.body,
    });
    realtime.publishMessage(roomId, message);
    return message;
  })
);

app.post("/api/rooms/:roomId/files/prepare", async (context) =>
  route(context, async () => {
    const input = await parseJson(context.req.raw, filePrepareSchema);
    const roomId = context.req.param("roomId");
    requireVisibleRoom(roomId, context.get("user").id);
    if (!hasRoomMembership(database, roomId, context.get("user").id)) {
      throw new AppError("FORBIDDEN", "Room membership is required", 403);
    }
    const available = isStoredFileAvailable(database, input.fileId, input.size);
    if (!available) {
      return { uploadRequired: true as const };
    }
    const message = createFileMessage(database, context.get("user"), {
      roomId,
      ...input,
    });
    if (!message) {
      return { uploadRequired: true as const };
    }
    realtime.publishMessage(roomId, message);
    return { uploadRequired: false as const, message };
  })
);

app.put("/api/rooms/:roomId/files/:fileId", (context) =>
  route(context, () => {
    const expectedSize = Number(context.req.query("size"));
    requireVisibleRoom(context.req.param("roomId"), context.get("user").id);
    return storeUploadedFile(database, context.req.raw, {
      roomId: context.req.param("roomId"),
      userId: context.get("user").id,
      fileId: context.req.param("fileId"),
      expectedSize,
    });
  })
);

app.get("/api/messages/:messageId/file", (context) => {
  try {
    const file = getFileDownload(
      database,
      context.req.param("messageId"),
      context.get("user").id
    );
    if (!file) {
      throw new AppError("FILE_NOT_FOUND", "File is unavailable", 404);
    }
    requireVisibleRoom(file.room_id, context.get("user").id);
    const path = absoluteStoragePath(file.storage_path);
    if (!existsSync(path)) {
      throw new AppError("FILE_NOT_FOUND", "File is unavailable", 410);
    }
    return new Response(
      Readable.toWeb(createReadStream(path)) as unknown as BodyInit,
      {
        headers: {
          "cache-control": "no-store",
          "content-disposition": contentDisposition(file.name),
          "content-length": String(file.size),
          "content-type": file.mime,
          etag: `"${file.file_id}"`,
        },
      }
    );
  } catch (error) {
    const result = errorPayload(error);
    return context.json(result.body, result.status as 400);
  }
});

app.use("/assets/*", serveStatic({ root: clientRoot }));
app.get("/favicon.svg", serveStatic({ path: join(clientRoot, "favicon.svg") }));
app.get("/favicon.ico", (context) => context.redirect("/favicon.svg", 308));
app.get("*", async (context) => {
  const indexPath = existsSync(join(clientRoot, "_shell.html"))
    ? join(clientRoot, "_shell.html")
    : join(clientRoot, "index.html");
  if (!existsSync(indexPath)) {
    return context.text("Run bun run build:web first.", 503);
  }
  return context.body(await readFile(indexPath), 200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
});

const httpServer = serve({ fetch: app.fetch, hostname, port });
const realtime = createRealtimeHub(
  httpServer as unknown as import("node:http").Server,
  database
);

let cleanupRunning = false;
async function runCleanup() {
  if (cleanupRunning) {
    return;
  }
  cleanupRunning = true;
  try {
    realtime.deleteMessages(await cleanupExpiredFileCache(database));
  } finally {
    cleanupRunning = false;
  }
}
void runCleanup().catch(logCleanupError);
const cleanupTimer = setInterval(() => {
  cleanupIdentityState(database);
  cleanupRoomState(database);
  void runCleanup().catch(logCleanupError);
}, 60_000);

function logCleanupError(error: unknown) {
  console.error(
    JSON.stringify({
      level: "error",
      event: "file_cache_cleanup_failed",
      message: error instanceof Error ? error.message : "Unknown error",
    })
  );
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  clearInterval(cleanupTimer);
  await realtime.close();
  await new Promise<void>((resolve) => {
    if (!httpServer.listening) {
      resolve();
      return;
    }
    httpServer.close(() => resolve());
  });
  checkpointAndClose(database);
  releaseProcessLock();
}

function exitAfterShutdown() {
  void shutdown().finally(() => process.exit(0));
}

process.on("SIGINT", exitAfterShutdown);
process.on("SIGTERM", exitAfterShutdown);
console.log(
  JSON.stringify({
    level: "info",
    event: "server_started",
    hostname,
    port,
  })
);

async function route(
  context: Context<{ Variables: Variables }>,
  action: () => unknown | Promise<unknown>
) {
  try {
    return context.json(await action());
  } catch (error) {
    const result = errorPayload(error);
    return context.json(result.body, result.status as 400);
  }
}

async function parseJson<T>(
  request: Request,
  schema: (input: unknown) => T | type.errors
): Promise<T> {
  const result = schema(await request.json().catch(() => undefined));
  if (result instanceof type.errors) {
    throw new AppError("INVALID_PAYLOAD", "Request payload is invalid");
  }
  return result;
}

function bearerToken(value: string | undefined) {
  return value?.match(bearerPattern)?.[1];
}

function requireVisibleRoom(roomId: string, userId: string) {
  if (
    !isRoomVisibleToUser(database, roomId, userId, realtime.onlineUserIds())
  ) {
    throw new AppError("ROOM_NOT_FOUND", "Room is not available", 404);
  }
}

function hasMatchingOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) {
    return false;
  }
  const forwardedHost = request.headers.get("x-forwarded-host");
  const requestHost = forwardedHost ?? request.headers.get("host");
  if (!requestHost) {
    return false;
  }
  try {
    return new URL(origin).host === requestHost.split(",")[0]?.trim();
  } catch {
    return false;
  }
}

function contentDisposition(name: string) {
  return `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
}
