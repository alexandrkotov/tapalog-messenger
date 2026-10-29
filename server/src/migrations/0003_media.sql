-- Photos, files and voice messages; Web Push subscriptions.

-- One row per upload. The bytes live in media/ under their SHA-256, so the
-- same file uploaded twice is stored once; name and type live here. The id
-- is random, not a counter, so ids cannot be guessed.
CREATE TABLE media (
  id           TEXT    PRIMARY KEY,
  owner_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sha256       TEXT    NOT NULL,
  mime         TEXT    NOT NULL,
  size         INTEGER NOT NULL,
  name         TEXT    NOT NULL,
  width        INTEGER,
  height       INTEGER,
  duration_ms  INTEGER,
  -- Voice: loudness levels 0–100, comma-separated, for the bar under the play button.
  waveform     TEXT,
  -- Photos: a small preview the client made, stored the same way.
  thumb_sha256 TEXT,
  thumb_mime   TEXT,
  created_at   INTEGER NOT NULL
) STRICT;
CREATE INDEX media_sha256 ON media(sha256);
CREATE INDEX media_thumb_sha256 ON media(thumb_sha256);

-- SQLite cannot change a CHECK constraint, so messages is rebuilt with the
-- new kinds and a media column. db.ts runs migrations with foreign keys off,
-- so dropping the old table does not cascade into reactions.
CREATE TABLE messages_new (
  chat_id      INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  client_id    TEXT    NOT NULL,
  sender_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind         TEXT    NOT NULL CHECK (kind IN ('text', 'image', 'file', 'voice')),
  body         TEXT    NOT NULL,
  media_id     TEXT    REFERENCES media(id) ON DELETE SET NULL,
  reply_to_seq INTEGER,
  created_at   INTEGER NOT NULL,
  edited_at    INTEGER,
  deleted_at   INTEGER,
  version      INTEGER NOT NULL,
  PRIMARY KEY (chat_id, seq),
  UNIQUE (chat_id, client_id)
) STRICT;
INSERT INTO messages_new (chat_id, seq, client_id, sender_id, kind, body, reply_to_seq, created_at, edited_at, deleted_at, version)
  SELECT chat_id, seq, client_id, sender_id, kind, body, reply_to_seq, created_at, edited_at, deleted_at, version FROM messages;
DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;
CREATE INDEX messages_version ON messages(chat_id, version);
CREATE INDEX messages_media ON messages(media_id) WHERE media_id IS NOT NULL;

-- One row per browser that allowed notifications. Signing the device out
-- removes it. lang is the interface language, for the notification's words.
CREATE TABLE push_subscriptions (
  endpoint   TEXT    PRIMARY KEY,
  device_id  INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  p256dh     TEXT    NOT NULL,
  auth       TEXT    NOT NULL,
  lang       TEXT    NOT NULL DEFAULT 'en',
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX push_subscriptions_device ON push_subscriptions(device_id);
