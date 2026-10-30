import type { CallEndReason, CallSignal, ErrorCode, ServerFrame, TurnDto } from "@tapalog-messenger/shared";
import { useEffect, useState } from "preact/hooks";
import { api } from "./api";
import { urlsFor } from "./callCheck";
import { sendCallFrame } from "./state";

/**
 * Calls, one at a time. The server rings and passes WebRTC's messages
 * between the two tabs; voice and video go straight between the devices
 * when they can reach each other, else through the server's TURN relay.
 *
 * A network that loses or delays UDP (some mobile networks, towards abroad)
 * makes a call break up while it stays "connected". So the quality is
 * watched, and after a few bad seconds over UDP both sides start the
 * connection again through the relay over TLS, which such networks let
 * through. A connection that drops is restarted (ICE restart); if it does
 * not come back, the screen offers to connect again.
 */

export type CallPhase = "outgoing" | "incoming" | "connecting" | "active" | "ended";

export interface CallStats {
  /** "direct", or the relay and how this device reaches it: "relay udp", "relay tcp", "relay tls". */
  route: string;
  rttMs: number | null;
  lossPct: number | null;
  kbps: number | null;
}

export interface CallInfo {
  id: string;
  chat: number;
  peer: number;
  video: boolean;
  outgoing: boolean;
  phase: CallPhase;
  /** When the two first heard each other. */
  since: number | null;
  /** The connection dropped and is being restored. */
  reconnecting: boolean;
  /** Not back for a while: the screen offers to connect again. */
  stuck: boolean;
  muted: boolean;
  cameraOff: boolean;
  facing: "user" | "environment";
  local: MediaStream | null;
  remote: MediaStream | null;
  /** Going through the relay over TLS, by choice or after UDP broke up. */
  relay: boolean;
  /** Moved to the relay by itself, because the network lost or held up too much. */
  fellBack: boolean;
  stats: CallStats | null;
  /** Shown over the chats, as a bar. */
  minimized: boolean;
  /** Why it ended, shown for a moment. */
  ended: CallEndReason | "no_media" | null;
}

/** How this device connects calls: "auto" tries direct first; "relay" always goes through the server over TLS. */
export type CallRoute = "auto" | "relay";
const ROUTE_KEY = "callRoute";

export function callRoute(): CallRoute {
  try {
    return localStorage.getItem(ROUTE_KEY) === "relay" ? "relay" : "auto";
  } catch {
    return "auto";
  }
}

export function setCallRoute(route: CallRoute) {
  try {
    localStorage.setItem(ROUTE_KEY, route);
  } catch {
    // private mode: the choice lasts until the page closes
  }
}

/** How long an incoming call rings here if the server's word that it ended never comes (it rings 45 s there). */
const RING_LOCAL_MS = 50_000;
/** A connection that dropped gets this long to come back by itself before it is restarted. */
const RESTART_AFTER_MS = 3000;
/** Not connected for this long: offer "Connect again". */
const STUCK_AFTER_MS = 15_000;
/** Seconds in a row with this much loss or delay over UDP before switching to the relay over TLS. */
const BAD_SECONDS = 6;
const BAD_LOSS_PCT = 10;
const BAD_RTT_MS = 1000;
/** Ended calls stay on screen this long. */
const ENDED_SHOWN_MS = 2000;
/** Video: 640×480 at up to ~800 kbit/s is enough for a face on a phone and gets through weak networks. */
const VIDEO_MAX_BITRATE = 800_000;

export const calls = { current: null as CallInfo | null };

const listeners = new Set<() => void>();
function changed() {
  listeners.forEach((l) => l());
}

export function useCall(): CallInfo | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    const l = () => setTick((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return calls.current;
}

// ---- The connection --------------------------------------------------------

let pc: RTCPeerConnection | null = null;
/** How many times this call's connection was started afresh; signals of older ones are dropped. */
let gen = 0;
/** Perfect negotiation: the person called gives way when both offer at once. */
let polite = false;
let makingOffer = false;
let ignoreOffer = false;
/** Signals are handled one by one, in order, after the connection they belong to exists. */
let chain: Promise<unknown> = Promise.resolve();
let turn: TurnDto | null = null;

const timers = { ring: 0, restart: 0, stuck: 0, stats: 0, ended: 0, tone: 0 };
function stopTimer(name: keyof typeof timers) {
  clearTimeout(timers[name]);
  clearInterval(timers[name]);
  timers[name] = 0;
}

/** Sends one of WebRTC's messages to the other side, marked with the current start. */
function signal(data: object) {
  const c = calls.current;
  if (c) sendCallFrame({ t: "call.signal", call: c.id, data: { ...data, gen } as CallSignal });
}

async function turnServers(): Promise<TurnDto | null> {
  // Fetched afresh when about to expire; none at all when the server has no relay.
  if (turn && turn.expires_at - Date.now() > 60_000) return turn;
  turn = await api<TurnDto>("GET", "/turn").catch(() => null);
  return turn;
}

async function iceConfig(relay: boolean): Promise<RTCConfiguration> {
  const t = await turnServers();
  if (!t) return { iceServers: [] };
  if (relay) {
    const only = (kind: "tls" | "tcp") => t.ice_servers.map((s) => ({ ...s, urls: urlsFor(s.urls, kind) })).filter((s) => s.urls.length > 0);
    // TLS looks like any secure website to the network; plain TCP if the server has no TLS address.
    const servers = only("tls").length ? only("tls") : only("tcp");
    if (servers.length) return { iceServers: servers, iceTransportPolicy: "relay" };
  }
  return { iceServers: t.ice_servers, iceTransportPolicy: "all" };
}

/** Starts (or starts again) the connection with the other side, sending this device's microphone and camera. */
async function startPeer(c: CallInfo) {
  pc?.close();
  const conn = new RTCPeerConnection(await iceConfig(c.relay));
  if (calls.current !== c) return conn.close();
  pc = conn;
  makingOffer = false;
  ignoreOffer = false;
  c.remote = null;
  conn.ontrack = (e) => {
    if (pc !== conn) return;
    const stream = c.remote ?? new MediaStream();
    stream.addTrack(e.track);
    // A new object, so the screen sets it on its <video> again.
    c.remote = new MediaStream(stream.getTracks());
    changed();
  };
  conn.onicecandidate = (e) => pc === conn && signal({ candidate: e.candidate ? e.candidate.toJSON() : null });
  conn.onnegotiationneeded = async () => {
    try {
      makingOffer = true;
      await conn.setLocalDescription();
      if (pc === conn) signal({ description: conn.localDescription!.toJSON() });
    } catch {
      // a newer start replaced this connection
    } finally {
      makingOffer = false;
    }
  };
  conn.oniceconnectionstatechange = () => pc === conn && watchIce(c, conn);
  for (const track of c.local?.getTracks() ?? []) conn.addTrack(track, c.local!);
  preferVp8(conn);
  stopTimer("stuck");
  timers.stuck = window.setTimeout(() => calls.current === c && c.since === null && ((c.stuck = true), changed()), STUCK_AFTER_MS);
}

/** VP8 first: every browser has it, and it costs a phone less than the others. */
function preferVp8(conn: RTCPeerConnection) {
  const codecs = RTCRtpReceiver.getCapabilities?.("video")?.codecs;
  if (!codecs) return;
  const sorted = [...codecs.filter((x) => x.mimeType === "video/VP8"), ...codecs.filter((x) => x.mimeType !== "video/VP8")];
  for (const t of conn.getTransceivers()) {
    if (t.sender.track?.kind !== "video") continue;
    try {
      t.setCodecPreferences(sorted);
    } catch {
      // an older browser: its own order
    }
  }
}

async function capVideo(conn: RTCPeerConnection) {
  for (const sender of conn.getSenders()) {
    if (sender.track?.kind !== "video") continue;
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0]!.maxBitrate = VIDEO_MAX_BITRATE;
    await sender.setParameters(params).catch(() => {});
  }
}

function watchIce(c: CallInfo, conn: RTCPeerConnection) {
  const ice = conn.iceConnectionState;
  if (ice === "connected" || ice === "completed") {
    stopTimer("restart");
    stopTimer("stuck");
    if (c.since === null) {
      c.since = Date.now();
      void capVideo(conn);
      startStats(c);
    }
    c.phase = "active";
    c.reconnecting = c.stuck = false;
    return changed();
  }
  if (ice !== "disconnected" && ice !== "failed") return;
  c.reconnecting = c.since !== null;
  changed();
  // "failed" will not come back by itself; "disconnected" often does, in a moment.
  if (!timers.restart) timers.restart = window.setTimeout(() => (stopTimer("restart"), conn.restartIce()), ice === "failed" ? 0 : RESTART_AFTER_MS);
  if (!timers.stuck) timers.stuck = window.setTimeout(() => calls.current === c && ((c.stuck = true), changed()), STUCK_AFTER_MS);
}

/** Starts the connection afresh on both sides; with `relay`, through the server over TLS only. */
function reset(c: CallInfo, relay: boolean) {
  gen += 1;
  c.relay = relay;
  c.stuck = false;
  c.reconnecting = c.since !== null;
  signal({ reset: { relay } });
  chain = chain.then(() => startPeer(c)).catch(() => {});
  changed();
}

/** "Connect again": through the relay, the way most likely to work. */
export function reconnect() {
  const c = calls.current;
  if (c && pc) reset(c, true);
}

async function onSignal(c: CallInfo, data: CallSignal) {
  if ("reset" in data) {
    if (data.gen <= gen) return; // both started again at once: one fresh start is enough
    gen = data.gen;
    if (data.reset.relay && !c.relay && c.since !== null) c.fellBack = true;
    c.relay ||= data.reset.relay;
    return startPeer(c);
  }
  const conn = pc;
  if (!conn || data.gen !== gen) return;
  if ("description" in data) {
    const offer = data.description.type === "offer";
    const collision = offer && (makingOffer || conn.signalingState !== "stable");
    ignoreOffer = !polite && collision;
    if (ignoreOffer) return;
    await conn.setRemoteDescription(data.description as RTCSessionDescriptionInit);
    if (offer) {
      await conn.setLocalDescription();
      signal({ description: conn.localDescription!.toJSON() });
    }
    return;
  }
  try {
    await conn.addIceCandidate(data.candidate ?? undefined);
  } catch {
    // a candidate of an offer that was ignored, or of an older start
  }
}

// ---- Quality ---------------------------------------------------------------

let badFor = 0;
let lastAudio = { lost: 0, received: 0, bytes: 0, at: 0 };

function startStats(c: CallInfo) {
  badFor = 0;
  lastAudio = { lost: 0, received: 0, bytes: 0, at: 0 };
  stopTimer("stats");
  timers.stats = window.setInterval(() => void measure(c), 1000);
}

async function measure(c: CallInfo) {
  const conn = pc;
  if (!conn || calls.current !== c) return;
  const stats = await conn.getStats().catch(() => null);
  if (!stats) return;
  const all = [...stats.values()];
  const pairId = all.find((s) => s.type === "transport")?.selectedCandidatePairId;
  // Firefox has no selectedCandidatePairId; it marks the pair itself.
  const pair = (pairId && stats.get(pairId)) || all.find((s) => s.type === "candidate-pair" && s.state === "succeeded" && (s.selected || s.nominated));
  const local = pair && stats.get(pair.localCandidateId);
  const remote = pair && stats.get(pair.remoteCandidateId);
  const inbound = all.filter((s) => s.type === "inbound-rtp");
  const audio = inbound.find((s) => s.kind === "audio");
  const bytes = inbound.reduce((sum, s) => sum + (s.bytesReceived ?? 0), 0);
  const rtt = pair?.currentRoundTripTime ?? all.find((s) => s.type === "remote-inbound-rtp")?.roundTripTime;

  const now = performance.now();
  const lost = (audio?.packetsLost ?? 0) - lastAudio.lost;
  const received = (audio?.packetsReceived ?? 0) - lastAudio.received;
  const lossPct = lastAudio.at && lost + received > 0 ? Math.max(0, Math.round((lost / (lost + received)) * 100)) : null;
  const kbps = lastAudio.at ? Math.round(((bytes - lastAudio.bytes) * 8) / (now - lastAudio.at)) : null;
  lastAudio = { lost: audio?.packetsLost ?? 0, received: audio?.packetsReceived ?? 0, bytes, at: now };

  const viaRelay = local?.candidateType === "relay";
  const route = viaRelay ? `relay ${local.relayProtocol ?? local.protocol ?? ""}`.trim() : remote?.candidateType === "relay" ? "relay" : local ? "direct" : "";
  const rttMs = typeof rtt === "number" ? Math.round(rtt * 1000) : null;
  c.stats = { route, rttMs, lossPct, kbps };

  const overUdp = local?.protocol === "udp" && (!viaRelay || (local.relayProtocol ?? "udp") === "udp");
  const bad = (lossPct ?? 0) > BAD_LOSS_PCT || (rttMs ?? 0) > BAD_RTT_MS;
  badFor = overUdp && bad && !c.relay && !c.reconnecting ? badFor + 1 : 0;
  if (badFor >= BAD_SECONDS && turn) {
    badFor = 0;
    c.fellBack = true;
    reset(c, true);
  }
  changed();
}

// ---- Sounds and the screen staying on --------------------------------------

let audioCtx: AudioContext | null = null;
// Browsers let a page make sound only after a tap; the first tap anywhere unlocks it for the ringtone later.
addEventListener("pointerdown", () => void unlockAudio(), { once: true });
async function unlockAudio() {
  try {
    audioCtx ??= new AudioContext();
    if (audioCtx.state === "suspended") await audioCtx.resume();
  } catch {
    audioCtx = null;
  }
}

function beep(freq: number, at: number, seconds: number) {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(0.15, at + 0.02);
  gain.gain.setValueAtTime(0.15, at + seconds - 0.05);
  gain.gain.linearRampToValueAtTime(0, at + seconds);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(at);
  osc.stop(at + seconds);
}

/** The ringtone of an incoming call, or the long tones the caller hears while it rings. */
function tone(kind: "ring" | "ringback" | null) {
  stopTimer("tone");
  navigator.vibrate?.(0);
  if (!kind) return;
  const play = () => {
    void unlockAudio().then(() => {
      const t = audioCtx?.currentTime ?? 0;
      if (kind === "ringback") beep(425, t, 1);
      else for (let i = 0; i < 4; i++) beep(i % 2 ? 660 : 880, t + i * 0.2, 0.18);
    });
    if (kind === "ring") navigator.vibrate?.([400, 200, 400]);
  };
  play();
  timers.tone = window.setInterval(play, kind === "ring" ? 2500 : 4000);
}

let wakeLock: WakeLockSentinel | null = null;
async function keepAwake(on: boolean) {
  if (!on) {
    void wakeLock?.release().catch(() => {});
    wakeLock = null;
    return;
  }
  if (wakeLock || document.visibilityState !== "visible") return;
  wakeLock = await navigator.wakeLock?.request("screen").catch(() => null) ?? null;
  wakeLock?.addEventListener("release", () => (wakeLock = null));
}
// The lock goes when the page is hidden; it comes back with the page if the call goes on.
document.addEventListener("visibilitychange", () => calls.current && calls.current.phase !== "ended" && void keepAwake(true));

// ---- Media -----------------------------------------------------------------

async function openMedia(video: boolean, facing: "user" | "environment"): Promise<{ stream: MediaStream; cameraOff: boolean } | null> {
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const camera = { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } };
  try {
    return { stream: await navigator.mediaDevices.getUserMedia({ audio, video: video && camera }), cameraOff: false };
  } catch {
    if (!video) return null;
  }
  // No camera, or it is busy: a video call still works with voice only from this side.
  const stream = await navigator.mediaDevices.getUserMedia({ audio }).catch(() => null);
  return stream && { stream, cameraOff: true };
}

// ---- Actions ---------------------------------------------------------------

function blank(id: string, chat: number, peer: number, video: boolean, outgoing: boolean): CallInfo {
  return {
    id,
    chat,
    peer,
    video,
    outgoing,
    phase: outgoing ? "outgoing" : "incoming",
    since: null,
    reconnecting: false,
    stuck: false,
    muted: false,
    cameraOff: false,
    facing: "user",
    local: null,
    remote: null,
    relay: callRoute() === "relay",
    fellBack: false,
    stats: null,
    minimized: false,
    ended: null,
  };
}

/** The call was hung up, or another one took its place, while waiting for something. */
const over = (c: CallInfo) => calls.current !== c || c.phase === "ended";

function fresh() {
  gen = 0;
  chain = Promise.resolve();
  badFor = 0;
}

export async function startCall(chat: number, peer: number, video: boolean) {
  if (calls.current) return;
  void unlockAudio();
  const c = blank(crypto.randomUUID(), chat, peer, video, true);
  fresh();
  polite = false;
  calls.current = c;
  changed();
  // The microphone (and camera) first: the browser asks for them before anything rings.
  const media = await openMedia(video, c.facing);
  if (over(c)) return media?.stream.getTracks().forEach((t) => t.stop());
  if (!media) return finish(c, "no_media");
  c.local = media.stream;
  c.cameraOff = media.cameraOff;
  if (!sendCallFrame({ t: "call.invite", call: c.id, chat, video })) return finish(c, "failed");
  void turnServers();
  tone("ringback");
  void keepAwake(true);
  changed();
}

export async function answer() {
  const c = calls.current;
  if (!c || c.phase !== "incoming") return;
  tone(null);
  c.phase = "connecting";
  changed();
  const media = await openMedia(c.video, c.facing);
  if (over(c)) return media?.stream.getTracks().forEach((t) => t.stop());
  if (!media) {
    sendCallFrame({ t: "call.reject", call: c.id });
    return finish(c, "no_media");
  }
  c.local = media.stream;
  c.cameraOff = media.cameraOff;
  stopTimer("ring");
  polite = true;
  // Accepted first: until then the server passes nothing from this tab to the caller.
  sendCallFrame({ t: "call.accept", call: c.id });
  chain = chain.then(() => startPeer(c)).catch(() => {});
  void keepAwake(true);
  changed();
}

export function decline() {
  const c = calls.current;
  if (!c || c.phase !== "incoming") return;
  sendCallFrame({ t: "call.reject", call: c.id });
  finish(c, "rejected");
}

export function hangUp() {
  const c = calls.current;
  if (!c) return;
  if (c.phase === "ended") return close(c);
  sendCallFrame({ t: "call.end", call: c.id });
  finish(c, c.since === null && c.outgoing ? "cancelled" : "ended");
}

export function toggleMute() {
  const c = calls.current;
  if (!c?.local) return;
  c.muted = !c.muted;
  for (const t of c.local.getAudioTracks()) t.enabled = !c.muted;
  changed();
}

export function toggleCamera() {
  const c = calls.current;
  const track = c?.local?.getVideoTracks()[0];
  if (!c || !track) return;
  c.cameraOff = !c.cameraOff;
  track.enabled = !c.cameraOff;
  changed();
}

/** Front camera to back and back again (phones). */
export async function switchCamera() {
  const c = calls.current;
  const old = c?.local?.getVideoTracks()[0];
  if (!c || !old) return;
  const facing = c.facing === "user" ? "environment" : "user";
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: facing }, width: { ideal: 640 }, height: { ideal: 480 } } }).catch(() => null);
  const track = stream?.getVideoTracks()[0];
  if (!track || calls.current !== c) return track?.stop();
  // Phones open one camera at a time.
  old.stop();
  track.enabled = !c.cameraOff;
  await pc
    ?.getSenders()
    .find((s) => s.track === old || s.track?.kind === "video")
    ?.replaceTrack(track)
    .catch(() => {});
  c.local!.removeTrack(old);
  c.local!.addTrack(track);
  c.local = new MediaStream(c.local!.getTracks());
  c.facing = facing;
  changed();
}

export function setMinimized(minimized: boolean) {
  if (!calls.current) return;
  calls.current.minimized = minimized;
  changed();
}

/** Stops everything this call holds and shows how it ended for a moment. */
function finish(c: CallInfo, reason: CallInfo["ended"]) {
  if (calls.current !== c || c.phase === "ended") return;
  tone(null);
  void keepAwake(false);
  for (const name of ["ring", "restart", "stuck", "stats"] as const) stopTimer(name);
  pc?.close();
  pc = null;
  c.local?.getTracks().forEach((t) => t.stop());
  c.phase = "ended";
  c.ended = reason;
  c.minimized = false;
  changed();
  timers.ended = window.setTimeout(() => close(c), ENDED_SHOWN_MS);
}

function close(c: CallInfo) {
  stopTimer("ended");
  if (calls.current !== c) return;
  calls.current = null;
  changed();
}

// ---- From the server -------------------------------------------------------

export function onCallFrame(f: ServerFrame) {
  const c = calls.current;
  switch (f.t) {
    case "call.ring": {
      if (c?.id === f.call) return;
      // Busy here (another tab of mine called someone): the server rings only when I am free, so this is rare.
      if (c && c.phase !== "ended") return;
      if (c) close(c);
      const ring = blank(f.call, f.chat, f.from, f.video, false);
      fresh();
      calls.current = ring;
      tone("ring");
      timers.ring = window.setTimeout(() => calls.current === ring && ring.phase === "incoming" && finish(ring, "missed"), RING_LOCAL_MS);
      void turnServers();
      return changed();
    }
    case "call.accepted":
      if (c?.id !== f.call || c.phase !== "outgoing") return;
      tone(null);
      c.phase = "connecting";
      chain = chain.then(() => startPeer(c)).catch(() => {});
      return changed();
    case "call.taken":
      // Answered on another device of mine.
      if (c?.id === f.call && c.phase === "incoming") {
        tone(null);
        stopTimer("ring");
        close(c);
      }
      return;
    case "call.ended":
      if (c?.id === f.call) finish(c, f.reason);
      return;
    case "call.signal":
      if (c?.id !== f.call || c.phase === "ended") return;
      chain = chain.then(() => onSignal(c, f.data)).catch(() => {});
      return;
  }
}

/** The server refused something about the call (rate limit, a chat with no one to call). */
export function onCallError(ref: string, code: ErrorCode) {
  const c = calls.current;
  if (c?.id === ref) finish(c, code === "rate_limited" ? "busy" : "failed");
}

/** Back online in the middle of a call: tells the server this tab is still in it. */
export function resumeCall() {
  const c = calls.current;
  if (c && c.phase !== "incoming" && c.phase !== "ended") sendCallFrame({ t: "call.resume", call: c.id });
}
