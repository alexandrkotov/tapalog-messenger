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
      {showVideo && c.local && !c.cameraOff && <Media stream={c.local} video muted class={`call-local${c.facing === "user" ? " mirror" : ""}`} testid="call-local" />}

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
