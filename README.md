# Tapalog Messenger

A self-hosted web messenger whose whole server is one executable file.
Run it from any folder with nothing else installed; the PWA client is built in,
and all state lives in a `messenger-data/` folder next to the binary.

Status: Stage 3 — search, profiles, administration, backups, releases.
Sign-up by invite link, direct chats and groups, replies, edits, deletes,
reactions, sent / delivered / read ticks, typing and online status, several
devices per account, catch-up after a lost connection. Photos, files (up to
50 MB) and voice messages; recent chats and an outbox that work without a
network; push notifications while the app is closed (on iPhone and iPad only
from the Home Screen app). Search by any part of a word across all chats or in
one; profile and group photos; a light or dark theme. Administrators block
people, make password-reset links and see the disk space used. Backups every
day and on demand.

- Stack: Bun + TypeScript, `bun build --compile` for Windows, Linux and macOS
- Storage: SQLite (WAL) via `bun:sqlite`
- Client: Preact PWA, one WebSocket per tab
- Internet access: named Cloudflare Tunnel at a stable address; cloudflared is
  built into the executable (pinned version, SHA-256 checked at build time)

**Privacy:** messages are not end-to-end encrypted yet. Whoever runs the server
can read them in its database.

## Download

Every version is on the [Releases](https://github.com/alexandrkotov/tapalog-messenger/releases)
page, with `SHA256SUMS`:

| Computer | File |
| --- | --- |
| Windows | `tapalog-messenger-windows-x64.exe` |
| Mac, Apple Silicon (M1 and later) | `tapalog-messenger-macos-arm64.zip` |
| Mac, Intel | `tapalog-messenger-macos-x64.zip` |
| Linux | `tapalog-messenger-linux-x64`, `tapalog-messenger-linux-arm64` |
| Debian, Ubuntu, Chromebook (Linux) | `tapalog-messenger_<version>_amd64.deb`, `_arm64.deb` |

The files are not code-signed:

- **Windows** warns on the first start ("Windows protected your PC"). Click
  **More info**, then **Run anyway**.
- **macOS** 13 (Ventura) or later. Unzip, then in Terminal, in that folder:
  `xattr -d com.apple.quarantine tapalog-messenger-macos-*` and start it.
- **Linux**: `chmod +x tapalog-messenger-linux-*` once. The `.deb` adds
  "Tapalog Messenger" to the apps menu and keeps its data in
  `~/.tapalog-messenger`.

A release is made by pushing a tag: `git tag v0.3.0 && git push --tags`. The
version in the tag goes into the binaries.

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
first one, which becomes the admin. Administrators manage the server in
Settings → Server: invite links, blocking and unblocking people, admin rights,
one-time password-reset links (valid 24 hours), and the disk space used. The
status page can make invite links too.

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

## Backups

A backup is a folder in `messenger-backups/`, next to `messenger-data/`, named
by date and time (`2026-10-28_19-00`). It holds a consistent copy of the
database (taken while the server runs), the uploaded files, `vapid.json` and
`config.json`. Uploaded files never change, so they are hard links rather
than copies where the disk allows, and seven backups take little more room
than one. `admin.key` is not copied; a new one is made on every start.

- One is made an hour after start and then every 24 hours; the newest 7 are
  kept.
- **Back up now** on the status page makes one at once.
- `tapalog-messenger backup [--data <dir>]` makes one from the command line,
  also while the server runs.

A backup holds every message and the tunnel token: keep it as private as
`messenger-data/` itself.

To restore:

1. Stop the server (Stop server on the status page).
2. Rename `messenger-data` to something else, e.g. `messenger-data-old`.
3. Copy the backup folder next to the program and rename the copy to
   `messenger-data`.
4. Start the server.

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
