import type { ChatDto, ClientFrame, ErrorCode, MediaDto, MeDto, MemberDto, MessageDto, MessageKind, ServerFrame } from "@tapalog-messenger/shared";
import { useEffect, useState } from "preact/hooks";
import { api, ApiError, deviceName } from "./api";
import { isPhotoType, preparePhoto, tooLarge, upload, type Outgoing } from "./media";
import * as offline from "./offline";
import { navigate } from "./router";

/**
 * All client state in one place, plus the WebSocket that keeps it current.
 * Components read `state` through useAppState() and change it only through
 * the functions below.
 */

/** A message written here that the server has not confirmed yet. */
export interface Pending {
  client_id: string;
  chat: number;
  kind: MessageKind;
  body: string;
  reply_to?: number;
  at: number;
  /** The server refused it; shown with a retry button. */
  failed?: boolean;
  /** Why, when the reason is worth telling (a file too large, the hourly upload limit). */
  error?: ErrorCode;
  /** A photo, file or recording still to upload. */
  file?: Outgoing;
  /** The upload, once done: what msg.send refers to. */
  media?: MediaDto;
  /** 0–1 while uploading. */
  progress?: number;
  /** A photo still being compressed. */
  preparing?: boolean;
  /** msg.send went out on the current connection; cleared on reconnect, when it is sent again (the server drops repeats). */
  sent?: boolean;
}

export type Phase = "loading" | "signed-out" | "ready" | "unreachable";
export type Conn = "connecting" | "online" | "offline";

export const state = {
  phase: "loading" as Phase,
  me: null as MeDto | null,
  conn: "connecting" as Conn,
  chats: new Map<number, ChatDto>(),
  /** Loaded messages per chat, by seq. Only chats that were opened. */
  messages: new Map<number, MessageDto[]>(),
  /** Whether older history exists for a loaded chat. */
  older: new Map<number, boolean>(),
  outbox: [] as Pending[],
  /** chat → user → typing until (ms) */
  typing: new Map<number, Map<number, number>>(),
  openChat: null as number | null,
  /** A newer version of the app is installed; reloading starts it. */
  updateReady: false,
};

// ---- Subscriptions ---------------------------------------------------------

const listeners = new Set<() => void>();
let scheduled = false;
/** Re-renders subscribers once per tick, however many changes happened, and saves the state a moment later. */
function changed() {
  saveSoon();
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    listeners.forEach((l) => l());
  });
}

export function useAppState(): typeof state {
  const [, setTick] = useState(0);
  useEffect(() => {
    const l = () => setTick((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return state;
}

// ---- Derived ---------------------------------------------------------------

export const myId = () => state.me?.user.id ?? 0;

export function otherMembers(chat: ChatDto): MemberDto[] {
  return chat.members.filter((m) => m.id !== myId());
}

export function chatName(chat: ChatDto): string {
  if (chat.kind === "group") return chat.title ?? "";
  return otherMembers(chat)[0]?.display_name ?? state.me?.user.display_name ?? "";
}

export type Tick = "pending" | "failed" | "sent" | "delivered" | "read";

/** Delivery state of my message: read or delivered only once every other member has it. */
export function tickOf(chat: ChatDto, seq: number): Tick {
  const others = otherMembers(chat);
  if (others.length === 0) return "read";
  if (others.every((m) => m.read_seq >= seq)) return "read";
  if (others.every((m) => m.delivered_seq >= seq)) return "delivered";
  return "sent";
}

export function typingIn(chatId: number): number[] {
  const now = Date.now();
  return [...(state.typing.get(chatId) ?? [])].filter(([, until]) => until > now).map(([id]) => id);
}

export function chatActivity(chat: ChatDto): number {
  const pending = state.outbox.filter((p) => p.chat === chat.id).map((p) => p.at);
  return Math.max(chat.last_message?.at ?? 0, ...pending);
}

// ---- Kept on this device ---------------------------------------------------

/** Bumped when what is saved changes shape; an older copy is then dropped rather than misread. */
const SAVED_SHAPE = 1;
/** The latest messages kept per opened chat. */
const KEEP_MESSAGES = 200;
const SAVE_DELAY_MS = 500;

let saveTimer: ReturnType<typeof setTimeout> | undefined;
const savedChats = new Set<number>();
/** client_id → what was last written for it, so an unchanged entry (and its file) is not written again. */
const savedOutbox = new Map<string, string>();
const blobIds = new WeakMap<Blob, number>();
let nextBlobId = 1;

function blobId(blob: Blob | undefined): number {
  if (!blob) return 0;
  if (!blobIds.has(blob)) blobIds.set(blob, nextBlobId++);
  return blobIds.get(blob)!;
}

/** What is kept of an outbox entry: upload progress and "sent on this connection" mean nothing after a restart. */
function keepable({ sent: _sent, progress: _progress, ...p }: Pending): Pending {
  return p;
}

const signature = (p: Pending) => JSON.stringify({ ...p, file: p.file && { ...p.file, blob: blobId(p.file.blob), thumb: blobId(p.file.thumb) } });

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_DELAY_MS);
}

/** Writes what this device should still show after a restart without a network. */
function save() {
  clearTimeout(saveTimer);
  if (!state.me) return;
  const ids = state.outbox.map((p) => p.client_id);
  const entries: [string, unknown][] = [
    ["shape", SAVED_SHAPE],
    ["me", state.me],
    ["chats", [...state.chats.values()]],
    ["outbox", ids],
  ];
  for (const p of state.outbox) {
    const kept = keepable(p);
    const sig = signature(kept);
    if (savedOutbox.get(p.client_id) === sig) continue;
    entries.push([`outbox:${p.client_id}`, kept]);
    savedOutbox.set(p.client_id, sig);
  }
  for (const id of [...savedOutbox.keys()]) {
    if (ids.includes(id)) continue;
    entries.push([`outbox:${id}`, undefined]);
    savedOutbox.delete(id);
  }
  for (const [id, list] of state.messages) entries.push([`messages:${id}`, list.slice(-KEEP_MESSAGES)]);
  for (const id of savedChats) if (!state.messages.has(id)) entries.push([`messages:${id}`, undefined]);
  savedChats.clear();
  for (const id of state.messages.keys()) savedChats.add(id);
  void offline.putMany(entries);
}
// A tab being closed or sent to the background may not get another chance.
addEventListener("pagehide", save);
document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && save());

/** Puts back what was saved, if it belongs to a signed-in account. */
async function restore(): Promise<boolean> {
  const saved = await offline.getAll();
  const me = saved.get("me") as MeDto | undefined;
  if (saved.get("shape") !== SAVED_SHAPE || !me) return false;
  state.me = me;
  state.chats = new Map(((saved.get("chats") as ChatDto[] | undefined) ?? []).map((c) => [c.id, c]));
  for (const [key, value] of saved) {
    if (!key.startsWith("messages:")) continue;
    const id = Number(key.slice("messages:".length));
    const list = value as MessageDto[];
    state.messages.set(id, list);
    state.older.set(id, (list[0]?.seq ?? 1) > 1);
    savedChats.add(id);
  }
  const ids = (saved.get("outbox") as string[] | undefined) ?? [];
  state.outbox = ids.map((id) => saved.get(`outbox:${id}`) as Pending | undefined).filter((p): p is Pending => p !== undefined);
  for (const p of state.outbox) savedOutbox.set(p.client_id, signature(p));
  // A photo that was still being compressed when the page closed: compress it now.
  for (const p of state.outbox) if (p.preparing) void prepare(p);
  return true;
}

// ---- Boot and auth ---------------------------------------------------------

let bootTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Starts the app from what this device saved, if anything, so it opens
 * without a network; then asks the server who is signed in, and keeps
 * asking every few seconds while it cannot be reached.
 */
export async function boot() {
  clearTimeout(bootTimer);
  if (state.phase === "loading" && (await restore())) {
    state.phase = "ready";
    changed();
  }
  try {
    const me = await api<MeDto>("GET", "/me");
    // Saved for someone else (signed out elsewhere, then signed in as another person): start clean.
    if (state.me && state.me.user.id !== me.user.id) resetState();
    state.me = me;
    state.phase = "ready";
    changed();
    await loadChats();
    connect();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      // Saved from a session that has since ended: forget it. Otherwise stay on the page asked for (an invite link, say).
      if (state.me) return signedOut();
      state.phase = "signed-out";
      return changed();
    }
    if (state.phase !== "ready") state.phase = "unreachable";
    state.conn = "offline";
    bootTimer = setTimeout(boot, 5000);
    changed();
  }
}

export async function login(username: string, password: string) {
  state.me = await api<MeDto>("POST", "/auth/login", { username, password, device_name: deviceName() });
  await afterSignIn();
}

export async function register(invite: string, username: string, displayName: string, password: string) {
  state.me = await api<MeDto>("POST", "/auth/register", { invite, username, display_name: displayName, password, device_name: deviceName() });
  await afterSignIn();
}

async function afterSignIn() {
  state.phase = "ready";
  navigate("/", true);
  changed();
  await loadChats();
  connect();
}

export async function logout() {
  await api("POST", "/auth/logout").catch(() => {});
  signedOut();
}

function resetState() {
  state.chats.clear();
  state.messages.clear();
  state.older.clear();
  state.outbox = [];
  state.typing.clear();
}

/** Forgets everything about the account on this device, saved copies and cached previews included. */
function signedOut() {
  disconnect();
  clearTimeout(saveTimer);
  state.me = null;
  state.phase = "signed-out";
  resetState();
  savedChats.clear();
  savedOutbox.clear();
  void offline.clearAll();
  void caches?.delete(THUMB_CACHE).catch(() => {});
  navigate("/", true);
  changed();
}

/** The service worker's cache of photo previews (see public/sw.js). */
const THUMB_CACHE = "thumbs";

export function setUpdateReady() {
  state.updateReady = true;
  changed();
}

export function setMe(me: MeDto) {
  state.me = me;
  changed();
}

// ---- Chats and history -----------------------------------------------------

export async function loadChats() {
  const list = await api<ChatDto[]>("GET", "/chats");
  state.chats = new Map(list.map((c) => [c.id, c]));
  changed();
  acknowledgeDelivery();
}

/** Tells senders that whatever arrived while this device was away has now reached it. */
function acknowledgeDelivery() {
  for (const chat of state.chats.values()) {
    const mine = chat.members.find((m) => m.id === myId());
    if (mine && mine.delivered_seq < chat.last_seq) send({ t: "receipt", chat: chat.id, delivered: chat.last_seq });
  }
}

export function upsertChat(chat: ChatDto) {
  state.chats.set(chat.id, chat);
  changed();
}

const PAGE = 50;

export async function openChat(chatId: number | null) {
  state.openChat = chatId;
  changed();
  if (chatId === null) return;
  if (!state.messages.has(chatId)) {
    const page = await api<MessageDto[]>("GET", `/chats/${chatId}/messages?limit=${PAGE}`).catch(() => null);
    if (!page) return;
    // Live frames may have arrived meanwhile; keep them.
    for (const m of page) upsertMessage(m, false);
    if (!state.messages.has(chatId)) state.messages.set(chatId, []);
    state.older.set(chatId, page.length === PAGE);
    changed();
  }
  markRead(chatId);
}

export async function loadOlder(chatId: number) {
  const list = state.messages.get(chatId);
  const first = list?.[0]?.seq;
  if (!list || first === undefined) return;
  const page = await api<MessageDto[]>("GET", `/chats/${chatId}/messages?limit=${PAGE}&before_seq=${first}`);
  state.messages.set(chatId, [...page, ...list.filter((m) => m.seq >= first)]);
  state.older.set(chatId, page.length === PAGE);
  changed();
}

/** Puts a message into its chat's loaded list; edits replace, new ones append. */
function upsertMessage(msg: MessageDto, onlyIfLoaded = true) {
  const list = state.messages.get(msg.chat);
  if (!list) {
    if (onlyIfLoaded) return;
    state.messages.set(msg.chat, [msg]);
    return;
  }
  // An edit of a message older than what is loaded: it comes along when that page is loaded.
  if (list.length > 0 && msg.seq < list[0]!.seq) return;
  const i = list.findIndex((m) => m.seq === msg.seq);
  if (i >= 0) list[i] = msg;
  else {
    list.push(msg);
    list.sort((a, b) => a.seq - b.seq);
  }
}

/** The newest change this client has seen in a chat: what it asks to catch up from. */
function syncVersion(chatId: number): number {
  return Math.max(0, ...(state.messages.get(chatId) ?? []).map((m) => m.version));
}

// ---- Sending ---------------------------------------------------------------

export function sendMessage(chat: number, body: string, replyTo?: number) {
  enqueue({ chat, kind: "text", body, ...(replyTo !== undefined && { reply_to: replyTo }) });
}

function enqueue(p: Omit<Pending, "client_id" | "at">): Pending {
  const full: Pending = { ...p, client_id: crypto.randomUUID(), at: Date.now() };
  state.outbox.push(full);
  changed();
  save();
  pump();
  return full;
}

/**
 * Photos (compressed, unless `asFiles`) and other files, one message each,
 * in the order chosen. The caption and the reply go with the first. Each
 * takes its place in the queue at once; a photo waits there while it is
 * being compressed, and whatever is written after it waits behind it.
 */
export async function sendFiles(chat: number, files: File[], caption: string, opts: { asFiles?: boolean; replyTo?: number } = {}) {
  const queued = files.map((file, i) => {
    const photo = !opts.asFiles && isPhotoType(file.type);
    return enqueue({
      chat,
      kind: photo ? "image" : "file",
      body: i === 0 ? caption.trim() : "",
      file: { blob: file, name: file.name || "file" },
      ...(photo && { preparing: true }),
      ...(i === 0 && opts.replyTo !== undefined && { reply_to: opts.replyTo }),
    });
  });
  save(); // the files are safe on this device before the slow part starts
  for (const p of queued) await prepare(p);
}

/** Compresses a queued photo, then lets the outbox move. */
async function prepare(p: Pending) {
  if (p.preparing) {
    const photo = await preparePhoto(p.file!.blob, p.file!.name);
    // A picture this browser cannot read (HEIC outside Safari) goes as a file.
    if (photo) p.file = photo;
    else p.kind = "file";
    p.preparing = false;
  }
  if (tooLarge(p.file!.blob)) Object.assign(p, { failed: true, error: "too_large" });
  changed();
  pump();
}

export function sendVoice(chat: number, recording: Outgoing, replyTo?: number) {
  enqueue({ chat, kind: "voice", body: "", file: recording, ...(replyTo !== undefined && { reply_to: replyTo }) });
}

let uploading: Pending | null = null;
const UPLOAD_RETRY_MS = 5000;

/**
 * Moves the outbox along, oldest first: a message goes out only after every
 * earlier one in its chat, so a photo still uploading keeps the text written
 * after it waiting rather than letting it overtake. One upload at a time.
 * Safe to call any time; it does only what is possible right now.
 */
function pump() {
  if (state.conn !== "online") return; // everything goes once the connection is back
  const blocked = new Set<number>();
  for (const p of state.outbox) {
    if (p.failed || blocked.has(p.chat)) continue;
    if (p.preparing || (p.file && !p.media)) {
      blocked.add(p.chat);
      if (!p.preparing && !uploading) void uploadFor(p);
      continue;
    }
    if (p.sent) continue;
    if (!send(sendFrame(p))) return;
    p.sent = true;
  }
}

function sendFrame(p: Pending): ClientFrame {
  return {
    t: "msg.send",
    chat: p.chat,
    client_id: p.client_id,
    kind: p.kind,
    body: p.body,
    ...(p.media && { media: p.media.id }),
    ...(p.reply_to !== undefined && { reply_to: p.reply_to }),
  };
}

async function uploadFor(p: Pending) {
  uploading = p;
  p.progress = 0;
  changed();
  try {
    p.media = await upload(p.file!, (share) => {
      p.progress = share;
      changed();
    });
  } catch (err) {
    const code = err instanceof ApiError ? err.code : "network";
    if (code === "network") setTimeout(pump, UPLOAD_RETRY_MS);
    else Object.assign(p, { failed: true, error: code });
  } finally {
    uploading = null;
    p.progress = undefined;
    changed();
  }
  pump();
}

export function retry(clientId: string) {
  const p = state.outbox.find((x) => x.client_id === clientId);
  if (!p) return;
  Object.assign(p, { failed: false, error: undefined, sent: false });
  changed();
  pump();
}

export function discard(clientId: string) {
  state.outbox = state.outbox.filter((p) => p.client_id !== clientId);
  changed();
  pump(); // whatever waited behind it may go now
}

export const editMessage = (chat: number, seq: number, body: string) => send({ t: "msg.edit", chat, seq, body });
export const deleteMessage = (chat: number, seq: number) => send({ t: "msg.delete", chat, seq });
export const react = (chat: number, seq: number, emoji: string) => send({ t: "react", chat, seq, emoji });

let lastTyping = 0;
export function typing(chat: number) {
  if (Date.now() - lastTyping < 3000) return;
  lastTyping = Date.now();
  send({ t: "typing", chat });
}

/** Marks everything in the chat read, if the person is actually looking at it. */
export function markRead(chatId: number) {
  const chat = state.chats.get(chatId);
  if (!chat || state.openChat !== chatId || document.visibilityState !== "visible") return;
  const mine = chat.members.find((m) => m.id === myId());
  if (chat.unread) {
    chat.unread = 0;
    changed();
  }
  if (!mine || mine.read_seq >= chat.last_seq) return;
  mine.read_seq = chat.last_seq;
  mine.delivered_seq = Math.max(mine.delivered_seq, chat.last_seq);
  send({ t: "receipt", chat: chatId, read: chat.last_seq });
}
document.addEventListener("visibilitychange", () => state.openChat !== null && markRead(state.openChat));

// ---- WebSocket -------------------------------------------------------------

let ws: WebSocket | null = null;
let retryDelay = 1000;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let pingTimer: ReturnType<typeof setInterval> | undefined;
let lastHeard = 0;

const PING_MS = 30_000;

function send(frame: ClientFrame): boolean {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(frame));
  return true;
}

export function connect() {
  if (ws || state.phase !== "ready") return;
  clearTimeout(reconnectTimer);
  if (!navigator.onLine) {
    state.conn = "offline";
    changed();
    return;
  }
  state.conn = "connecting";
  changed();
  const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws = socket;
  socket.onopen = () => {
    retryDelay = 1000;
    lastHeard = Date.now();
    const sync: Record<string, number> = {};
    for (const id of state.messages.keys()) sync[id] = syncVersion(id);
    send({ t: "hello", sync });
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      // Nothing heard for two pings: the connection is dead even if the browser has not noticed.
      if (Date.now() - lastHeard > 2 * PING_MS + 5000) socket.close();
      else send({ t: "ping" });
    }, PING_MS);
  };
  socket.onmessage = (e) => {
    lastHeard = Date.now();
    onFrame(JSON.parse(String(e.data)) as ServerFrame);
  };
  socket.onclose = (e) => {
    if (ws !== socket) return;
    ws = null;
    clearInterval(pingTimer);
    state.conn = "offline";
    changed();
    if (e.code === 4001) return signedOut();
    // Closed before it ever opened: maybe the session is gone. Ask once.
    if (lastHeard === 0) {
      void api("GET", "/me").catch((err) => err instanceof ApiError && err.status === 401 && signedOut());
    }
    lastHeard = 0;
    reconnectTimer = setTimeout(connect, retryDelay + Math.random() * 500);
    retryDelay = Math.min(retryDelay * 2, 30_000);
  };
}

function disconnect() {
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);
  const socket = ws;
  ws = null;
  socket?.close();
}

window.addEventListener("offline", () => {
  disconnect();
  state.conn = "offline";
  changed();
});
window.addEventListener("online", () => {
  retryDelay = 1000;
  connect();
});

async function onReconnected() {
  // Receipts, members and unread counts moved while away; the chat list is the cheap way to catch up on them.
  await loadChats().catch(() => {});
  for (const p of state.outbox) p.sent = false;
  pump();
}

function onFrame(f: ServerFrame) {
  switch (f.t) {
    case "synced":
      state.conn = "online";
      void onReconnected();
      break;

    case "msg.ack": {
      const i = state.outbox.findIndex((p) => p.client_id === f.client_id);
      if (i < 0) break;
      const p = state.outbox[i]!;
      state.outbox.splice(i, 1);
      // Shown as sent right away; the msg.new that follows replaces it with the stored copy.
      onMessage(
        { chat: f.chat, seq: f.seq, client_id: p.client_id, from: myId(), kind: p.kind, body: p.body, media: p.media ?? null, reply_to: p.reply_to ?? null, at: f.at, edited_at: null, deleted: false, version: 0, reactions: {} },
        false,
      );
      break;
    }

    case "msg.new":
    case "msg.update":
      onMessage(f.msg, f.t === "msg.new");
      break;

    case "receipt": {
      const member = state.chats.get(f.chat)?.members.find((m) => m.id === f.user);
      if (member) {
        member.delivered_seq = Math.max(member.delivered_seq, f.delivered);
        member.read_seq = Math.max(member.read_seq, f.read);
      }
      if (f.user === myId() && f.read >= (state.chats.get(f.chat)?.last_seq ?? 0)) {
        const chat = state.chats.get(f.chat);
        if (chat) chat.unread = 0; // read on another device
      }
      break;
    }

    case "presence":
      for (const chat of state.chats.values()) {
        const m = chat.members.find((x) => x.id === f.user);
        if (m) {
          m.online = f.online;
          if (f.last_seen !== null) m.last_seen_at = f.last_seen;
        }
      }
      break;

    case "typing": {
      const map = state.typing.get(f.chat) ?? new Map<number, number>();
      map.set(f.user, Date.now() + 5000);
      state.typing.set(f.chat, map);
      setTimeout(changed, 5100);
      break;
    }

    case "chat.update":
      state.chats.set(f.chat.id, f.chat);
      if (state.openChat === f.chat.id) markRead(f.chat.id);
      break;

    case "chat.removed":
      state.chats.delete(f.chat);
      state.messages.delete(f.chat);
      if (state.openChat === f.chat) navigate("/", true);
      break;

    case "chat.reset":
      state.messages.delete(f.chat);
      if (state.openChat === f.chat) void openChat(f.chat);
      break;

    case "error":
      if (f.ref) {
        const p = state.outbox.find((x) => x.client_id === f.ref);
        if (p && f.code === "rate_limited")
          setTimeout(() => {
            p.sent = false;
            pump();
          }, 3000);
        else if (p) p.failed = true;
      }
      break;

    case "pong":
      break;
  }
  changed();
}

function onMessage(msg: MessageDto, isNew: boolean) {
  upsertMessage(msg);
  state.outbox = state.outbox.filter((p) => p.client_id !== msg.client_id);
  const chat = state.chats.get(msg.chat);
  if (!chat) {
    // A chat this client has not heard of yet (just created by someone else).
    void loadChats().catch(() => {});
    return;
  }
  if (msg.seq >= (chat.last_message?.seq ?? 0)) chat.last_message = msg;
  chat.last_seq = Math.max(chat.last_seq, msg.seq);
  chat.version = Math.max(chat.version, msg.version);
  if (!isNew || msg.from === myId()) return;
  state.typing.get(msg.chat)?.delete(msg.from ?? 0);
  chat.unread += 1;
  send({ t: "receipt", chat: msg.chat, delivered: msg.seq });
  const mine = chat.members.find((m) => m.id === myId());
  if (mine) mine.delivered_seq = Math.max(mine.delivered_seq, msg.seq);
  markRead(msg.chat);
}
