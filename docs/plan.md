# Quick Send MVP Plan

## Scope

Quick Send is a LAN-only web file transfer assistant. One machine runs the server, other devices open the web UI from the same local network.

- Entry URL: `http://quick.local:1355`
- Runtime: Bun + Hono + TanStack Router SPA + SQLite
- UI: HeroUI, single chat window
- Transport: WebSocket for control, WebRTC DataChannel for file bytes
- Storage: text history, file metadata, image thumbnail only
- Non-goal: public internet access, server file relay, large file optimization, PWA

## Runtime

Use portless for LAN routing:

```bash
portless proxy start --lan --no-tls -p 1355
portless quick bun run dev:app
```

The app listens on `process.env.PORT`. It must not bind to `1355` directly.

The web client is built as a plain SPA. This avoids a prerendered shell dependency during LAN development.

## Identity

Each browser creates a persistent `deviceId` in localStorage. The server stores:

- `deviceId`
- IP
- nickname
- user agent
- last seen time

UI shows a friendly English noun nickname, not technical IDs.

## Chat

There is one shared chatbox.

- Current device messages align right
- Other device messages align left
- Text messages are persisted in SQLite
- File messages persist metadata only
- Image messages persist a small thumbnail preview

History loads today by default. `Load earlier` prepends messages from earlier dates, up to the latest 7 days. Empty dates are skipped. There is no infinite scroll.

## Files

File content never reaches the server.

Flow:

1. Sender chooses a file
2. Client sends file metadata to server
3. Server broadcasts the file offer
4. Receiver clicks Receive
5. Server locks the offer
6. Sender and receiver exchange WebRTC signaling over WebSocket
7. Sender streams chunks over DataChannel
8. Receiver assembles a Blob and downloads it

Limits:

- Sender page must stay open
- One active transfer per sender
- One active transfer per receiver
- No relay fallback
- No background transfer
- No folder transfer
- No drag and drop or paste upload in MVP

File offers expire after 30 minutes, or immediately when the sender leaves. Cross-day file records show as expired.

## Auth

MVP uses a lightweight access code.

- `ACCESS_CODE` can be set by env
- Otherwise server generates one and stores it in SQLite config
- Login creates an httpOnly session cookie
- Session TTL: 7 days
- REST and WebSocket require auth

## UI

Keep the UI quiet and direct.

Primary surfaces:

- Top bar: app name, current nickname, online peers, QR
- Timeline: virtualized chat items
- Composer: image button, file button, text input, send button
- Access code screen

Short status labels:

- Ready
- Sending
- Sent
- Receive
- Cancel
- Retry
- Expired
- Sender left
- Busy

## Implementation Phases

1. Project setup and build scripts
2. SQLite schema and bootstrap API
3. Auth and session
4. WebSocket peer registry and message broadcast
5. Chat UI and history loading
6. File offer UI
7. WebRTC transfer
8. QR code and portless URL polish
