# Quick Send

Quick Send is a room chat and direct file-transfer app hosted from one local
computer. Text messages and file metadata are stored in local SQLite. File
bytes move directly between browsers over WebRTC DataChannel.

## Requirements

- Bun 1.3+
- Internet access for the hostc tunnel
- Devices on the same local network for direct file transfer

## Setup

Install dependencies:

```bash
bun install
```

Generate the identity encryption key:

```bash
bun run keygen
```

Create `.env.local`:

```env
IDENTITY_ENCRYPTION_KEY=<generated Base64 key>
```

Keep this key with database backups. Existing authenticator identities cannot
be verified if it is lost.

## Public HTTPS tunnel

Run Quick Send:

```bash
bun run dev
```

The dev script starts the local Bun server on port `4173`, then hostc prints a
temporary public HTTPS URL such as:

```text
https://t-a1b2c3d4.hostc.dev
```

The terminal also displays a compact QR code for the public URL, so mobile
devices can open Quick Send by scanning it.

Override the local port with `QUICK_SEND_PORT`.

hostc anonymous tunnels are temporary. Restarting or reconnecting may produce
a different URL. Browser storage is isolated by origin, so a new hostc URL
cannot read the credential stored by the old URL. Use the MFA recovery flow to
restore the same user on the new URL.

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
copying a backup, and back up `.env.local` separately. The database uses WAL;
copying only the main database file while the service is running is not a safe
backup.

See [docs/plan.md](docs/plan.md) for the complete product and protocol contract.
