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

### On a VPS

Without Cloudflare: a Linux server with its own IP address, [Caddy](https://caddyserver.com)
in front for HTTPS, and the messenger as a systemd service. Shown for Ubuntu
24.04 and the address `messenger.example.com`.

1. **DNS.** An `A` record for `messenger.example.com` with the server's IPv4
   address. If the zone is on Cloudflare, set it to *DNS only* (grey cloud).
2. **Firewall.** Open only SSH and the web:

   ```sh
   sudo ufw limit 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp && sudo ufw enable
   ```

3. **Caddy**, from [its own repository](https://caddyserver.com/docs/install#debian-ubuntu-raspbian)
   (Ubuntu's package is old). `/etc/caddy/Caddyfile`:

   ```
   messenger.example.com {
   	@admin path /status /status.json /shutdown /admin/*
   	respond @admin 404
   	reverse_proxy 127.0.0.1:8443
   }
   ```

   Then `sudo systemctl reload caddy`. Caddy gets and renews the certificate
   by itself.
4. **The service.** Copy `tapalog-messenger-linux-x64` to the server and run:

   ```sh
   chmod +x tapalog-messenger-linux-x64
   sudo ./tapalog-messenger-linux-x64 service install --public-url https://messenger.example.com
   ```

   This puts the binary in `/usr/local/bin`, creates the user `tapalog`, keeps
   the data in `/var/lib/tapalog-messenger/messenger-data` (backups beside it,
   in `messenger-backups`), and starts the service with `--behind-proxy`. It
   starts by itself after a reboot and again after a crash; **Restart server**
   on the status page restarts it. The link for the
   first account is in the log: `journalctl -u tapalog-messenger -n 50`.

5. **A relay for calls (coturn)**, optional. Calls go directly between
   phones when they can; when a network does not allow that, they go through
   a TURN relay. coturn and the messenger share a secret, and the messenger
   gives each signed-in person a password for it that lasts 6 hours.

   ```sh
   sudo apt install coturn
   sudo sh -c 'umask 077; openssl rand -hex 32 > /etc/tapalog-turn-secret'
   ```

   `/etc/turnserver.conf`:

   ```
   listening-port=3478
   min-port=49160
   max-port=49200
   use-auth-secret
   realm=messenger.example.com
   fingerprint
   no-cli
   no-tls
   no-dtls
   no-multicast-peers
   denied-peer-ip=10.0.0.0-10.255.255.255
   denied-peer-ip=172.16.0.0-172.31.255.255
   denied-peer-ip=192.168.0.0-192.168.255.255
   ```

   Then add the secret to it, so coturn and the messenger hold the same one:

   ```sh
   echo "static-auth-secret=$(sudo cat /etc/tapalog-turn-secret)" | sudo tee -a /etc/turnserver.conf >/dev/null
   sudo chown root:turnserver /etc/turnserver.conf && sudo chmod 640 /etc/turnserver.conf
   ```

   ```sh
   sudo ufw allow 3478 && sudo ufw allow 49160:49200/udp
   sudo systemctl restart coturn
   sudo tapalog-messenger service install --public-url https://messenger.example.com \
     --turn-url turn:messenger.example.com:3478 --turn-url "turn:messenger.example.com:3478?transport=tcp" \
     --turn-secret-file /etc/tapalog-turn-secret
   ```

   Settings → Calls → **Check the connection for calls** then shows whether
   the relay can be reached from the network a phone is on, by UDP or TCP.

6. **The relay over TLS**, optional: for networks that let through only
   encrypted connections. coturn uses Caddy's certificate for the same name.
   `/usr/local/sbin/tapalog-turn-cert` (then `sudo chmod 700` it) copies it
   and restarts coturn when it has changed:

   ```sh
   #!/bin/sh
   set -eu
   name=messenger.example.com
   src=$(ls -td /var/lib/caddy/.local/share/caddy/certificates/*/"$name" 2>/dev/null | head -n 1)
   [ -n "$src" ] || { echo "Caddy has no certificate for $name" >&2; exit 1; }
   install -d -m 750 -g turnserver /etc/coturn/tls
   if ! cmp -s "$src/$name.crt" /etc/coturn/tls/cert.pem; then
     install -m 640 -g turnserver "$src/$name.crt" /etc/coturn/tls/cert.pem
     install -m 640 -g turnserver "$src/$name.key" /etc/coturn/tls/key.pem
     systemctl restart coturn
     echo "coturn now uses the certificate from $src"
   fi
   ```

   In `/etc/turnserver.conf`, replace `no-tls` with:

   ```
   tls-listening-port=5349
   cert=/etc/coturn/tls/cert.pem
   pkey=/etc/coturn/tls/key.pem
   no-tlsv1
   no-tlsv1_1
   ```

   Caddy renews the certificate about a month before it runs out, so a daily
   timer is enough. `/etc/systemd/system/tapalog-turn-cert.service`:

   ```
   [Unit]
   Description=Caddy's certificate for coturn

   [Service]
   Type=oneshot
   ExecStart=/usr/local/sbin/tapalog-turn-cert
   ```

   `/etc/systemd/system/tapalog-turn-cert.timer`:

   ```
   [Unit]
   Description=Daily check of the certificate for coturn

   [Timer]
   OnCalendar=*-*-* 04:30:00
   Persistent=true

   [Install]
   WantedBy=timers.target
   ```

   ```sh
   sudo systemctl daemon-reload && sudo systemctl start tapalog-turn-cert && sudo systemctl enable --now tapalog-turn-cert.timer
   sudo systemctl restart coturn && sudo ufw allow 5349/tcp
   sudo tapalog-messenger service install --public-url https://messenger.example.com \
     --turn-url turn:messenger.example.com:3478 --turn-url "turn:messenger.example.com:3478?transport=tcp" \
     --turn-url "turns:messenger.example.com:5349?transport=tcp" --turn-secret-file /etc/tapalog-turn-secret
   ```

   The connection check then offers TLS too.

`--behind-proxy` takes each person's address from Caddy's `X-Forwarded-For`
(only on connections from the server itself), so the sign-in limits count per
person and not for everyone at once. It also refuses the status page and the
admin controls to anything that came through Caddy.

**The status page** is reached through SSH only. From your own computer:

```sh
ssh -L 8443:127.0.0.1:8443 you@your-server
```

then open `http://localhost:8443/status?key=…`, with the key from
`sudo cat /var/lib/tapalog-messenger/messenger-data/admin.key`.

**Updating:** copy the new binary to the server, then

```sh
sudo tapalog-messenger service update ./tapalog-messenger-linux-x64
```

It makes a backup, keeps the running binary as `tapalog-messenger.prev`,
starts the new one and waits for it to answer. If it does not, the previous
binary is put back. Going back to an older binary does not undo a database
change the new version made; then restore the backup made just before (see
Backups).

`sudo tapalog-messenger service uninstall` removes the service and the binary;
the data stays in `/var/lib/tapalog-messenger`.

**Moving from another computer:** stop the old server, copy its
`messenger-data` folder to `/var/lib/tapalog-messenger/messenger-data` (with
the service stopped: `sudo systemctl stop tapalog-messenger`), run
`service install` again so the files get the right owner, and point the DNS
record at the new server. Sign-ins, installed apps and notifications carry
over, because the address stays the same.

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

### Copies off the server

Backups lie on the same disk as the data, so a lost server takes them along.
On a VPS, [restic](https://restic.net) can send each night's backup,
encrypted on the server, to S3-compatible storage. Shown for Cloudflare R2
(10 GB free) and the service from "On a VPS".

1. **Storage.** In the Cloudflare dashboard: R2 → **Create bucket**
   (`messenger-backups`), then **Manage API Tokens** → **Create Account API
   token** with *Object Read & Write*, for that bucket only. Keep the Access
   Key ID, the Secret Access Key and the S3 endpoint in a password manager.
2. **Keys on the server**, readable by root only:

   ```sh
   sudo apt install restic
   sudo install -d -m 700 /etc/restic && sudo install -m 600 /dev/null /etc/restic/tapalog.env && sudo nano /etc/restic/tapalog.env
   ```

   ```
   AWS_ACCESS_KEY_ID=<Access Key ID>
   AWS_SECRET_ACCESS_KEY=<Secret Access Key>
   AWS_DEFAULT_REGION=auto
   RESTIC_REPOSITORY=s3:https://<account id>.r2.cloudflarestorage.com/messenger-backups
   RESTIC_PASSWORD_FILE=/etc/restic/tapalog.pass
   ```

3. **The password** everything is encrypted with. Put it in the password
   manager too: without it the copies cannot be read, by anyone.

   ```sh
   sudo sh -c 'umask 077; openssl rand -base64 32 > /etc/restic/tapalog.pass' && sudo cat /etc/restic/tapalog.pass
   sudo bash -c 'set -a; . /etc/restic/tapalog.env; restic init'
   ```

4. **Every night.** `/usr/local/sbin/tapalog-offsite-backup` (then
   `sudo chmod 700` it) makes a fresh backup and sends it. It keeps 7 daily, 4
   weekly and 6 monthly copies; they are grouped by tag, because every
   backup folder has a different name:

   ```sh
   #!/bin/sh
   set -eu
   set -a; . /etc/restic/tapalog.env; set +a
   out=$(runuser -u tapalog -- /usr/local/bin/tapalog-messenger backup --data /var/lib/tapalog-messenger/messenger-data)
   echo "$out"
   dir=$(printf '%s\n' "$out" | sed -n 's/^Backup made: \(.*\) ([0-9]* files).*/\1/p')
   [ -d "$dir" ] || { echo "No backup folder in: $out" >&2; exit 1; }
   restic backup --tag tapalog --host tapalog-vps "$dir"
   restic forget --tag tapalog --group-by host,tags --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
   ```

   `/etc/systemd/system/tapalog-offsite-backup.service`:

   ```
   [Unit]
   Description=Tapalog Messenger backup to R2
   After=network-online.target tapalog-messenger.service
   Wants=network-online.target

   [Service]
   Type=oneshot
   ExecStart=/usr/local/sbin/tapalog-offsite-backup
   CacheDirectory=restic
   Environment=RESTIC_CACHE_DIR=/var/cache/restic
   Nice=10
   IOSchedulingClass=idle
   ```

   `/etc/systemd/system/tapalog-offsite-backup.timer` (a server that was off
   at 03:30 catches up when it starts):

   ```
   [Unit]
   Description=Nightly Tapalog Messenger backup to R2

   [Timer]
   OnCalendar=*-*-* 03:30:00
   RandomizedDelaySec=15m
   Persistent=true

   [Install]
   WantedBy=timers.target
   ```

   ```sh
   sudo systemctl daemon-reload && sudo systemctl enable --now tapalog-offsite-backup.timer
   sudo systemctl start tapalog-offsite-backup && sudo journalctl -u tapalog-offsite-backup -n 30 --no-pager
   ```

**Getting a copy back**, on any computer with restic: set the four variables
from `tapalog.env` (`export NAME=value`, or `$env:NAME = "value"` in
PowerShell) without `RESTIC_PASSWORD_FILE`, so restic asks for the password,
then

```sh
restic snapshots
restic restore latest --target ./restored
```

The backup folder is inside `restored`, under its path on the server
(`var/lib/tapalog-messenger/messenger-backups/…`). Restore it as above, or
run the messenger on it to look first:
`tapalog-messenger --data <that folder> --port 9555 --no-tunnel --no-open`.

## Development

Needs [Bun](https://bun.sh) 1.4.0 (the version CI and releases are built with) and Node 22 (for Playwright).

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
