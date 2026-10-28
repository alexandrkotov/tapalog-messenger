-- Accounts, chats and messages. Times are Unix milliseconds.

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
) STRICT;

-- One row per signed-in browser. Only the SHA-256 of the session token is stored.
CREATE TABLE devices (
  id                 INTEGER PRIMARY KEY,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name               TEXT    NOT NULL,
  session_token_hash TEXT    NOT NULL UNIQUE,
  created_at         INTEGER NOT NULL,
  last_active_at     INTEGER NOT NULL
) STRICT;
CREATE INDEX devices_user ON devices(user_id);

-- created_by is NULL for invites made by the host (first admin, --invite, status page).
CREATE TABLE invites (
  code         TEXT    PRIMARY KEY,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  grants_admin INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  max_uses     INTEGER NOT NULL DEFAULT 1,
  used_count   INTEGER NOT NULL DEFAULT 0
) STRICT;

-- last_seq numbers messages; version counts every change in the chat (new
-- message, edit, delete, reaction) so a reconnecting client can ask for
-- everything that changed, not only what is new.
-- direct_key ("<smaller user id>:<larger user id>") keeps one direct chat per pair.
CREATE TABLE chats (
  id         INTEGER PRIMARY KEY,
  kind       TEXT    NOT NULL CHECK (kind IN ('direct', 'group')),
  title      TEXT,
  direct_key TEXT    UNIQUE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  last_seq   INTEGER NOT NULL DEFAULT 0,
  version    INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE chat_members (
  chat_id       INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT    NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  joined_at     INTEGER NOT NULL,
  delivered_seq INTEGER NOT NULL DEFAULT 0,
  read_seq      INTEGER NOT NULL DEFAULT 0,
  muted_until   INTEGER,
  PRIMARY KEY (chat_id, user_id)
) STRICT;
CREATE INDEX chat_members_user ON chat_members(user_id);

-- UNIQUE(chat_id, client_id) makes a resend after a lost ack harmless.
CREATE TABLE messages (
  chat_id      INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  client_id    TEXT    NOT NULL,
  sender_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind         TEXT    NOT NULL CHECK (kind IN ('text')),
  body         TEXT    NOT NULL,
  reply_to_seq INTEGER,
  created_at   INTEGER NOT NULL,
  edited_at    INTEGER,
  deleted_at   INTEGER,
  version      INTEGER NOT NULL,
  PRIMARY KEY (chat_id, seq),
  UNIQUE (chat_id, client_id)
) STRICT;
CREATE INDEX messages_version ON messages(chat_id, version);

-- One reaction per person per message.
CREATE TABLE reactions (
  chat_id INTEGER NOT NULL,
  seq     INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji   TEXT    NOT NULL,
  PRIMARY KEY (chat_id, seq, user_id),
  FOREIGN KEY (chat_id, seq) REFERENCES messages(chat_id, seq) ON DELETE CASCADE
) STRICT;
