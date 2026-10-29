import type { Database } from "bun:sqlite";
import { fold, type MessageKind, type SearchHit } from "@tapalog-messenger/shared";

/**
 * Finding messages by any part of a word, in the chats the person is in.
 * The FTS5 trigram index (migration 0004) narrows it down for words of three
 * letters or more; every candidate is then checked here against all the
 * words, short ones included, the same way the index folds them. Newest
 * first, a page at a time.
 */

/** The trigram index needs three characters to look anything up. */
const MIN_INDEXED = 3;
const MAX_WORDS = 8;
/** Rows read per round while short words weed out candidates. */
const BATCH = 200;

/** Where the next page starts: just older than the last hit. */
export interface SearchCursor {
  at: number;
  chat: number;
  seq: number;
}

interface Row {
  rowid: number;
  chat_id: number;
  seq: number;
  sender_id: number | null;
  created_at: number;
  kind: MessageKind;
  body: string;
  file_name: string | null;
}

/** The words of a query, folded; empty when there is nothing to look for. */
export function words(q: string): string[] {
  return [...new Set(fold(q).split(/\s+/).filter(Boolean))].slice(0, MAX_WORDS);
}

const searchable = (r: Row) => fold(r.kind === "file" && r.file_name ? `${r.body} ${r.file_name}` : r.body);

/** A short piece of text around the first word found, on one line. */
function snippet(r: Row, terms: string[]): string {
  const inBody = (() => {
    const text = fold(r.body);
    const at = Math.min(...terms.map((t) => text.indexOf(t)).filter((i) => i >= 0));
    return Number.isFinite(at) ? at : -1;
  })();
  if (inBody < 0) return r.file_name ?? r.body.slice(0, 120);
  const from = Math.max(0, inBody - 40);
  const piece = r.body.slice(from, from + 140).replace(/\s+/g, " ").trim();
  return (from > 0 ? "…" : "") + piece + (from + 140 < r.body.length ? "…" : "");
}

/**
 * Messages of `userId`'s chats (or of one of them) that contain every word
 * of `q`. Without a word of three letters there is no index to use, so that
 * is allowed only inside one chat, where reading it through is cheap.
 */
export function searchMessages(
  db: Database,
  userId: number,
  q: string,
  opts: { chat?: number; before?: SearchCursor; limit: number },
): SearchHit[] | "too_short" {
  const terms = words(q);
  const indexed = terms.filter((t) => [...t].length >= MIN_INDEXED);
  if (terms.length === 0 || (indexed.length === 0 && opts.chat === undefined)) return "too_short";

  const match = indexed.map((t) => `"${t.replaceAll('"', '""')}"`).join(" ");
  const sql = `
    SELECT m.rowid, m.chat_id, m.seq, m.sender_id, m.created_at, m.kind, m.body, md.name AS file_name
    FROM ${indexed.length ? "messages_fts f JOIN messages m ON m.rowid = f.rowid" : "messages m"}
    JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $userId
    LEFT JOIN media md ON md.id = m.media_id
    WHERE ${indexed.length ? "messages_fts MATCH $match" : "m.deleted_at IS NULL"}
      AND ($chat IS NULL OR m.chat_id = $chat)
      AND (m.created_at, m.chat_id, m.seq) < ($at, $c, $s)
    ORDER BY m.created_at DESC, m.chat_id DESC, m.seq DESC
    LIMIT $batch`;
  const query = db.query(sql);

  const hits: SearchHit[] = [];
  let cursor = opts.before ?? { at: Number.MAX_SAFE_INTEGER, chat: 0, seq: 0 };
  for (;;) {
    const rows = query.all({
      userId,
      ...(indexed.length && { match }),
      chat: opts.chat ?? null,
      at: cursor.at,
      c: cursor.chat,
      s: cursor.seq,
      batch: BATCH,
    }) as Row[];
    for (const r of rows) {
      const text = searchable(r);
      if (!terms.every((t) => text.includes(t))) continue;
      hits.push({ chat: r.chat_id, seq: r.seq, from: r.sender_id, at: r.created_at, kind: r.kind, snippet: snippet(r, terms) });
      if (hits.length === opts.limit) return hits;
    }
    if (rows.length < BATCH) return hits;
    const last = rows[rows.length - 1]!;
    cursor = { at: last.created_at, chat: last.chat_id, seq: last.seq };
  }
}
