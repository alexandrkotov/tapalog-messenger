import type { MediaDto, MessageDto, MessageKind } from "@tapalog-messenger/shared";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { formatDuration, formatSize, type Outgoing } from "../media";
import { useLang } from "./common";

/** A blob: URL for as long as the component shows it. */
export function useObjectUrl(blob: Blob | undefined): string | undefined {
  const url = useMemo(() => (blob ? URL.createObjectURL(blob) : undefined), [blob]);
  useEffect(() => () => url && URL.revokeObjectURL(url), [url]);
  return url;
}

const PHOTO_MAX_W = 280;
const PHOTO_MAX_H = 360;

/** The photo's frame at its own proportions, so the feed does not jump when the picture loads. */
function photoBox(width: number | null | undefined, height: number | null | undefined) {
  if (!width || !height) return { width: `${PHOTO_MAX_W}px`, minHeight: "120px" };
  const k = Math.min(1, PHOTO_MAX_W / width, PHOTO_MAX_H / height);
  return { width: `${Math.max(80, Math.round(width * k))}px`, aspectRatio: `${width} / ${height}` };
}

/** What a sent message carries besides text, as the feed shows it. */
export function MessageMedia({ msg, onOpenPhoto }: { msg: MessageDto; onOpenPhoto: (id: string) => void }) {
  const m = msg.media;
  if (!m) return null;
  if (msg.kind === "image") {
    return (
      <button type="button" class="photo" style={photoBox(m.width, m.height)} onClick={(e) => (e.stopPropagation(), onOpenPhoto(m.id))} data-testid="photo">
        <img src={`/media/${m.id}${m.thumb ? "/thumb" : ""}`} alt="" loading="lazy" decoding="async" />
      </button>
    );
  }
  if (msg.kind === "voice") return <VoicePlayer src={`/media/${m.id}`} durationMs={m.duration_ms} waveform={m.waveform} />;
  return <FileCard name={m.name} size={m.size} href={`/media/${m.id}?download`} />;
}

/** The same for a message still on its way: shown from the file on this device, with upload progress. */
export function PendingMedia({ kind, file, progress }: { kind: MessageKind; file: Outgoing; progress?: number }) {
  const url = useObjectUrl(kind === "image" ? (file.thumb ?? file.blob) : undefined);
  const bar = progress !== undefined && (
    <span class="upload-progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} data-testid="upload-progress">
      <span style={{ width: `${Math.round(progress * 100)}%` }} />
    </span>
  );
  if (kind === "image") {
    return (
      <span class="photo pending" style={photoBox(file.width, file.height)}>
        {url && <img src={url} alt="" />}
        {bar}
      </span>
    );
  }
  return (
    <>
      {kind === "voice" ? <VoicePlayer durationMs={file.duration_ms ?? null} waveform={file.waveform ?? null} /> : <FileCard name={file.name} size={file.blob.size} />}
      {bar}
    </>
  );
}

function FileCard({ name, size, href }: { name: string; size: number; href?: string }) {
  const { lang, s } = useLang();
  const body = (
    <>
      <span class="file-icon" aria-hidden="true">
        📄
      </span>
      <span class="file-text">
        <span class="file-name">{name}</span>
        <small>{formatSize(size, lang)}</small>
      </span>
    </>
  );
  return href ? (
    <a class="file-card" href={href} download={name} onClick={(e) => e.stopPropagation()} title={s.download} data-testid="file-card">
      {body}
    </a>
  ) : (
    <span class="file-card" data-testid="file-card">
      {body}
    </span>
  );
}

/** Only one voice message plays at a time. */
let playing: HTMLAudioElement | null = null;

function VoicePlayer({ src, durationMs, waveform }: { src?: string; durationMs: number | null; waveform: number[] | null }) {
  const { s } = useLang();
  const audio = useRef<HTMLAudioElement>(null);
  const [on, setOn] = useState(false);
  const [at, setAt] = useState(0);
  const total = (durationMs ?? 0) / 1000;
  const levels = waveform?.length ? waveform : Array.from({ length: 40 }, () => 30);
  const share = total ? Math.min(1, at / total) : 0;

  const toggle = (e: Event) => {
    e.stopPropagation();
    const el = audio.current;
    if (!el) return;
    if (el.paused) {
      if (playing && playing !== el) playing.pause();
      playing = el;
      void el.play();
    } else el.pause();
  };

  const seek = (e: MouseEvent) => {
    e.stopPropagation();
    const el = audio.current;
    if (!el || !total) return;
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    el.currentTime = ((e.clientX - box.left) / box.width) * total;
    setAt(el.currentTime);
  };

  return (
    <span class="voice" data-testid="voice">
      {src && (
        <audio
          ref={audio}
          src={src}
          preload="none"
          onPlay={() => setOn(true)}
          onPause={() => setOn(false)}
          onEnded={() => (setOn(false), setAt(0))}
          onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
          data-testid="voice-audio"
        />
      )}
      <button type="button" class="voice-play" onClick={toggle} disabled={!src} aria-label={on ? s.pause : s.play} data-testid="voice-play">
        {on ? "❚❚" : "▶"}
      </button>
      <span class="waveform" onClick={seek} aria-hidden="true">
        {levels.map((v, i) => (
          <span key={i} class={i / levels.length < share ? "played" : ""} style={{ height: `${Math.max(12, v)}%` }} />
        ))}
      </span>
      <small class="voice-time">{formatDuration((on || at ? at : total) * 1000)}</small>
    </span>
  );
}

/** Full-screen photo with the chat's other photos a swipe or an arrow away. */
export function PhotoViewer({ photos, id, onClose, onShow }: { photos: MediaDto[]; id: string; onClose: () => void; onShow: (id: string) => void }) {
  const { s } = useLang();
  const i = photos.findIndex((p) => p.id === id);
  const photo = photos[i];
  const prev = photos[i - 1];
  const next = photos[i + 1];
  const touchX = useRef<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && prev) onShow(prev.id);
      if (e.key === "ArrowRight" && next) onShow(next.id);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [prev, next]);

  if (!photo) return null;
  return (
    <div
      class="viewer"
      role="dialog"
      aria-modal="true"
      aria-label={s.photo}
      data-testid="viewer"
      onClick={onClose}
      onTouchStart={(e) => (touchX.current = e.touches[0]?.clientX ?? null)}
      onTouchEnd={(e) => {
        const from = touchX.current;
        const to = e.changedTouches[0]?.clientX;
        if (from === null || to === undefined || Math.abs(to - from) < 50) return;
        const target = to < from ? next : prev;
        if (target) onShow(target.id);
      }}
    >
      <div class="viewer-bar" onClick={(e) => e.stopPropagation()}>
        <a class="icon-button" href={`/media/${photo.id}?download`} download={photo.name} aria-label={s.download} title={s.download}>
          ⤓
        </a>
        <button type="button" class="icon-button" onClick={onClose} aria-label={s.close} title={s.close}>
          ✕
        </button>
      </div>
      {prev && (
        <button type="button" class="viewer-nav prev" onClick={(e) => (e.stopPropagation(), onShow(prev.id))} aria-label={s.previous}>
          ‹
        </button>
      )}
      <img src={`/media/${photo.id}`} alt="" onClick={(e) => e.stopPropagation()} data-testid="viewer-photo" />
      {next && (
        <button type="button" class="viewer-nav next" onClick={(e) => (e.stopPropagation(), onShow(next.id))} aria-label={s.next}>
          ›
        </button>
      )}
    </div>
  );
}

/** A chosen file in the composer before sending: a little preview for a photo, the name for anything else. */
export function AttachmentChip({ file, onRemove }: { file: File; onRemove: () => void }) {
  const { s } = useLang();
  const url = useObjectUrl(file.type.startsWith("image/") ? file : undefined);
  return (
    <span class="attachment" data-testid="attachment">
      {url ? <img src={url} alt="" /> : <span class="attachment-name">📄 {file.name}</span>}
      <button type="button" class="attachment-remove" onClick={onRemove} aria-label={s.removeAttachment}>
        ✕
      </button>
    </span>
  );
}
