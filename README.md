# Tapalog Messenger

A self-hosted web messenger whose whole server is one executable file.
Run it from any folder with nothing else installed; the PWA client is built in,
and all state lives in a `messenger-data/` folder next to the binary.

Status: Stage 2 — media and PWA. Sign-up by invite link, direct chats and
groups, replies, edits, deletes, reactions, sent / delivered / read ticks,
typing and online status, several devices per account, catch-up after a lost
connection. Photos, files (up to 50 MB) and voice messages; recent chats and an
outbox that work without a network; push notifications while the app is closed
(on iPhone and iPad only from the Home Screen app). Profile pictures and search
come next.

- Stack: Bun + TypeScript, `bun build --compile` for Windows, Linux and macOS
- Storage: SQLite (WAL) via `bun:sqlite`
- Client: Preact PWA, one WebSocket per tab
- Internet access: named Cloudflare Tunnel at a stable address; cloudflared is
  built into the executable (pinned version, SHA-256 checked at build time)

**Privacy:** messages are not end-to-end encrypted yet. Whoever runs the server
can read them in its database.

## Running

```sh
tapalog-messenger [--port 8443] [--data <dir>] [--no-open]
```

On start it opens a status page in the browser. That page and the Stop button
need a random admin key created on each start; the link with the key is printed
to the console and the key is saved in `messenger-data/admin.key`.

Uploads are kept in `messenger-data/media/`. The keys that sign push
notifications are made on first start and kept in `messenger-data/vapid.json`;
losing them only means everyone turns notifications on again.

While there are no accounts yet, the status page shows a link for creating the
first one, which becomes the admin. The admin makes invite links for everyone
else in Settings; the status page can make them too.

### From the internet

Create a tunnel in the Cloudflare dashboard (Zero Trust → Networks → Tunnels),
give it a public hostname that points to `http://localhost:8443`, and copy its
token. Then, once:

```sh
tapalog-messenger --tunnel-token <token> --public-url https://messenger.example.com
```

Both are saved in `messenger-data/config.json` (readable by its owner only), so
later starts need no flags. `--no-tunnel` skips the tunnel for one run,
`--forget-tunnel` deletes the token. `--quick-tunnel` gives a temporary
`*.trycloudflare.com` address for a demo; it changes on every start, so
installed apps and sign-ins do not survive a restart.

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
