import type { TurnDto } from "@tapalog-messenger/shared";

/**
 * "Check the connection for calls": this browser connects to itself through
 * the server's TURN relay only (never directly), then sends a voice call's
 * worth of small packets for a while and times their echo. It shows whether
 * calls would get through this network even when a direct path fails.
 */

export type Transport = "any" | "udp" | "tcp" | "tls";

export interface CallCheckResult {
  ok: boolean;
  /** How the relay was reached: udp, tcp or tls. */
  transport: string | null;
  /**
   * Median time from this device to the relay and back, in ms. A packet of
   * the check makes that trip twice (out to the relay and back to this same
   * device, then the echo again), so this is half the time it took.
   */
  serverMs: number | null;
  /** Share of packets that did not come back, 0–100. */
  lossPct: number | null;
  /** Why it failed: no relay address of the chosen kind, or the relay could not be reached. */
  error?: "no_address" | "unreachable";
}

/** A packet every 20 ms of 160 bytes: what a voice call sends. */
const PACKET_EVERY_MS = 20;
const PACKET_BYTES = 160;
const CONNECT_TIMEOUT_MS = 15_000;

/** The relay addresses of one kind: turn:…?transport=udp or plain turn: is UDP, ?transport=tcp is TCP, turns: is TLS. */
export function urlsFor(urls: string[], transport: Transport): string[] {
  const kind = (u: string) => (u.startsWith("turns:") ? "tls" : u.includes("transport=tcp") ? "tcp" : "udp");
  return transport === "any" ? urls : urls.filter((u) => kind(u) === transport);
}

const half = (ms: number | null) => (ms === null ? null : Math.round(ms / 2));

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)]!);
}

/** The protocol the chosen pair reached the relay with, from its local (relay) candidate. */
async function relayProtocol(pc: RTCPeerConnection): Promise<string | null> {
  const stats = await pc.getStats();
  const all = [...stats.values()];
  const pairId = all.find((s) => s.type === "transport")?.selectedCandidatePairId;
  // Firefox has no selectedCandidatePairId; it marks the pair itself.
  const pair = (pairId && stats.get(pairId)) || all.find((s) => s.type === "candidate-pair" && s.state === "succeeded" && (s.selected || s.nominated));
  return (pair && stats.get(pair.localCandidateId)?.relayProtocol) ?? null;
}

export async function checkRelay(turn: TurnDto, transport: Transport, seconds: number, onSecond?: (left: number) => void): Promise<CallCheckResult> {
  const iceServers = turn.ice_servers.map((s) => ({ ...s, urls: urlsFor(s.urls, transport) })).filter((s) => s.urls.length > 0);
  if (iceServers.length === 0) return { ok: false, transport: null, serverMs: null, lossPct: null, error: "no_address" };
  const config: RTCConfiguration = { iceServers, iceTransportPolicy: "relay" };
  const a = new RTCPeerConnection(config);
  const b = new RTCPeerConnection(config);
  try {
    a.onicecandidate = (e) => e.candidate && void b.addIceCandidate(e.candidate).catch(() => {});
    b.onicecandidate = (e) => e.candidate && void a.addIceCandidate(e.candidate).catch(() => {});
    // Unordered and never resent, like call audio: a lost packet stays lost.
    const channel = a.createDataChannel("check", { ordered: false, maxRetransmits: 0 });
    b.ondatachannel = (e) => (e.channel.onmessage = (m) => e.channel.send(m.data));

    const opened = new Promise<boolean>((resolve) => {
      channel.onopen = () => resolve(true);
      setTimeout(() => resolve(false), CONNECT_TIMEOUT_MS);
    });
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription!);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription!);
    if (!(await opened)) return { ok: false, transport: null, serverMs: null, lossPct: null, error: "unreachable" };

    const sentAt = new Map<number, number>();
    const rtts: number[] = [];
    channel.onmessage = (m) => {
      const seq = Number(String(m.data).split(":")[0]);
      const t = sentAt.get(seq);
      if (t !== undefined) rtts.push(performance.now() - t);
    };
    const padding = "x".repeat(PACKET_BYTES);
    let seq = 0;
    const timer = setInterval(() => {
      if (channel.readyState !== "open") return;
      sentAt.set(++seq, performance.now());
      channel.send(`${seq}:${padding}`.slice(0, PACKET_BYTES));
    }, PACKET_EVERY_MS);
    for (let left = seconds; left > 0; left--) {
      onSecond?.(left);
      await new Promise((r) => setTimeout(r, 1000));
    }
    clearInterval(timer);
    await new Promise((r) => setTimeout(r, 500)); // the last echoes
    const lossPct = seq === 0 ? 100 : Math.max(0, Math.round((1 - rtts.length / seq) * 1000) / 10);
    return { ok: rtts.length > 0, transport: await relayProtocol(a), serverMs: half(median(rtts)), lossPct, ...(rtts.length === 0 && { error: "unreachable" as const }) };
  } finally {
    a.close();
    b.close();
  }
}
