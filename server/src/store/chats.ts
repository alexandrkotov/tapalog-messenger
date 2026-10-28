import type { Database } from "bun:sqlite";
import { INLINE_IMAGE_TYPES, LIMITS, type ChatDto, type MemberDto, type MessageDto, type MessageKind } from "@tapalog-messenger/shared";
import { getMedia, mediaDto, type MediaRow } from "./media";

/**
 * Chats, members, messages and reactions. Every change to a chat's messages
 * bumps `chats.version` and stamps the message with it, so a reconnecting
 * client gets new messages and edits alike by asking for version > N.
 */

/** Who is online right now; the hub knows, the database does not. */
export type IsOnline = (userId: number) => boolean;

interface MessageRow {
  chat_id: number;
  seq: number;
  client_id: string;
  sender_id: number | null;
  kind: MessageKind;
  body: string;
  media_id: string | null;
  reply_to_seq: number | null;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  version: number;
}

interface ChatRow {
  id: number;
  kind: "direct" | "group";
  title: string | null;
  last_seq: number;
  version: number;
}

export type Role = "admin" | "member";

/** Why a change was refused. */
export type Refusal = "not_found" | "forbidden" | "chat_full" | "bad_request";

function withReactions(db: Database, rows: MessageRow[]): MessageDto[] {
  if (rows.length === 0) return [];
  const chatId = rows[0]!.chat_id;
  const seqs = rows.map((r) => r.seq);
  const reactions = db
    .query(
      `SELECT seq, user_id, emoji FROM reactions WHERE chat_id = $chatId AND seq BETWEEN $min AND $max ORDER BY rowid`,
    )
    .all({ chatId, min: Math.min(...seqs), max: Math.max(...seqs) }) as { seq: number; user_id: number; emoji: string }[];
  const bySeq = new Map<number, Record<string, number[]>>();
  for (const r of reactions) {
    const map = bySeq.get(r.seq) ?? {};
    (map[r.emoji] ??= []).push(r.user_id);
    bySeq.set(r.seq, map);
  }
  const mediaIds = [...new Set(rows.map((r) => r.media_id).filter((id): id is string => id !== null))];
  const media = new Map<string, MediaRow>();
  if (mediaIds.length) {
    const found = db.query(`SELECT * FROM media WHERE id IN (${mediaIds.map(() => "?").join(",")})`).all(...mediaIds) as MediaRow[];
    for (const m of found) media.set(m.id, m);
  }
  return rows.map((r) => ({
    chat: r.chat_id,
    seq: r.seq,
    client_id: r.client_id,
    from: r.sender_id,
    kind: r.kind,
    body: r.deleted_at === null ? r.body : "",
    media: r.deleted_at === null && r.media_id !== null && media.has(r.media_id) ? mediaDto(media.get(r.media_id)!) : null,
    reply_to: r.reply_to_seq,
    at: r.created_at,
    edited_at: r.edited_at,
    deleted: r.deleted_at !== null,
    version: r.version,
    reactions: bySeq.get(r.seq) ?? {},
  }));
}

function getMessage(db: Database, chatId: number, seq: number): MessageDto | null {
  const row = db.query("SELECT * FROM messages WHERE chat_id = $chatId AND seq = $seq").get({ chatId, seq }) as MessageRow | null;
  return row ? withReactions(db, [row])[0]! : null;
}

function bumpVersion(db: Database, chatId: number): number {
  return (db.query("UPDATE chats SET version = version + 1 WHERE id = $chatId RETURNING version").get({ chatId }) as { version: number }).version;
}

// ---- Membership -----------------------------------------------------------

export function memberRole(db: Database, chatId: number, userId: number): Role | null {
  const row = db.query("SELECT role FROM chat_members WHERE chat_id = $chatId AND user_id = $userId").get({ chatId, userId }) as { role: Role } | null;
  return row?.role ?? null;
}

export function memberIds(db: Database, chatId: number): number[] {
  return (db.query("SELECT user_id FROM chat_members WHERE chat_id = $chatId").all({ chatId }) as { user_id: number }[]).map((r) => r.user_id);
}

/** Everyone who shares at least one chat with this user: the people who see their presence. */
export function contactIds(db: Database, userId: number): number[] {
  return (
    db
      .query(
        `SELECT DISTINCT b.user_id FROM chat_members a JOIN chat_members b ON a.chat_id = b.chat_id
         WHERE a.user_id = $userId AND b.user_id != $userId`,
      )
      .all({ userId }) as { user_id: number }[]
  ).map((r) => r.user_id);
}

function chatDto(db: Database, chat: ChatRow, forUserId: number, isOnline: IsOnline): ChatDto {
  const members = db
    .query(
      `SELECT u.id, u.username, u.display_name, u.last_seen_at, m.role, m.delivered_seq, m.read_seq
       FROM chat_members m JOIN users u ON u.id = m.user_id WHERE m.chat_id = $chatId ORDER BY m.role = 'admin' DESC, m.joined_at, u.id`,
    )
    .all({ chatId: chat.id }) as (Omit<MemberDto, "online">)[];
  const me = members.find((m) => m.id === forUserId);
  const lastRow = db
    .query("SELECT * FROM messages WHERE chat_id = $chatId ORDER BY seq DESC LIMIT 1")
    .get({ chatId: chat.id }) as MessageRow | null;
  const unread = (
    db
      .query(
        `SELECT count(*) AS n FROM messages
         WHERE chat_id = $chatId AND seq > $readSeq AND deleted_at IS NULL AND (sender_id IS NULL OR sender_id != $userId)`,
      )
      .get({ chatId: chat.id, readSeq: me?.read_seq ?? 0, userId: forUserId }) as { n: number }
  ).n;
  return {
    id: chat.id,
    kind: chat.kind,
    title: chat.title,
    members: members.map((m) => ({ ...m, online: isOnline(m.id) })),
    last_seq: chat.last_seq,
    version: chat.version,
    last_message: lastRow ? withReactions(db, [lastRow])[0]! : null,
    unread,
  };
}

/** The chat as `forUserId` sees it, or null if they are not in it. */
export function getChat(db: Database, chatId: number, forUserId: number, isOnline: IsOnline): ChatDto | null {
  if (!memberRole(db, chatId, forUserId)) return null;
  const chat = db.query("SELECT id, kind, title, last_seq, version FROM chats WHERE id = $chatId").get({ chatId }) as ChatRow | null;
  return chat ? chatDto(db, chat, forUserId, isOnline) : null;
}

/** All of a user's chats, most recently active first. */
export function chatsOfUser(db: Database, userId: number, isOnline: IsOnline): ChatDto[] {
  const chats = db
    .query(
      `SELECT c.id, c.kind, c.title, c.last_seq, c.version FROM chats c JOIN chat_members m ON m.chat_id = c.id
       WHERE m.user_id = $userId
       ORDER BY coalesce((SELECT max(created_at) FROM messages WHERE chat_id = c.id), c.created_at) DESC, c.id DESC`,
    )
    .all({ userId }) as ChatRow[];
  return chats.map((c) => chatDto(db, c, userId, isOnline));
}

/** The one direct chat between two people, created on first use. */
export function findOrCreateDirect(db: Database, a: number, b: number, now: number): { chatId: number; created: boolean } {
  const key = a < b ? `${a}:${b}` : `${b}:${a}`;
  return db.transaction(() => {
    const existing = db.query("SELECT id FROM chats WHERE direct_key = $key").get({ key }) as { id: number } | null;
    if (existing) return { chatId: existing.id, created: false };
    const { id } = db
      .query("INSERT INTO chats (kind, direct_key, created_by, created_at) VALUES ('direct', $key, $a, $now) RETURNING id")
      .get({ key, a, now }) as { id: number };
    const add = db.query("INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES ($id, $user, 'member', $now)");
    add.run({ id, user: a, now });
    if (b !== a) add.run({ id, user: b, now });
    return { chatId: id, created: true };
  })();
}

/** A new group; the creator is its first admin. */
export function createGroup(db: Database, creator: number, title: string, members: number[], now: number): number | Refusal {
  const others = [...new Set(members)].filter((id) => id !== creator);
  if (others.length + 1 > LIMITS.groupMembers) return "chat_full";
  return db.transaction(() => {
    const { id } = db
      .query("INSERT INTO chats (kind, title, created_by, created_at) VALUES ('group', $title, $creator, $now) RETURNING id")
      .get({ title, creator, now }) as { id: number };
    db.query("INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES ($id, $creator, 'admin', $now)").run({ id, creator, now });
    const add = db.query("INSERT INTO chat_members (chat_id, user_id, role, joined_at) SELECT $id, id, 'member', $now FROM users WHERE id = $user");
    for (const user of others) add.run({ id, user, now });
    return id;
  })();
}

function isGroup(db: Database, chatId: number): boolean {
  return (db.query("SELECT kind FROM chats WHERE id = $chatId").get({ chatId }) as { kind: string } | null)?.kind === "group";
}

/** Group admins add people. */
export function addMember(db: Database, chatId: number, actor: number, userId: number, now: number): true | Refusal {
  if (!isGroup(db, chatId)) return "not_found";
  if (memberRole(db, chatId, actor) !== "admin") return "forbidden";
  return db.transaction(() => {
    if (memberIds(db, chatId).length >= LIMITS.groupMembers) return "chat_full" as const;
    const added = db
      .query("INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, joined_at) SELECT $chatId, id, 'member', $now FROM users WHERE id = $userId")
      .run({ chatId, userId, now });
    return added.changes > 0 || memberRole(db, chatId, userId) ? (true as const) : ("not_found" as const);
  })();
}

/**
 * Group admins remove people; anyone can leave. A group never loses its last
 * admin: the longest-standing member takes over. An empty group is deleted.
 */
export function removeMember(db: Database, chatId: number, actor: number, userId: number): true | Refusal {
  if (!isGroup(db, chatId)) return "not_found";
  const actorRole = memberRole(db, chatId, actor);
  if (!actorRole) return "not_found";
  if (actor !== userId && actorRole !== "admin") return "forbidden";
  return db.transaction(() => {
    if (db.query("DELETE FROM chat_members WHERE chat_id = $chatId AND user_id = $userId").run({ chatId, userId }).changes === 0) {
      return "not_found" as const;
    }
    const left = db.query("SELECT count(*) AS n, sum(role = 'admin') AS admins FROM chat_members WHERE chat_id = $chatId").get({ chatId }) as {
      n: number;
      admins: number | null;
    };
    if (left.n === 0) db.query("DELETE FROM chats WHERE id = $chatId").run({ chatId });
    else if (!left.admins) {
      db.query(
        `UPDATE chat_members SET role = 'admin' WHERE chat_id = $chatId AND user_id =
         (SELECT user_id FROM chat_members WHERE chat_id = $chatId ORDER BY joined_at, user_id LIMIT 1)`,
      ).run({ chatId });
    }
    return true as const;
  })();
}

export function setRole(db: Database, chatId: number, actor: number, userId: number, role: Role): true | Refusal {
  if (!isGroup(db, chatId)) return "not_found";
  if (memberRole(db, chatId, actor) !== "admin") return "forbidden";
  if (actor === userId && role === "member") {
    const admins = (db.query("SELECT count(*) AS n FROM chat_members WHERE chat_id = $chatId AND role = 'admin'").get({ chatId }) as { n: number }).n;
    if (admins <= 1) return "bad_request";
  }
  const changed = db.query("UPDATE chat_members SET role = $role WHERE chat_id = $chatId AND user_id = $userId").run({ chatId, userId, role }).changes;
  return changed > 0 ? true : "not_found";
}

export function renameGroup(db: Database, chatId: number, actor: number, title: string): true | Refusal {
  if (!isGroup(db, chatId)) return "not_found";
  if (memberRole(db, chatId, actor) !== "admin") return "forbidden";
  db.query("UPDATE chats SET title = $title WHERE id = $chatId").run({ chatId, title });
  return true;
}

// ---- Messages -------------------------------------------------------------

/** Whether an upload can travel as this kind of message: only the uploader sends it, and a photo or voice message must really be one. */
function mediaFits(media: MediaRow | null, kind: MessageKind, sender: number): boolean {
  if (kind === "text") return media === null;
  if (!media || media.owner_id !== sender) return false;
  if (kind === "image") return (INLINE_IMAGE_TYPES as readonly string[]).includes(media.mime);
  if (kind === "voice") return media.mime.startsWith("audio/");
  return true;
}

/**
 * Writes a message with the chat's next seq. A resend with a client_id this
 * chat already has returns the stored message and `duplicate: true` instead.
 */
export function sendMessage(
  db: Database,
  m: { chatId: number; sender: number; clientId: string; kind?: MessageKind; body: string; mediaId?: string; replyTo?: number; now: number },
): { msg: MessageDto; duplicate: boolean } | Refusal {
  const kind = m.kind ?? "text";
  return db.transaction(() => {
    if (!memberRole(db, m.chatId, m.sender)) return "forbidden" as const;
    const existing = db
      .query("SELECT seq, sender_id FROM messages WHERE chat_id = $chatId AND client_id = $clientId")
      .get({ chatId: m.chatId, clientId: m.clientId }) as { seq: number; sender_id: number } | null;
    if (existing) {
      if (existing.sender_id !== m.sender) return "bad_request" as const;
      return { msg: getMessage(db, m.chatId, existing.seq)!, duplicate: true };
    }
    if (m.replyTo !== undefined) {
      const { last_seq } = db.query("SELECT last_seq FROM chats WHERE id = $chatId").get({ chatId: m.chatId }) as { last_seq: number };
      if (m.replyTo > last_seq) return "bad_request" as const;
    }
    if (!mediaFits(m.mediaId === undefined ? null : getMedia(db, m.mediaId), kind, m.sender)) return "bad_request" as const;
    const { last_seq: seq, version } = db
      .query("UPDATE chats SET last_seq = last_seq + 1, version = version + 1 WHERE id = $chatId RETURNING last_seq, version")
      .get({ chatId: m.chatId }) as { last_seq: number; version: number };
    db.query(
      `INSERT INTO messages (chat_id, seq, client_id, sender_id, kind, body, media_id, reply_to_seq, created_at, version)
       VALUES ($chatId, $seq, $clientId, $sender, $kind, $body, $mediaId, $replyTo, $now, $version)`,
    ).run({ chatId: m.chatId, seq, clientId: m.clientId, sender: m.sender, kind, body: m.body, mediaId: m.mediaId ?? null, replyTo: m.replyTo ?? null, now: m.now, version });
    // The sender has obviously read and received everything up to their own message.
    db.query("UPDATE chat_members SET delivered_seq = $seq, read_seq = $seq WHERE chat_id = $chatId AND user_id = $sender").run({
      chatId: m.chatId,
      seq,
      sender: m.sender,
    });
    return { msg: getMessage(db, m.chatId, seq)!, duplicate: false };
  })();
}

export function editMessage(db: Database, chatId: number, seq: number, userId: number, body: string, now: number): MessageDto | Refusal {
  return db.transaction(() => {
    if (!memberRole(db, chatId, userId)) return "forbidden" as const;
    const row = db.query("SELECT sender_id, deleted_at FROM messages WHERE chat_id = $chatId AND seq = $seq").get({ chatId, seq }) as {
      sender_id: number;
      deleted_at: number | null;
    } | null;
    if (!row || row.deleted_at !== null) return "not_found" as const;
    if (row.sender_id !== userId) return "forbidden" as const;
    const version = bumpVersion(db, chatId);
    db.query("UPDATE messages SET body = $body, edited_at = $now, version = $version WHERE chat_id = $chatId AND seq = $seq").run({
      chatId,
      seq,
      body,
      now,
      version,
    });
    return getMessage(db, chatId, seq)!;
  })();
}

/**
 * Delete for everyone: the sender, or a group admin. The text is wiped and
 * the file let go (it is deleted from disk once nothing else uses it); the
 * slot stays.
 */
export function deleteMessage(db: Database, chatId: number, seq: number, userId: number, now: number): MessageDto | Refusal {
  return db.transaction(() => {
    const role = memberRole(db, chatId, userId);
    if (!role) return "forbidden" as const;
    const row = db.query("SELECT sender_id, deleted_at FROM messages WHERE chat_id = $chatId AND seq = $seq").get({ chatId, seq }) as {
      sender_id: number;
      deleted_at: number | null;
    } | null;
    if (!row || row.deleted_at !== null) return "not_found" as const;
    if (row.sender_id !== userId && !(role === "admin" && isGroup(db, chatId))) return "forbidden" as const;
    const version = bumpVersion(db, chatId);
    db.query("UPDATE messages SET body = '', media_id = NULL, deleted_at = $now, version = $version WHERE chat_id = $chatId AND seq = $seq").run({
      chatId,
      seq,
      now,
      version,
    });
    db.query("DELETE FROM reactions WHERE chat_id = $chatId AND seq = $seq").run({ chatId, seq });
    return getMessage(db, chatId, seq)!;
  })();
}

/** Sets this user's reaction; an empty emoji removes it. */
export function setReaction(db: Database, chatId: number, seq: number, userId: number, emoji: string): MessageDto | Refusal {
  return db.transaction(() => {
    if (!memberRole(db, chatId, userId)) return "forbidden" as const;
    const row = db.query("SELECT deleted_at FROM messages WHERE chat_id = $chatId AND seq = $seq").get({ chatId, seq }) as {
      deleted_at: number | null;
    } | null;
    if (!row || row.deleted_at !== null) return "not_found" as const;
    if (emoji === "") db.query("DELETE FROM reactions WHERE chat_id = $chatId AND seq = $seq AND user_id = $userId").run({ chatId, seq, userId });
    else {
      db.query(
        `INSERT INTO reactions (chat_id, seq, user_id, emoji) VALUES ($chatId, $seq, $userId, $emoji)
         ON CONFLICT (chat_id, seq, user_id) DO UPDATE SET emoji = excluded.emoji`,
      ).run({ chatId, seq, userId, emoji });
    }
    const version = bumpVersion(db, chatId);
    db.query("UPDATE messages SET version = $version WHERE chat_id = $chatId AND seq = $seq").run({ chatId, seq, version });
    return getMessage(db, chatId, seq)!;
  })();
}

/** A page of history, oldest first: the `limit` messages before `beforeSeq` (or the latest). */
export function history(db: Database, chatId: number, beforeSeq: number | null, limit: number): MessageDto[] {
  const rows = db
    .query("SELECT * FROM messages WHERE chat_id = $chatId AND seq < $before ORDER BY seq DESC LIMIT $limit")
    .all({ chatId, before: beforeSeq ?? Number.MAX_SAFE_INTEGER, limit }) as MessageRow[];
  return withReactions(db, rows.reverse());
}

/** Messages added or changed after `version`, oldest change first. `more` means there were over `limit`. */
export function changedSince(db: Database, chatId: number, version: number, limit: number): { messages: MessageDto[]; more: boolean } {
  const rows = db
    .query("SELECT * FROM messages WHERE chat_id = $chatId AND version > $version ORDER BY version LIMIT $limit")
    .all({ chatId, version, limit: limit + 1 }) as MessageRow[];
  const more = rows.length > limit;
  return { messages: withReactions(db, more ? rows.slice(0, limit) : rows), more };
}

/**
 * Moves this member's delivered / read marks forward (never back, never past
 * the last message; read implies delivered). Null when nothing changed.
 */
export function markReceipt(
  db: Database,
  chatId: number,
  userId: number,
  marks: { delivered?: number; read?: number },
): { delivered: number; read: number } | null {
  const before = db
    .query(
      `SELECT m.delivered_seq, m.read_seq, c.last_seq FROM chat_members m JOIN chats c ON c.id = m.chat_id
       WHERE m.chat_id = $chatId AND m.user_id = $userId`,
    )
    .get({ chatId, userId }) as { delivered_seq: number; read_seq: number; last_seq: number } | null;
  if (!before) return null;
  const read = Math.min(Math.max(before.read_seq, marks.read ?? 0), before.last_seq);
  const delivered = Math.min(Math.max(before.delivered_seq, marks.delivered ?? 0, read), before.last_seq);
  if (read === before.read_seq && delivered === before.delivered_seq) return null;
  db.query("UPDATE chat_members SET delivered_seq = $delivered, read_seq = $read WHERE chat_id = $chatId AND user_id = $userId").run({
    chatId,
    userId,
    delivered,
    read,
  });
  return { delivered, read };
}
