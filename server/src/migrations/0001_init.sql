-- Per-installation facts. More tables arrive with Stage 1 (users, chats, messages).
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

INSERT INTO meta (key, value) VALUES
  ('instance_id', lower(hex(randomblob(16)))),
  ('created_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
