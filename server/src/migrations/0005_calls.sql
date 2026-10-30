-- Calls: their records in the chat, as a new kind of message. The body of a
-- call's record is JSON ({"outcome","video","duration"}), written by the server.

-- SQLite cannot change a CHECK constraint, so messages is rebuilt again, as in
-- 0003. The rowid is copied too: the search index (0004) points at messages by
-- rowid. Dropping the table drops its triggers, so they are made again below,
-- now leaving call records out of search.
CREATE TABLE messages_new (
  chat_id      INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  client_id    TEXT    NOT NULL,
  sender_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind         TEXT    NOT NULL CHECK (kind IN ('text', 'image', 'file', 'voice', 'call')),
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
INSERT INTO messages_new (rowid, chat_id, seq, client_id, sender_id, kind, body, media_id, reply_to_seq, created_at, edited_at, deleted_at, version)
  SELECT rowid, chat_id, seq, client_id, sender_id, kind, body, media_id, reply_to_seq, created_at, edited_at, deleted_at, version FROM messages;
DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;
CREATE INDEX messages_version ON messages(chat_id, version);
CREATE INDEX messages_media ON messages(media_id) WHERE media_id IS NOT NULL;
CREATE INDEX messages_created ON messages(created_at);

CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages WHEN NEW.deleted_at IS NULL AND NEW.kind != 'call' BEGIN
  INSERT INTO messages_fts (rowid, text) VALUES (
    NEW.rowid,
    replace(replace(NEW.body || CASE WHEN NEW.kind = 'file' THEN ' ' || coalesce((SELECT name FROM media WHERE id = NEW.media_id), '') ELSE '' END, 'ё', 'е'), 'Ё', 'Е')
  );
END;

CREATE TRIGGER messages_fts_update AFTER UPDATE OF body, deleted_at, media_id ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = OLD.rowid;
  INSERT INTO messages_fts (rowid, text) SELECT
    NEW.rowid,
    replace(replace(NEW.body || CASE WHEN NEW.kind = 'file' THEN ' ' || coalesce((SELECT name FROM media WHERE id = NEW.media_id), '') ELSE '' END, 'ё', 'е'), 'Ё', 'Е')
  WHERE NEW.deleted_at IS NULL AND NEW.kind != 'call';
END;

CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = OLD.rowid;
END;
