# Tapalog Messenger

A self-hosted web messenger whose whole server is one executable file.
Run it from any folder with nothing else installed; the PWA client is built in,
and all state lives in a `messenger-data/` folder next to the binary.

Status: Stage 0 — the skeleton. The binary starts on Windows, Linux and macOS,
creates its data folder and database, and serves an installable app shell that
works offline. Chats come next.

- Stack: Bun + TypeScript, `bun build --compile` for Windows, Linux and macOS
- Storage: SQLite (WAL) via `bun:sqlite`
- Client: Preact PWA with offline queue and Web Push
- Internet access: named Cloudflare Tunnel at a stable address

## Running

```sh
tapalog-messenger [--port 8443] [--data <dir>] [--no-open]
```

On start it opens a status page in the browser. That page and the Stop button
need a random admin key created on each start; the link with the key is printed
to the console and the key is saved in `messenger-data/admin.key`.

## Development

Needs [Bun](https://bun.sh) 1.4+ and Node 22 (for Playwright).

```sh
bun install
bun run build:client      # Vite build + embed map for the server
bun run dev               # build the client, run the server from source
bun run typecheck
bun run test              # server unit tests
bun run e2e               # Playwright: Chromium, Firefox, WebKit
bun run compile:linux-x64 # or linux-arm64, macos-arm64, macos-x64, windows-x64
```

Layout: `server/` (Bun HTTP server, SQLite, migrations), `client/` (Vite + Preact
PWA), `shared/` (types used by both), `e2e/` (Playwright), `scripts/`.
