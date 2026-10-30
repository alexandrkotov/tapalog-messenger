import type { Database } from "bun:sqlite";
import type { MessageDto, PushPayload } from "@tapalog-messenger/shared";
import { RING_MS } from "./calls";
import { isPushServiceUrl, sendPush, type Vapid } from "./push";
import { getUser } from "./store/accounts";
import * as chats from "./store/chats";
import * as subscriptions from "./store/push";

/**
 * Who gets woken up, and when: every device, of every member but the sender
 * who has not muted the chat, that has no tab open there (an open tab hears
 * the message over its WebSocket). So a phone in a pocket is woken even
 * while the computer has the chat open. The notification says who wrote and
 * where, never what.
 *
 * Calls ring even in a muted chat: a call is someone wanting you now. Their
 * pushes go to the person called only, and the one with the call's record
 * replaces the ringing one on the device (missed, or quietly gone).
 */

export interface NotifierOptions {
  db: Database;
  vapid: Vapid;
  /** The VAPID subject: how a push service could reach whoever runs this server. */
  subject: () => string;
  isDeviceOnline: (userId: number, deviceId: number) => boolean;
  now: () => number;
  /** Which subscription addresses to accept; the known push services unless a test says otherwise. */
  allowEndpoint?: (endpoint: string) => boolean;
  fetch?: typeof fetch;
}

export type Notifier = ReturnType<typeof createNotifier>;

export function createNotifier(o: NotifierOptions) {
  const { db } = o;
  return {
    publicKey: o.vapid.publicKey,
    allowEndpoint: o.allowEndpoint ?? isPushServiceUrl,

    /** Resolves once every push has been handed over (or has failed); callers need not wait. */
    async newMessage(msg: MessageDto): Promise<void> {
      if (msg.from === null) return;
      const to = msg.kind === "call" ? chats.memberIds(db, msg.chat).filter((id) => id !== msg.from) : chats.membersToNotify(db, msg.chat, msg.from, o.now());
      await send(to, msg.chat, msg.from, (payload) => ({ ...payload, kind: msg.kind, ...(msg.call && { call: msg.call }) }));
    },

    /** Wakes the devices of the person called that have no tab open; the push is worth nothing once the call stops ringing. */
    async ringing(call: { id: string; chat: number; from: number; to: number; video: boolean }): Promise<void> {
      await send([call.to], call.chat, call.from, (payload) => ({ ...payload, kind: "call", ringing: { call: call.id, video: call.video } }), Math.ceil(RING_MS / 1000));
    },
  };

  async function send(to: number[], chatId: number, fromId: number, build: (base: Omit<PushPayload, "kind">) => PushPayload, ttl?: number) {
    const subs = subscriptions.subscriptionsOf(db, to).filter((s) => !o.isDeviceOnline(s.user_id, s.device_id));
    if (subs.length === 0) return;
    const chat = db.query("SELECT kind, title, avatar_media_id FROM chats WHERE id = $id").get({ id: chatId }) as {
      kind: string;
      title: string | null;
      avatar_media_id: string | null;
    } | null;
    const sender = getUser(db, fromId);
    const from = sender?.display_name ?? "";
    // A group's own photo if it has one, else the sender's.
    const photo = chat?.avatar_media_id ?? sender?.avatar_media_id ?? null;
    const icon = photo && `/media/${photo}/thumb`;
    await Promise.all(
      subs.map(async (sub) => {
        const payload = build({ chat: chatId, chat_title: chat?.kind === "group" ? chat.title : null, from, icon, lang: sub.lang });
        const result = await sendPush(sub, payload, { vapid: o.vapid, subject: o.subject(), now: o.now(), fetch: o.fetch, ttl });
        if (result === "gone") subscriptions.forgetSubscription(db, sub.endpoint);
      }),
    );
  }
}
