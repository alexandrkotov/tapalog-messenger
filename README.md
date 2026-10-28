# Tapalog Messenger

A WhatsApp-style web messenger whose whole server is one executable file.
Run it from any folder with nothing else installed; the PWA client is built in,
and all state lives in a `messenger-data/` folder next to the binary.

Status: planning.

- Stack: Bun + TypeScript, `bun build --compile` for Windows, Linux and macOS
- Storage: SQLite (WAL) via `bun:sqlite`
- Client: PWA with offline queue and Web Push
- Internet access: named Cloudflare Tunnel at a stable address
