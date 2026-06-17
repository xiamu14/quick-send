# Quick Send

Quick Send is a room chat and direct file-transfer app hosted from one local
computer. Text messages and file metadata are stored in local SQLite. File
bytes move directly between browsers over WebRTC DataChannel.

## Requirements

- Bun 1.3+
- Portless LAN mode serving `http://quick.local:1355`
- Devices on the same local network

## Setup

Install dependencies:

```bash
bun install
```

## Development

Start the Bun API server and Vite dev server with hot reload:

```bash
bun run dev
```

Open the Vite URL printed in the terminal. Development mode does not start
Portless.

## LAN Access

Build and run Quick Send:

```bash
bun run start
```

The start script builds the web app, starts the local Bun server on the
internal port `4173`, then prints the fixed LAN URL:

```text
http://quick.local:1355
```

The terminal also displays a compact QR code for the LAN URL, so mobile
devices can open Quick Send by scanning it.

Override the internal app port with `QUICK_SEND_PORT` only if your Portless LAN
route points somewhere else. Override the printed LAN URL with
`QUICK_SEND_LAN_URL` if needed.

Portless LAN mode keeps the browser origin stable at `quick.local:1355`, so
localStorage credentials keep working across restarts.

Credentials are stored in browser localStorage and sent as Bearer tokens for
API requests and Socket.IO authentication. Quick Send does not use cookies.

## Commands

```bash
bun run check
bun test
bun run typecheck
bun run build
```

Lefthook runs all four checks before every commit. GitHub Actions runs the same
gate for pushes and pull requests.

## Data

SQLite data is stored in `data/quick-send.sqlite`. Stop the service before
copying a backup. The database uses WAL; copying only the main database file
while the service is running is not a safe backup.

See [docs/plan.md](docs/plan.md) for the complete product and protocol contract.
