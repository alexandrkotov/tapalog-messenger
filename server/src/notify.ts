import type { Database } from "bun:sqlite";
import type { MessageDto, PushPayload } from "@tapalog-messenger/shared";
import { isPushServiceUrl, sendPush, type Vapid } from "./push";
import { getUser } from "./store/accounts";
import * as chats from "./store/chats";
import * as subscriptions from "./store/push";

/**
 * Who gets woken up, and when: members of the chat other than the sender
 * who have no tab open (an open tab hears the message over its WebSocket)
 * and have not muted the chat. The notification says who wrote and where,
 * never what.
 */

export interface NotifierOptions {
  db: Database;
  vapid: Vapid;
  /** The VAPID subject: how a push service could reach whoever runs this server. */
  subject: () => string;
  isOnline: (userId: number) => boolean;
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
      const asleep = chats.membersToNotify(db, msg.chat, msg.from, o.now()).filter((id) => !o.isOnline(id));
      const subs = subscriptions.subscriptionsOf(db, asleep);
      if (subs.length === 0) return;
      const chat = db.query("SELECT kind, title FROM chats WHERE id = $id").get({ id: msg.chat }) as { kind: string; title: string | null } | null;
      const from = getUser(db, msg.from)?.display_name ?? "";
      await Promise.all(
        subs.map(async (sub) => {
          const payload: PushPayload = { chat: msg.chat, chat_title: chat?.kind === "group" ? chat.title : null, from, kind: msg.kind, lang: sub.lang };
          const result = await sendPush(sub, payload, { vapid: o.vapid, subject: o.subject(), now: o.now(), fetch: o.fetch });
          if (result === "gone") subscriptions.forgetSubscription(db, sub.endpoint);
        }),
      );
    },
  };
}
