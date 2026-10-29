-- Search, profile and group pictures, blocking, password resets.

-- Pictures are ordinary uploads (media), pointed at from here.
ALTER TABLE users ADD COLUMN avatar_media_id TEXT REFERENCES media(id) ON DELETE SET NULL;
ALTER TABLE chats ADD COLUMN avatar_media_id TEXT REFERENCES media(id) ON DELETE SET NULL;

-- A blocked person cannot sign in; their messages stay where they are.
ALTER TABLE users ADD COLUMN blocked_at INTEGER;

-- One-time links an admin hands to someone who forgot their password. Like
-- session tokens, only the SHA-256 of the code is stored.
CREATE TABLE password_resets (
  code_hash  TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX password_resets_user ON password_resets(user_id);

-- Full-text search over message text, and the names of files sent as files.
-- The trigram tokenizer finds any part of a word in any language ("кот"
-- finds "котик"), ignoring case. It tells "ё" from "е", so both the index
-- and the query write "ё" as "е". Contentless: the text is read from
-- messages, the index only holds what finds it. Kept up to date by triggers,
-- so the code that writes messages does not have to remember.
CREATE VIRTUAL TABLE messages_fts USING fts5(
  text,
  content = '',
  contentless_delete = 1,
  tokenize = 'trigram remove_diacritics 1'
);

CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages WHEN NEW.deleted_at IS NULL BEGIN
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
  WHERE NEW.deleted_at IS NULL;
END;

CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid = OLD.rowid;
END;

-- Everything already written.
INSERT INTO messages_fts (rowid, text)
  SELECT m.rowid, replace(replace(m.body || CASE WHEN m.kind = 'file' THEN ' ' || coalesce(md.name, '') ELSE '' END, 'ё', 'е'), 'Ё', 'Е')
  FROM messages m LEFT JOIN media md ON md.id = m.media_id
  WHERE m.deleted_at IS NULL;

CREATE INDEX messages_created ON messages(created_at);
