import type { Database } from "bun:sqlite";
import type { Server, ServerWebSocket } from "bun";
import { parseClientFrame, type ClientFrame, type MessageDto, type ServerFrame } from "@tapalog-messenger/shared";
import { RateLimiter } from "./http";
import { setLastSeen } from "./store/accounts";
import * as chats from "./store/chats";

/**
 * The WebSocket side: one connection per open tab. Each connection is
 * subscribed to the topic `user:<id>`, and anything for a chat is published
 * to the topics of all its members — Bun's own pub/sub, no broker.
 */

export interface SocketData {
  userId: number;
  deviceId: number;
}

type Socket = ServerWebSocket<SocketData>;

/** Changes found while away beyond this many are not replayed: the client reloads the chat instead. */
const SYNC_LIMIT = 200;

const userTopic = (id: number) => `user:${id}`;

export class Hub {
  private server: Server<SocketData> | null = null;
  private sockets = new Map<number, Set<Socket>>();
  /** Any frame, per connection. */
  private frames = new RateLimiter(120, 10_000);
  /** New messages, per user across all their tabs. */
  private sends = new RateLimiter(30, 10_000);
  /** Told about every new message after it went out to open tabs: Web Push for the rest. */
  onNewMessage: ((msg: MessageDto) => void) | null = null;

  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  attach(server: Server<SocketData>) {
    this.server = server;
  }

  isOnline = (userId: number): boolean => this.sockets.has(userId);
  /** Whether this one device of the user has the app open. */
  isDeviceOnline = (userId: number, deviceId: number): boolean => [...(this.sockets.get(userId) ?? [])].some((ws) => ws.data.deviceId === deviceId);

  /** Sends a frame to every open tab of these users. */
  publish(userIds: Iterable<number>, frame: ServerFrame) {
    if (!this.server) return;
    const data = JSON.stringify(frame);
    for (const id of new Set(userIds)) this.server.publish(userTopic(id), data);
  }

  /** Tells every member how the chat now looks to them (titles, members, unread differ per person). */
  publishChat(chatId: number, extraUserIds: number[] = []) {
    const members = chats.memberIds(this.db, chatId);
    for (const id of members) {
      const chat = chats.getChat(this.db, chatId, id, this.isOnline);
      if (chat) this.publish([id], { t: "chat.update", chat });
    }
    const gone = extraUserIds.filter((id) => !members.includes(id));
    if (gone.length) this.publish(gone, { t: "chat.removed", chat: chatId });
  }

  /** Closes the tabs of a device that was just signed out. */
  disconnectDevice(deviceId: number) {
    for (const set of this.sockets.values()) for (const ws of set) if (ws.data.deviceId === deviceId) ws.close(4001, "signed out");
  }

  /** Closes every tab of a user who was just blocked or had their password reset. */
  disconnectUser(userId: number) {
    for (const ws of this.sockets.get(userId) ?? []) ws.close(4001, "signed out");
  }

  /** On shutdown: tell clients to reconnect later rather than treat it as an error. */
  closeAll() {
    for (const set of this.sockets.values()) for (const ws of set) ws.close(1001, "server stopping");
  }

  readonly handlers = {
    open: (ws: Socket) => {
      const { userId } = ws.data;
      ws.subscribe(userTopic(userId));
      const set = this.sockets.get(userId) ?? new Set();
      const wasOffline = set.size === 0;
      set.add(ws);
      this.sockets.set(userId, set);
      if (wasOffline) this.publish(chats.contactIds(this.db, userId), { t: "presence", user: userId, online: true, last_seen: null });
    },

    close: (ws: Socket) => {
      const { userId } = ws.data;
      const set = this.sockets.get(userId);
      if (!set) return;
      set.delete(ws);
      if (set.size > 0) return;
      this.sockets.delete(userId);
      const at = this.now();
      setLastSeen(this.db, userId, at);
      this.publish(chats.contactIds(this.db, userId), { t: "presence", user: userId, online: false, last_seen: at });
    },

    message: (ws: Socket, raw: string | Buffer) => {
      const send = (frame: ServerFrame): void => {
        ws.send(JSON.stringify(frame));
      };
      if (!this.frames.hit(`${ws.data.deviceId}:${ws.remoteAddress}`, this.now())) return send({ t: "error", code: "rate_limited" });
      let frame: ClientFrame | null = null;
      try {
        frame = parseClientFrame(JSON.parse(typeof raw === "string" ? raw : raw.toString("utf-8")));
      } catch {
        // falls through to the bad_request below
      }
      if (!frame) return send({ t: "error", code: "bad_request" });
      this.handle(ws, frame, send);
    },
  };

  private handle(ws: Socket, f: ClientFrame, send: (frame: ServerFrame) => void) {
    const { userId } = ws.data;
    const now = this.now();
    switch (f.t) {
      case "ping":
        return send({ t: "pong" });

      case "hello": {
        for (const [key, version] of Object.entries(f.sync)) {
          const chatId = Number(key);
          if (!chats.memberRole(this.db, chatId, userId)) {
            send({ t: "chat.removed", chat: chatId });
            continue;
          }
          const { messages, more } = chats.changedSince(this.db, chatId, version, SYNC_LIMIT);
          if (more) send({ t: "chat.reset", chat: chatId });
          else for (const msg of messages) send({ t: "msg.update", msg });
        }
        return send({ t: "synced" });
      }

      case "msg.send": {
        if (!this.sends.hit(String(userId), now)) return send({ t: "error", code: "rate_limited", ref: f.client_id });
        const res = chats.sendMessage(this.db, {
          chatId: f.chat,
          sender: userId,
          clientId: f.client_id,
          kind: f.kind,
          body: f.body,
          mediaId: f.media,
          replyTo: f.reply_to,
          now,
        });
        if (typeof res === "string") return send({ t: "error", code: res === "bad_request" ? "bad_request" : "forbidden", ref: f.client_id });
        send({ t: "msg.ack", client_id: f.client_id, chat: f.chat, seq: res.msg.seq, at: res.msg.at });
        if (res.duplicate) return;
        this.publish(chats.memberIds(this.db, f.chat), { t: "msg.new", msg: res.msg });
        this.onNewMessage?.(res.msg);
        return;
      }

      case "msg.edit":
      case "msg.delete":
      case "react": {
        const res =
          f.t === "msg.edit"
            ? chats.editMessage(this.db, f.chat, f.seq, userId, f.body, now)
            : f.t === "msg.delete"
              ? chats.deleteMessage(this.db, f.chat, f.seq, userId, now)
              : chats.setReaction(this.db, f.chat, f.seq, userId, f.emoji);
        if (typeof res === "string") return send({ t: "error", code: res === "not_found" ? "not_found" : "forbidden" });
        return this.publish(chats.memberIds(this.db, f.chat), { t: "msg.update", msg: res });
      }

      case "receipt": {
        const marks = chats.markReceipt(this.db, f.chat, userId, { delivered: f.delivered, read: f.read });
        if (marks) this.publish(chats.memberIds(this.db, f.chat), { t: "receipt", chat: f.chat, user: userId, ...marks });
        return;
      }

      case "typing": {
        const members = chats.memberIds(this.db, f.chat);
        if (!members.includes(userId)) return send({ t: "error", code: "forbidden" });
        return this.publish(
          members.filter((id) => id !== userId),
          { t: "typing", chat: f.chat, user: userId },
        );
      }
    }
  }
}
