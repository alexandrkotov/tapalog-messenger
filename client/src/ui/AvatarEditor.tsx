import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError } from "../api";
import type { Crop } from "../media";
import { setAvatar } from "../state";
import { Avatar, errorText, useLang } from "./common";
import { useObjectUrl } from "./Media";

/** A profile or group photo with "Change photo" and "Remove photo" under it. */
export function AvatarEditor({ name, id, photo, target, size = 96 }: { name: string; id: number; photo: string | null; target: "me" | { chat: number }; size?: number }) {
  const { s } = useLang();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [chosen, setChosen] = useState<File | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const run = async (file: File | null, crop?: Crop) => {
    setBusy(true);
    setNote("");
    try {
      if ((await setAvatar(target, file, crop)) === "unreadable") setNote(s.photoUnreadable);
    } catch (err) {
      setNote(errorText(s, err instanceof ApiError ? err.code : "generic"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="avatar-editor">
      <Avatar name={name} id={id} photo={photo} size={size} />
      <span class="row-actions">
        <button type="button" class="link" disabled={busy} onClick={() => input.current?.click()} data-testid="change-photo">
          {s.changePhoto}
        </button>
        {photo && (
          <button type="button" class="link danger" disabled={busy} onClick={() => void run(null)} data-testid="remove-photo">
            {s.removePhoto}
          </button>
        )}
      </span>
      {note && (
        <small class="error" role="alert">
          {note}
        </small>
      )}
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        data-testid="avatar-input"
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          if (file) {
            setNote("");
            setChosen(file);
          }
        }}
      />
      {chosen && (
        <AvatarCrop
          file={chosen}
          onCancel={() => setChosen(null)}
          onUnreadable={() => (setChosen(null), setNote(s.photoUnreadable))}
          onSave={(crop) => {
            setChosen(null);
            void run(chosen, crop);
          }}
        />
      )}
    </div>
  );
}

/** The frame the picture is moved in, in CSS px. */
const FRAME = 280;
const MAX_ZOOM = 4;

/** How the picture lies in the frame: its zoom, and where its top left corner is. */
interface View {
  zoom: number;
  x: number;
  y: number;
}

/**
 * Choosing the part of a picture that goes in the circle: drag it, zoom it
 * with the slider, the mouse wheel or two fingers. The picture always covers
 * the whole frame.
 */
function AvatarCrop({ file, onCancel, onSave, onUnreadable }: { file: File; onCancel: () => void; onSave: (crop: Crop) => void; onUnreadable: () => void }) {
  const { s } = useLang();
  const url = useObjectUrl(file);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 });
  const frame = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Smallest zoom: the short side of the picture fills the frame.
  const base = size ? FRAME / Math.min(size.w, size.h) : 1;
  const shown = (zoom: number) => ({ w: (size?.w ?? 0) * base * zoom, h: (size?.h ?? 0) * base * zoom });
  const clamp = (v: View): View => {
    const { w, h } = shown(v.zoom);
    return { zoom: v.zoom, x: Math.min(0, Math.max(FRAME - w, v.x)), y: Math.min(0, Math.max(FRAME - h, v.y)) };
  };
  /** Zooms to `zoom`, keeping the point (cx, cy) of the frame where it is. */
  const zoomTo = (v: View, zoom: number, cx = FRAME / 2, cy = FRAME / 2): View => {
    const z = Math.min(MAX_ZOOM, Math.max(1, zoom));
    const k = z / v.zoom;
    return clamp({ zoom: z, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k });
  };
  /** A point of the page in the frame's own coordinates. */
  const local = (p: { x: number; y: number }) => {
    const r = frame.current!.getBoundingClientRect();
    return { x: p.x - r.left, y: p.y - r.top };
  };

  const onMove = (e: PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const next = { x: e.clientX, y: e.clientY };
    const other = [...pointers.current].find(([id]) => id !== e.pointerId)?.[1];
    pointers.current.set(e.pointerId, next);
    if (!other) {
      setView((v) => clamp({ zoom: v.zoom, x: v.x + next.x - prev.x, y: v.y + next.y - prev.y }));
      return;
    }
    // Two fingers: zoom around the point between them.
    const before = Math.hypot(prev.x - other.x, prev.y - other.y);
    const after = Math.hypot(next.x - other.x, next.y - other.y);
    if (before < 1) return;
    const mid = local({ x: (next.x + other.x) / 2, y: (next.y + other.y) / 2 });
    setView((v) => zoomTo(v, (v.zoom * after) / before, mid.x, mid.y));
  };
  const onUp = (e: PointerEvent) => pointers.current.delete(e.pointerId);

  const { w, h } = shown(view.zoom);
  return (
    <div class="crop-dialog" role="dialog" aria-modal="true" aria-label={s.cropTitle} data-testid="avatar-crop">
      <div class="crop-panel">
        <strong>{s.cropTitle}</strong>
        <div
          ref={frame}
          class="crop-frame"
          style={{ width: `${FRAME}px`, height: `${FRAME}px` }}
          data-testid="crop-frame"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          }}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onWheel={(e) => {
            e.preventDefault();
            const at = local({ x: e.clientX, y: e.clientY });
            setView((v) => zoomTo(v, v.zoom * Math.exp(-e.deltaY / 300), at.x, at.y));
          }}
        >
          <img
            src={url}
            alt=""
            draggable={false}
            style={size ? { width: `${w}px`, height: `${h}px`, transform: `translate(${view.x}px, ${view.y}px)` } : { visibility: "hidden" }}
            onLoad={(e) => {
              const img = e.currentTarget;
              if (!img.naturalWidth || !img.naturalHeight) return onUnreadable();
              const k = FRAME / Math.min(img.naturalWidth, img.naturalHeight);
              setSize({ w: img.naturalWidth, h: img.naturalHeight });
              setView({ zoom: 1, x: (FRAME - img.naturalWidth * k) / 2, y: (FRAME - img.naturalHeight * k) / 2 });
            }}
            onError={onUnreadable}
          />
          <div class="crop-ring" />
        </div>
        <input
          type="range"
          min={1}
          max={MAX_ZOOM}
          step={0.01}
          value={view.zoom}
          aria-label={s.zoom}
          data-testid="crop-zoom"
          onInput={(e) => {
            const zoom = Number(e.currentTarget.value);
            setView((v) => zoomTo(v, zoom));
          }}
        />
        <small class="hint">{s.cropHint}</small>
        <span class="row-actions">
          <button type="button" onClick={onCancel}>
            {s.cancel}
          </button>
          <button
            type="button"
            class="primary"
            disabled={!size}
            data-testid="crop-save"
            onClick={() => onSave({ x: -view.x / w, y: -view.y / h, w: FRAME / w, h: FRAME / h })}
          >
            {s.save}
          </button>
        </span>
      </div>
    </div>
  );
}
