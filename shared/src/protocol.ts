/**
 * Everything the client and server say to each other: REST bodies and
 * WebSocket frames. Frames are JSON objects with a type in `t`. The server
 * checks every incoming frame with `parseClientFrame`; tests use the same
 * checks on what the server sends.
 */

export const LIMITS = {
  /** Characters in one message. */
  body: 10_000,
  /** Bytes in one WebSocket frame. */
  frameBytes: 64 * 1024,
  displayName: 64,
  deviceName: 64,
  groupTitle: 100,
  groupMembers: 256,
  passwordMin: 8,
  passwordMax: 256,
  /** Characters in a reaction (an emoji can be several code points). */
  emoji: 16,
  /** Messages per page of history. */
  pageMax: 100,
  /** Bytes in one uploaded file. Cloudflare's free plan passes request bodies up to 100 MB. */
  fileBytes: 50 * 1024 * 1024,
  /** Bytes in a photo preview made by the client. */
  thumbBytes: 256 * 1024,
  /** Bytes one person may upload per hour: the server is someone's home computer. */
  uploadBytesPerHour: 200 * 1024 * 1024,
  fileName: 255,
  /** Points in a voice message's loudness bar. */
  waveformPoints: 100,
  /** Longest voice message, ms. */
  voiceMs: 15 * 60 * 1000,
} as const;

/** Types a browser may show in place. Anything else is served as a download, so an uploaded page or SVG never runs on our address. */
export const INLINE_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

export type MessageKind = "text" | "image" | "file" | "voice";

export const USERNAME_RE = /^[a-z0-9_.]{3,32}$/;

// ---- Data -----------------------------------------------------------------

export interface UserDto {
  id: number;
  username: string;
  display_name: string;
}

export interface MemberDto extends UserDto {
  role: "admin" | "member";
  delivered_seq: number;
  read_seq: number;
  online: boolean;
  last_seen_at: number | null;
}

/** An uploaded file as messages carry it. */
export interface MediaDto {
  id: string;
  mime: string;
  size: number;
  name: string;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  /** Voice: loudness levels 0–100. */
  waveform: number[] | null;
  /** Whether GET /media/{id}/thumb has a small preview. */
  thumb: boolean;
}

/** One message found by GET /api/search, newest first. */
export interface SearchHit {
  chat: number;
  seq: number;
  from: number | null;
  at: number;
  kind: MessageKind;
  /** Text around the first word found (or the file's name), on one line. */
  snippet: string;
}

export interface MessageDto {
  chat: number;
  seq: number;
  client_id: string;
  /** null when the sender's account was deleted. */
  from: number | null;
  kind: MessageKind;
  /** The text, or a photo's caption (may be empty). Empty once deleted. */
  body: string;
  /** The photo, file or voice recording; null for text and once deleted. */
  media: MediaDto | null;
  reply_to: number | null;
  at: number;
  edited_at: number | null;
  deleted: boolean;
  /** The chat version at this message's last change; see ChatDto.version. */
  version: number;
  /** emoji → user ids */
  reactions: Record<string, number[]>;
}

export interface ChatDto {
  id: number;
  kind: "direct" | "group";
  /** Group title; null for a direct chat (the client shows the other person). */
  title: string | null;
  members: MemberDto[];
  last_seq: number;
  /** Grows with every change in the chat: new message, edit, delete, reaction. */
  version: number;
  last_message: MessageDto | null;
  unread: number;
  /** Notifications for this chat are off, for the person asking. */
  muted: boolean;
}

export interface MeDto {
  user: UserDto & { is_admin: boolean };
  device_id: number;
}

export interface DeviceDto {
  id: number;
  name: string;
  created_at: number;
  last_active_at: number;
  current: boolean;
}

export interface InviteDto {
  code: string;
  url: string;
  grants_admin: boolean;
  expires_at: number | null;
  max_uses: number;
  used_count: number;
}

// ---- REST -----------------------------------------------------------------

export interface RegisterRequest {
  invite: string;
  username: string;
  display_name: string;
  password: string;
  device_name: string;
}

export interface LoginRequest {
  username: string;
  password: string;
  device_name: string;
}

export interface UpdateMeRequest {
  display_name?: string;
  password?: { current: string; next: string };
}

export type CreateChatRequest = { kind: "direct"; user: number } | { kind: "group"; title: string; members: number[] };

/** POST /api/push/subscribe: PushSubscription.toJSON() plus the interface language. */
export interface PushSubscribeRequest {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  lang: string;
}

/** What a push carries. No message text: the push services in between see only that something happened. */
export interface PushPayload {
  chat: number;
  /** Group title; null for a direct chat, where the sender's name is the title. */
  chat_title: string | null;
  from: string;
  kind: MessageKind;
  lang: string;
}

export interface CreateInviteRequest {
  max_uses?: number;
  expires_in_days?: number;
}

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "bad_origin"
  | "invite_invalid"
  | "username_taken"
  | "wrong_password"
  | "chat_full"
  | "too_large"
  /** Search across all chats needs a word of three letters or more. */
  | "too_short"
  /** The account is blocked by an administrator. */
  | "blocked"
  /** A password-reset link that is unknown, used or expired. */
  | "reset_invalid";

export interface ErrorResponse {
  error: ErrorCode;
}

// ---- WebSocket frames -----------------------------------------------------

export type ClientFrame =
  /** First frame after connecting: the chat versions this client already has. */
  | { t: "hello"; sync: Record<string, number> }
  /** `media` is the id POST /api/media returned; text needs a body, the other kinds may leave it empty. */
  | { t: "msg.send"; chat: number; client_id: string; kind: MessageKind; body: string; media?: string; reply_to?: number }
  | { t: "msg.edit"; chat: number; seq: number; body: string }
  | { t: "msg.delete"; chat: number; seq: number }
  | { t: "receipt"; chat: number; delivered?: number; read?: number }
  | { t: "typing"; chat: number }
  /** An empty emoji removes this user's reaction. */
  | { t: "react"; chat: number; seq: number; emoji: string }
  | { t: "ping" };

export type ServerFrame =
  | { t: "msg.ack"; client_id: string; chat: number; seq: number; at: number }
  | { t: "msg.new"; msg: MessageDto }
  /** An edit, delete or reaction; also every changed message during sync. */
  | { t: "msg.update"; msg: MessageDto }
  /** End of the catch-up that follows `hello`. */
  | { t: "synced" }
  /** Too much changed while away: reload this chat over HTTP. */
  | { t: "chat.reset"; chat: number }
  | { t: "chat.update"; chat: ChatDto }
  | { t: "chat.removed"; chat: number }
  | { t: "receipt"; chat: number; user: number; delivered: number; read: number }
  | { t: "presence"; user: number; online: boolean; last_seen: number | null }
  | { t: "typing"; chat: number; user: number }
  | { t: "error"; code: ErrorCode; ref?: string }
  | { t: "pong" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const isSeq = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isBody = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= LIMITS.body;
const isCaption = (v: unknown): v is string => typeof v === "string" && v.length <= LIMITS.body;
const KINDS: readonly unknown[] = ["text", "image", "file", "voice"] satisfies MessageKind[];
export const MEDIA_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The frame if it is well-formed, otherwise null. Unknown extra fields are dropped. */
export function parseClientFrame(raw: unknown): ClientFrame | null {
  if (!isObject(raw)) return null;
  const f = raw;
  switch (f.t) {
    case "hello": {
      if (!isObject(f.sync)) return null;
      const sync: Record<string, number> = {};
      for (const [chat, version] of Object.entries(f.sync)) {
        if (!isId(Number(chat)) || !isSeq(version)) return null;
        sync[chat] = version;
      }
      return { t: "hello", sync };
    }
    case "msg.send": {
      if (!isId(f.chat) || typeof f.client_id !== "string" || !UUID_RE.test(f.client_id) || !KINDS.includes(f.kind)) return null;
      const kind = f.kind as MessageKind;
      if (typeof f.body !== "string") return null;
      const body = f.body;
      if (kind === "text" ? !isBody(body) || f.media !== undefined : !isCaption(body) || typeof f.media !== "string" || !MEDIA_ID_RE.test(f.media)) return null;
      if (f.reply_to !== undefined && !isId(f.reply_to)) return null;
      return {
        t: "msg.send",
        chat: f.chat,
        client_id: f.client_id.toLowerCase(),
        kind,
        body: kind === "text" ? body : body.trim(),
        ...(kind !== "text" && { media: f.media as string }),
        ...(f.reply_to !== undefined && { reply_to: f.reply_to }),
      };
    }
    case "msg.edit":
      return isId(f.chat) && isId(f.seq) && isBody(f.body) ? { t: "msg.edit", chat: f.chat, seq: f.seq, body: f.body } : null;
    case "msg.delete":
      return isId(f.chat) && isId(f.seq) ? { t: "msg.delete", chat: f.chat, seq: f.seq } : null;
    case "receipt": {
      if (!isId(f.chat)) return null;
      if (f.delivered === undefined && f.read === undefined) return null;
      if ((f.delivered !== undefined && !isSeq(f.delivered)) || (f.read !== undefined && !isSeq(f.read))) return null;
      return {
        t: "receipt",
        chat: f.chat,
        ...(f.delivered !== undefined && { delivered: f.delivered }),
        ...(f.read !== undefined && { read: f.read }),
      };
    }
    case "typing":
      return isId(f.chat) ? { t: "typing", chat: f.chat } : null;
    case "react":
      if (!isId(f.chat) || !isId(f.seq) || typeof f.emoji !== "string" || f.emoji.length > LIMITS.emoji) return null;
      // Any visible character is fine; letters and digits are not reactions.
      if (f.emoji !== "" && (/[\p{L}\p{N}\s<>]/u.test(f.emoji) || f.emoji.trim() === "")) return null;
      return { t: "react", chat: f.chat, seq: f.seq, emoji: f.emoji };
    case "ping":
      return { t: "ping" };
    default:
      return null;
  }
}
