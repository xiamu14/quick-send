import { createBunWebSocket } from "hono/bun";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import type { ClientEvent } from "../shared/protocol";
import type { BootstrapPayload } from "../shared/types";
import { createSession, getAccessCode, hasSession, requireSession } from "./auth";
import {
  createFileMessage,
  createTextMessage,
  expireOffersForPeer,
  expireOldOffers,
  getFileOffer,
  getMessagesForDay,
  hasMessagesBefore,
  hasActiveTransfer,
  touchPeer,
  updateFileOffer,
  upsertPeer,
} from "./db";
import {
  broadcast,
  getOnlinePeer,
  listOnlinePeers,
  registerPeer,
  removePeer,
  sendTo,
  type PeerSocketData,
} from "./peers";

const { upgradeWebSocket, websocket } = createBunWebSocket<PeerSocketData>();
const app = new Hono();
const code = getAccessCode();
const publicUrl = process.env.PORTLESS_URL ?? "http://quick.local:1355";
const clientRoot = join(process.cwd(), "dist", "client");

app.use(cors({ origin: publicUrl, credentials: true }));
app.use(async (c, next) => {
  await next();
  if (!c.req.path.startsWith("/api/") && c.req.path !== "/ws") {
    c.header("Cache-Control", "no-store");
  }
});

app.post(
  "/api/auth/join",
  zValidator("json", z.object({ code: z.string() })),
  (c) => {
    if (c.req.valid("json").code !== code) {
      return c.json({ error: "Invalid code" }, 401);
    }
    createSession(c);
    return c.json({ ok: true });
  },
);

app.get("/api/session", (c) => c.json({ authenticated: hasSession(c) }));

app.get("/api/bootstrap", requireSession, (c) => {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const historyStart = start - (7 - 1) * 24 * 60 * 60 * 1000;
  const payload: BootstrapPayload = {
    self: {
      id: "",
      nickname: "",
      ip: clientIp(c.req.raw),
      userAgent: c.req.header("user-agent") ?? "",
      online: true,
      lastSeenAt: Date.now(),
    },
    peers: listOnlinePeers(),
    messages: getMessagesForDay(start, start + 24 * 60 * 60 * 1000),
    hasEarlierMessages: hasMessagesBefore(start, historyStart),
    publicUrl,
    accessCode: process.env.NODE_ENV === "production" ? undefined : code,
  };
  return c.json(payload);
});

app.get(
  "/api/messages/day/:date",
  requireSession,
  zValidator("param", z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })),
  (c) => {
    const date = c.req.valid("param").date;
    const start = new Date(`${date}T00:00:00`).getTime();
    const historyStart = start - (7 - 1) * 24 * 60 * 60 * 1000;
    return c.json({
      messages: getMessagesForDay(start, start + 24 * 60 * 60 * 1000),
      hasEarlierMessages: hasMessagesBefore(start, historyStart),
    });
  },
);

app.get(
  "/ws",
  upgradeWebSocket((c) => {
    if (!hasSession(c)) {
      return {
        onOpen: (_event, ws) => ws.close(1008, "Unauthorized"),
      };
    }
    const ip = clientIp(c.req.raw);
    return {
      onMessage(event, ws) {
        handleWsMessage(String(event.data), ws.raw as unknown as ServerWebSocket<PeerSocketData>, ip, c.req.header("user-agent") ?? "");
      },
      onClose(_event, ws) {
        const peerId = (ws.raw as unknown as PeerSocketData | undefined)?.peerId;
        if (!peerId) return;
        removePeer(peerId);
        for (const offer of expireOffersForPeer(peerId)) {
          broadcast({ type: "file-offer:updated", offer });
        }
        broadcast({ type: "peer:list", peers: listOnlinePeers() });
      },
    };
  }),
);

app.get("/assets/*", serveStatic({ root: clientRoot }));
app.get("/favicon.ico", serveStatic({ path: join(clientRoot, "favicon.ico") }));
app.get("*", async (c) => {
  const indexPath = existsSync(join(clientRoot, "_shell.html"))
    ? join(clientRoot, "_shell.html")
    : join(clientRoot, "index.html");
  const file = Bun.file(indexPath);
  if (await file.exists()) {
    return new Response(file, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  return c.html(createSpaShell());
});

function createSpaShell() {
  const assetsRoot = join(clientRoot, "assets");
  const assets = existsSync(assetsRoot) ? readdirSync(assetsRoot) : [];
  const css = assets.find((asset) => asset.endsWith(".css"));
  const js = assets.find((asset) => asset.endsWith(".js"));
  if (!js) {
    return "Run bun run build:web first.";
  }
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Cache-Control" content="no-store" />
    <title>Quick Send</title>
    ${css ? `<link rel="stylesheet" href="/assets/${css}" />` : ""}
    <script type="module" src="/assets/${js}"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;
}

setInterval(() => {
  for (const offer of expireOldOffers()) {
    broadcast({ type: "file-offer:updated", offer });
  }
}, 30_000);

function handleWsMessage(raw: string, ws: ServerWebSocket<PeerSocketData>, ip: string, userAgent: string) {
  let event: ClientEvent;
  try {
    event = JSON.parse(raw) as ClientEvent;
  } catch {
    ws.send(JSON.stringify({ type: "error", message: "Bad message" }));
    return;
  }

  if (event.type === "peer:hello") {
    const peer = upsertPeer({ id: event.deviceId, ip, userAgent: event.userAgent || userAgent });
    registerPeer(peer, ws);
    ws.send(JSON.stringify({ type: "peer:self", peer }));
    broadcast({ type: "peer:list", peers: listOnlinePeers() });
    return;
  }

  const peerId = ws.data.peerId;
  const peer = peerId ? getOnlinePeer(peerId) : undefined;
  if (!peer) {
    ws.send(JSON.stringify({ type: "error", message: "Join first" }));
    return;
  }
  touchPeer(peer.id);

  switch (event.type) {
    case "message:text:create": {
      const body = event.body.trim();
      if (!body) return;
      const message = createTextMessage({ senderPeerId: peer.id, senderIp: peer.ip, body });
      broadcast({ type: "message:created", message, tempId: event.tempId });
      return;
    }
    case "message:file:create": {
      const { message } = createFileMessage({
        senderPeerId: peer.id,
        senderIp: peer.ip,
        name: event.file.name,
        size: event.file.size,
        mime: event.file.mime,
        previewDataUrl: event.file.previewDataUrl,
      });
      broadcast({ type: "message:created", message, tempId: event.tempId });
      return;
    }
    case "transfer:receive": {
      const offer = getFileOffer(event.offerId);
      if (!offer || offer.status !== "available" || offer.expiresAt < Date.now()) {
        ws.send(JSON.stringify({ type: "transfer:busy", offerId: event.offerId }));
        return;
      }
      if (hasActiveTransfer(peer.id) || hasActiveTransfer(offer.senderPeerId)) {
        ws.send(JSON.stringify({ type: "transfer:busy", offerId: event.offerId }));
        return;
      }
      const sender = getOnlinePeer(offer.senderPeerId);
      if (!sender) {
        const next = updateFileOffer(offer.id, { status: "sender_offline" });
        if (next) broadcast({ type: "file-offer:updated", offer: next });
        return;
      }
      const next = updateFileOffer(offer.id, { status: "transferring", receiverPeerId: peer.id });
      if (!next) return;
      broadcast({ type: "file-offer:updated", offer: next });
      sendTo(sender.id, {
        type: "transfer:locked",
        offer: next,
        senderPeerId: sender.id,
        receiverPeerId: peer.id,
      });
      sendTo(peer.id, {
        type: "transfer:locked",
        offer: next,
        senderPeerId: sender.id,
        receiverPeerId: peer.id,
      });
      return;
    }
    case "transfer:complete": {
      const offer = updateFileOffer(event.offerId, { status: "done" });
      if (offer) broadcast({ type: "file-offer:updated", offer });
      return;
    }
    case "transfer:fail": {
      const offer = updateFileOffer(event.offerId, { status: "failed" });
      if (offer) broadcast({ type: "file-offer:updated", offer });
      return;
    }
    case "rtc:offer":
    case "rtc:answer":
    case "rtc:candidate":
      sendTo(event.toPeerId, { ...event, fromPeerId: peer.id });
      return;
  }
}

function clientIp(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return normalizeIp(forwarded || "local");
}

function normalizeIp(ip: string) {
  return ip.startsWith("::ffff:") ? ip.slice("::ffff:".length) : ip;
}

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

console.log(`Quick Send`);
console.log(`URL:  ${publicUrl}`);
console.log(`Code: ${code}`);

Bun.serve({
  port,
  hostname: host,
  fetch: app.fetch,
  websocket,
});
