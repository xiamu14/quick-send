# Quick Send Product and Technical Plan

## Product

Quick Send is a LAN-only room chat and file-transfer web app. One device
runs the Bun service. Other devices on the same LAN open
`http://quick.local:1355` through Portless LAN mode.

- UI: React 19, TanStack Router, HeroUI, Tailwind CSS v4, Jotai
- API: Hono REST + Socket.IO over WebSocket only
- Storage: SQLite and a local file cache on the service device
- File bytes: uploaded and downloaded through same-origin HTTP
- Text and file metadata: stored as plaintext in SQLite
- Language: English, light theme, mobile-first with a two-column desktop layout

## Identity

Visiting Quick Send creates or restores a local user automatically. The browser
loads FingerprintJS, sends the visitor identifier to the service, and receives
a Bearer credential. The user-facing name is a random short ID, 4 to 6
characters long.

The service stores only a SHA-256 hash of the FingerprintJS visitor identifier.
Credential tokens are stored as SHA-256 hashes and expire after 90 days without
activity. Quick Send does not use cookies.

## Rooms

- A user can own at most 5 rooms.
- A room can have at most 10 members including its creator.
- Room names are chosen randomly from 20 built-in English nouns.
- A creator's active rooms do not reuse the same name.
- Different creators may have rooms with the same name.
- Rooms are discoverable by default.
- A room is visible to other devices only while its creator is online.
- Creator disconnects use a 30-second grace period before the room is hidden.
- Hidden rooms retain membership, requests and messages, then reappear when the
  creator reconnects.
- The creator can permanently delete a room after typing its name.
- Member removal, leaving, ownership transfer, renaming, hiding and archive are
  outside MVP scope.

The home page lists every room the user owns or has joined, ordered by latest
message time or creation time. It shows the last message summary, activity time,
online member count, owner marker and pending request count for owned rooms.
There is no unread model.

## Join Requests

Discover returns every active room the user can request to join. Joined,
pending and full rooms are omitted. Creator online status is shown.

- At most 5 pending requests per user.
- One pending request per user and room.
- Requests expire after 7 days.
- Rejected requests may be submitted again after 60 seconds.
- Requests persist while the creator is offline.
- The creator can approve or reject from home or room info.
- Pending users cannot enter chat or read history.
- Approved users can read the complete room history.

## Messages

- Text limit: 8 KB UTF-8.
- File limit: 200 MB.
- Image preview limit: 200 KB, longest edge 640 px.
- Text messages persist until the room is deleted. File messages expire after
  three days.
- No message deletion, edit, read receipt, typing state, search, pin or forward.
- History uses an opaque `(createdAt, id)` cursor, 50 messages per request.
- Earlier history loads only when the user presses `Load earlier`.
- `clientMessageId` makes message creation idempotent per user.

## File Transfer

The browser calculates an incremental lowercase MD5 before upload. MD5 is the
global `fileId`, so identical bytes referenced by different devices or rooms
share one physical file. The service also verifies SHA-256, size and MD5 while
streaming the upload to disk.

- File bytes and their message records expire after three days.
- Cleanup runs at startup and once per minute.
- A physical file is deleted only after its final message reference expires.
- Room members can download an unexpired file without the sender being online.
- Upload and download progress are shown in the chat UI.

## SQLite

The database enables WAL and foreign keys. Versioned TypeScript migrations run
inside transactions. Migration 1 removes the old single-room schema.

Tables:

- `schema_migrations`
- `users`
- `credentials`
- `rooms`
- `room_members`
- `join_requests`
- `messages`
- `server_files`
- `message_files`
- `audit_logs`

Room-owned rows use foreign keys with `ON DELETE CASCADE`. Audit rows retain a
room name snapshot and set `room_id` to null after deletion.

## REST

- `POST /api/identity/ensure`
- `GET /api/bootstrap`
- `GET /api/discover`
- `POST /api/rooms`
- `GET /api/rooms/:roomId`
- `DELETE /api/rooms/:roomId`
- `POST /api/rooms/:roomId/requests`
- `POST /api/requests/:requestId/approve`
- `POST /api/requests/:requestId/reject`
- `GET /api/rooms/:roomId/messages`
- `POST /api/rooms/:roomId/messages`
- `POST /api/rooms/:roomId/files/prepare`
- `PUT /api/rooms/:roomId/files/:fileId`
- `GET /api/messages/:messageId/file`

Errors use `{ "error": { "code": string, "message": string } }`. Request and
response boundaries use ArkType. Mutations are not retried automatically.

## Socket.IO

Socket.IO uses only the default namespace and WebSocket transport. The Bearer
credential and Origin are validated during connection.

Server rooms:

- `user:{userId}`
- `room:{roomId}`

Core client events:

- `message:create`

Core server events:

- `room:summary`
- `room:deleted`
- `join-request:changed`
- `message:created`
- `message:deleted`

Socket.IO handles heartbeat, timeout and reconnect. On reconnect the client
reloads bootstrap and the current room rather than relying on missed events.
Every event is authorized against SQLite membership; Socket.IO rooms are only a
delivery optimization.

## Security and Operations

- Portless LAN HTTP serves the fixed `quick.local:1355` origin.
- Origin validation applies to REST mutations and Socket.IO.
- Hono secure headers use a same-origin CSP.
- Logs never include credentials, visitor identifiers, message text, filenames
  or full user agents.
- A process lock prevents two service instances from sharing one database.
- SIGINT and SIGTERM close Socket.IO, checkpoint WAL, close SQLite and release
  the process lock.

## UI

The chat view follows the supplied reference: blue outgoing bubbles, white
incoming bubbles, device-colored sender icons, a compact header and bottom
composer. The second reference supplies the pale blue background, rounded cards
and blue primary actions.

HeroUI provides UI primitives. Tailwind CSS v4 utilities provide layout and
styling; no custom CSS classes or custom primitive library. Lucide supplies
icons. Sonner supplies global Toast. Motion supplies 120-180 ms interaction and
mobile navigation animation while respecting reduced motion.

Desktop uses a room list sidebar and chat content. Mobile navigates between the
room list and chat. Message rendering remains virtualized with `react-window`.

## Quality Gates

Every commit and CI run must pass:

```bash
bun run check
bun test
bun run typecheck
bun run build
```

Lefthook runs the complete gate before commit. Tests use `bun:test` and
temporary SQLite files. Browser E2E is outside scope.
