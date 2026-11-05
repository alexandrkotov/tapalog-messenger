import { useEffect, useRef, useState } from "preact/hooks";
import { answer, decline, hangUp, reconnect, setMinimized, switchCamera, toggleCamera, toggleMute, useCall, type CallInfo } from "../call";
import { fmt } from "../i18n";
import { formatDuration } from "../media";
import { chatName, chatPhoto, useAppState } from "../state";
import { Avatar, useLang } from "./common";

/** A <video> or <audio> showing a stream; set again whenever the stream object changes. */
function Media({ stream, video, muted, class: cls, testid }: { stream: MediaStream | null; video: boolean; muted?: boolean; class?: string; testid: string }) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || el.srcObject === stream) return;
    el.srcObject = stream;
    if (stream) void el.play().catch(() => {});
  }, [stream]);
  return video ? <video ref={ref} class={cls} autoplay playsInline muted={muted} data-testid={testid} /> : <audio ref={ref} autoplay data-testid={testid} />;
}

const SPOT_KEY = "callSelfSpot";
const share = (n: number) => Math.min(1, Math.max(0, n));

/** Where the person last put their own picture: shares of the free room across and down, so it stays put when the phone turns. Null: the corner. */
function savedSpot(): { x: number; y: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(SPOT_KEY) ?? "null");
    return typeof v?.x === "number" && typeof v?.y === "number" ? { x: share(v.x), y: share(v.y) } : null;
  } catch {
    return null;
  }
}

/** One's own picture, small. A finger moves it anywhere on the screen; it stays there for later calls on this device. */
function SelfView({ stream, mirror }: { stream: MediaStream; mirror: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [spot, setSpot] = useState(savedSpot);
  const grab = useRef<{ dx: number; dy: number; spot: { x: number; y: number } | null } | null>(null);

  const onMove = (e: PointerEvent) => {
    const el = ref.current;
    const room = el?.parentElement?.getBoundingClientRect();
    if (!el || !room || !grab.current) return;
    const freeX = room.width - el.offsetWidth;
    const freeY = room.height - el.offsetHeight;
    const next = {
      x: freeX > 0 ? share((e.clientX - grab.current.dx - room.left) / freeX) : 0,
      y: freeY > 0 ? share((e.clientY - grab.current.dy - room.top) / freeY) : 0,
    };
    grab.current.spot = next;
    setSpot(next);
  };
  const onUp = () => {
    const done = grab.current?.spot;
    grab.current = null;
    if (!done) return;
    try {
      localStorage.setItem(SPOT_KEY, JSON.stringify(done));
    } catch {
      // Private mode: it stays put for this call only.
    }
  };

  const at = spot && {
    left: `calc(${spot.x} * (100% - var(--self-w)))`,
    top: `calc(${spot.y} * (100% - var(--self-h)))`,
    right: "auto",
    bottom: "auto",
  };
  return (
    <div
      ref={ref}
      class="call-local"
      style={at ?? undefined}
      data-testid="call-self"
      onPointerDown={(e) => {
        const box = ref.current!.getBoundingClientRect();
        grab.current = { dx: e.clientX - box.left, dy: e.clientY - box.top, spot: null };
        ref.current!.setPointerCapture(e.pointerId);
        e.preventDefault();
      }}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      <Media stream={stream} video muted class={mirror ? "mirror" : undefined} testid="call-local" />
    </div>
  );
}

/** Seconds since the call connected, ticking. */
function useElapsed(since: number | null): string {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (since === null) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return since === null ? "" : formatDuration(Date.now() - since);
}

/** The call over everything else: ringing, talking, or just ended; or a bar above the chats while the person looks at something else. */
export function CallScreen() {
  const c = useCall();
  const { s } = useLang();
  const st = useAppState();
  const [details, setDetails] = useState(false);
  const elapsed = useElapsed(c?.since ?? null);
  if (!c) return null;

  const chat = st.chats.get(c.chat);
  const name = chat ? chatName(chat, s) : "";
  const status = statusText(c, s, elapsed);
  const talking = c.phase !== "incoming" && c.phase !== "ended";

  if (c.minimized && talking) {
    return (
      <button type="button" class="call-bar" data-testid="call-bar" onClick={() => setMinimized(false)}>
        <span>{s.callInProgress}</span>
        <span>{elapsed}</span>
      </button>
    );
  }

  const showVideo = c.video && c.phase !== "ended";
  const remoteVideo = showVideo && (c.remote?.getVideoTracks().length ?? 0) > 0;
  return (
    <div class={`call-screen${showVideo ? " video" : ""}`} role="dialog" aria-label={status} data-testid="call-screen" data-phase={c.phase} data-call={c.id}>
      {showVideo && <Media stream={c.remote} video class="call-remote" testid="call-remote" />}
      {!showVideo && <Media stream={c.phase === "ended" ? null : c.remote} video={false} testid="call-remote" />}
      {showVideo && c.local && !c.cameraOff && (
        <div class="call-self-room">
          <SelfView stream={c.local} mirror={c.facing === "user"} />
        </div>
      )}

      <div class="call-top">
        {talking && (
          <button type="button" class="icon-button" aria-label={s.toChatsDuringCall} title={s.toChatsDuringCall} data-testid="call-minimize" onClick={() => setMinimized(true)}>
            ←
          </button>
        )}
        {talking && c.since !== null && (
          <button type="button" class={`icon-button${details ? " on" : ""}`} aria-label={s.callDetails} title={s.callDetails} data-testid="call-details" onClick={() => setDetails(!details)}>
            i
          </button>
        )}
      </div>

      {!remoteVideo && (
        <div class="call-who">
          <Avatar name={name} id={c.peer} photo={chat ? chatPhoto(chat) : null} size={96} />
          <strong>{name}</strong>
        </div>
      )}
      {remoteVideo && <strong class="call-name">{name}</strong>}
      <p class="call-status" role="status" data-testid="call-status" data-reason={c.ended ?? ""}>
        {status}
      </p>
      {c.mediaError && (
        <p class="call-media-error" data-testid="call-media-error">
          {c.mediaError}
        </p>
      )}
      {details && c.stats && talking && <Details c={c} />}
      {c.stuck && talking && (
        <button type="button" class="call-again" data-testid="call-again" onClick={reconnect}>
          {s.connectAgain}
        </button>
      )}

      <div class="call-controls">
        {c.phase === "incoming" ? (
          <>
            <button type="button" class="call-button hang-up" aria-label={s.decline} title={s.decline} data-testid="call-decline" onClick={decline}>
              ✕
            </button>
            <button type="button" class="call-button pick-up" aria-label={s.answer} title={s.answer} data-testid="call-answer" onClick={() => void answer()}>
              {c.video ? "📹" : "📞"}
            </button>
          </>
        ) : c.phase === "ended" ? (
          <button type="button" class="call-button" aria-label={s.close} title={s.close} onClick={hangUp}>
            ✕
          </button>
        ) : (
          <>
            <button
              type="button"
              class={`call-button${c.muted ? " off" : ""}`}
              aria-label={c.muted ? s.unmute : s.mute}
              title={c.muted ? s.unmute : s.mute}
              aria-pressed={c.muted}
              data-testid="call-mute"
              onClick={toggleMute}
            >
              {c.muted ? "🔇" : "🎙️"}
            </button>
            {c.video && c.local?.getVideoTracks().length ? (
              <>
                <button
                  type="button"
                  class={`call-button${c.cameraOff ? " off" : ""}`}
                  aria-label={c.cameraOff ? s.cameraOn : s.cameraOff}
                  title={c.cameraOff ? s.cameraOn : s.cameraOff}
                  aria-pressed={c.cameraOff}
                  data-testid="call-camera"
                  onClick={toggleCamera}
                >
                  {c.cameraOff ? "🚫" : "📷"}
                </button>
                <button type="button" class="call-button" aria-label={s.switchCamera} title={s.switchCamera} data-testid="call-switch-camera" onClick={() => void switchCamera()}>
                  🔄
                </button>
              </>
            ) : null}
            <button type="button" class="call-button hang-up" aria-label={s.hangUp} title={s.hangUp} data-testid="call-hang-up" onClick={hangUp}>
              ✕
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function statusText(c: CallInfo, s: ReturnType<typeof useLang>["s"], elapsed: string): string {
  if (c.phase === "ended") return s[`callEnded_${c.ended ?? "ended"}`];
  if (c.phase === "incoming") return c.video ? s.incomingVideoCall : s.incomingCall;
  if (c.phase === "outgoing") return s.calling;
  if (c.reconnecting) return s.reconnectingCall;
  if (c.phase === "connecting" || c.since === null) return s.connectingCall;
  return elapsed;
}

function Details({ c }: { c: CallInfo }) {
  const { s } = useLang();
  const st = c.stats!;
  const route = st.route === "direct" ? s.callRouteDirect : st.route.startsWith("relay") ? fmt(s.callRouteRelay, { how: st.route.slice(6).toUpperCase() || "?" }) : "…";
  return (
    <ul class="call-details" data-testid="call-details-list" data-route={st.route}>
      <li>{route}</li>
      {st.rttMs !== null && <li>{fmt(s.callRtt, { ms: st.rttMs })}</li>}
      {st.lossPct !== null && <li>{fmt(s.callLoss, { loss: st.lossPct })}</li>}
      {st.kbps !== null && <li>{fmt(s.callSpeed, { kbps: st.kbps })}</li>}
      {c.fellBack && <li class="hint">{s.callSwitchedToRelay}</li>}
    </ul>
  );
}
