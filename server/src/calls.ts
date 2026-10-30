import type { Database } from "bun:sqlite";
import type { ServerWebSocket } from "bun";
import type { CallEndReason, CallRecord, ClientFrame, MessageDto, ServerFrame } from "@tapalog-messenger/shared";
import { RateLimiter } from "./http";
import type { SocketData } from "./hub";
import * as chats from "./store/chats";

/**
 * Calls between the two people of a direct chat. The server only rings,
 * passes WebRTC's offers, answers and candidates between the two tabs that
 * talk, and writes how the call went into the chat; voice and video go
 * between the devices (or through the TURN relay), never through here.
 * A call lives in memory: after a restart there is nothing to go back to.
 */

type Socket = ServerWebSocket<SocketData>;

/** How long a call rings before it counts as missed. */
export const RING_MS = 45_000;
/** How long a tab that lost its connection mid-call has to come back (call.resume). */
export const RESUME_MS = 15_000;

interface Side {
  user: number;
  /** The tab that talks: the caller's from the start, the person called's once they answer. */
  ws: Socket | null;
  device: number | null;
  /** Running while `ws` is gone, until it comes back or the call is given up. */
  lost: Timer | null;
}

interface Call {
  id: string;
  chat: number;
  video: boolean;
  caller: Side;
  callee: Side;
  answeredAt: number | null;
  ringing: Timer | null;
}

export interface CallHooks {
  /** Sends to every open tab of these users. */
  publish(userIds: number[], frame: ServerFrame): void;
  /** Sends to every open tab of a user but one. */
  publishExcept(userId: number, except: Socket, frame: ServerFrame): void;
  /** A new message in the chat (the call's record): to the members, then Web Push. */
  newMessage(msg: MessageDto): void;
  /** Wakes the devices of the person called that have no tab open. */
  ring?(call: { id: string; chat: number; from: number; to: number; video: boolean }): void;
}

export class Calls {
  private calls = new Map<string, Call>();
  /** Calls started, per user: ringing is loud. */
  private invites = new RateLimiter(10, 60_000);

  private readonly now: () => number;
  private readonly ringMs: number;
  private readonly resumeMs: number;

  constructor(
    private readonly db: Database,
    private readonly hooks: CallHooks,
    o: { now?: () => number; ringMs?: number; resumeMs?: number } = {},
  ) {
    this.now = o.now ?? Date.now;
    this.ringMs = o.ringMs ?? RING_MS;
    this.resumeMs = o.resumeMs ?? RESUME_MS;
  }

  /** Whether this user is in a call, ringing or talking. */
  busy(userId: number): boolean {
    for (const c of this.calls.values()) if (c.caller.user === userId || c.callee.user === userId) return true;
    return false;
  }

  /** The calls ringing for this user right now: a tab opened meanwhile (from the notification, say) rings too. */
  ringingFor(userId: number): ServerFrame[] {
    return [...this.calls.values()]
      .filter((c) => c.callee.user === userId && c.answeredAt === null)
      .map((c) => ({ t: "call.ring", call: c.id, chat: c.chat, from: c.caller.user, video: c.video }));
  }

  handle(ws: Socket, f: Extract<ClientFrame, { t: `call.${string}` }>, send: (frame: ServerFrame) => void): void {
    const { userId, deviceId } = ws.data;
    if (f.t === "call.invite") return this.invite(ws, f, send);
    const call = this.calls.get(f.call);
    if (!call || (call.caller.user !== userId && call.callee.user !== userId)) {
      // Over already, or never ours: the tab stops showing it.
      return send({ t: "call.ended", call: f.call, reason: "ended" });
    }
    const mine = call.caller.user === userId ? call.caller : call.callee;
    const other = mine === call.caller ? call.callee : call.caller;
    const ringing = call.answeredAt === null;

    switch (f.t) {
      case "call.accept": {
        if (mine !== call.callee || !ringing) return;
        this.stopRinging(call);
        call.answeredAt = this.now();
        Object.assign(call.callee, { ws, device: deviceId });
        call.caller.ws?.send(JSON.stringify({ t: "call.accepted", call: call.id } satisfies ServerFrame));
        return this.hooks.publishExcept(userId, ws, { t: "call.taken", call: call.id });
      }
      case "call.reject":
        if (mine === call.callee && ringing) this.finish(call, "rejected");
        return;
      case "call.end":
        // The caller cancelling a call that still rings; the person called saying no from any tab; either hanging up.
        if (ringing) return this.finish(call, mine === call.caller ? "cancelled" : "rejected");
        if (mine.ws === ws || mine.device === deviceId) this.finish(call, "ended");
        return;
      case "call.signal":
        if (mine.ws !== ws) return;
        other.ws?.send(JSON.stringify({ t: "call.signal", call: call.id, data: f.data } satisfies ServerFrame));
        return;
      case "call.resume":
        if (mine.device !== deviceId) return send({ t: "call.ended", call: call.id, reason: "ended" });
        if (mine.lost) clearTimeout(mine.lost);
        mine.lost = null;
        mine.ws = ws;
        // Answered while the caller's tab was away: it would wait for that forever.
        if (mine === call.caller && !ringing) send({ t: "call.accepted", call: call.id });
        return;
    }
  }

  private invite(ws: Socket, f: Extract<ClientFrame, { t: "call.invite" }>, send: (frame: ServerFrame) => void) {
    const { userId, deviceId } = ws.data;
    const now = this.now();
    const peers = chats.callPeers(this.db, f.chat);
    if (!peers?.includes(userId) || this.calls.has(f.call)) return send({ t: "error", code: "forbidden", ref: f.call });
    if (!this.invites.hit(String(userId), now)) return send({ t: "error", code: "rate_limited", ref: f.call });
    const callee = peers[0] === userId ? peers[1] : peers[0];
    const call: Call = {
      id: f.call,
      chat: f.chat,
      video: f.video,
      caller: { user: userId, ws, device: deviceId, lost: null },
      callee: { user: callee, ws: null, device: null, lost: null },
      answeredAt: null,
      ringing: null,
    };
    if (this.busy(userId)) return send({ t: "call.ended", call: f.call, reason: "busy" });
    if (this.busy(callee)) return this.finish(call, "busy");
    this.calls.set(call.id, call);
    call.ringing = setTimeout(() => this.finish(call, "missed"), this.ringMs);
    this.hooks.publish([callee], { t: "call.ring", call: call.id, chat: call.chat, from: userId, video: call.video });
    this.hooks.ring?.({ id: call.id, chat: call.chat, from: userId, to: callee, video: call.video });
  }

  /** A tab closed (reload, lost network, signed out): its side of a call waits a little for it to come back. */
  socketClosed(ws: Socket) {
    for (const call of this.calls.values()) {
      for (const side of [call.caller, call.callee]) {
        if (side.ws !== ws) continue;
        side.ws = null;
        side.lost = setTimeout(() => this.finish(call, call.answeredAt === null ? "cancelled" : "failed"), this.resumeMs);
      }
    }
  }

  /** On shutdown: no timers left behind. */
  clear() {
    for (const call of this.calls.values()) this.release(call);
    this.calls.clear();
  }

  private stopRinging(call: Call) {
    if (call.ringing) clearTimeout(call.ringing);
    call.ringing = null;
  }

  private release(call: Call) {
    this.stopRinging(call);
    for (const side of [call.caller, call.callee]) if (side.lost) clearTimeout(side.lost);
  }

  /** Ends the call for both, and writes how it went into the chat. */
  private finish(call: Call, reason: CallEndReason) {
    this.release(call);
    this.calls.delete(call.id);
    // Every tab of both: the ones that rang stop, the ones that talk hang up.
    this.hooks.publish([call.caller.user, call.callee.user], { t: "call.ended", call: call.id, reason });
    const now = this.now();
    const answered = call.answeredAt !== null;
    const record: CallRecord = {
      outcome: answered ? "answered" : reason === "rejected" ? "rejected" : reason === "busy" ? "busy" : "missed",
      video: call.video,
      duration: answered ? Math.round((now - call.answeredAt!) / 1000) : 0,
    };
    const msg = chats.recordCall(this.db, { chatId: call.chat, callId: call.id, caller: call.caller.user, callee: call.callee.user, record, now });
    if (msg) this.hooks.newMessage(msg);
  }
}
