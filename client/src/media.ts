import { INLINE_IMAGE_TYPES, LIMITS, type ErrorCode, type MediaDto } from "@tapalog-messenger/shared";
import { ApiError } from "./api";

/**
 * Photos, files and voice on the client. The server never decodes a picture
 * or a sound, so everything it needs to show them — size, preview, length,
 * loudness bar — is worked out here before the upload.
 */

/** A file waiting to be uploaded, with what the server will be told about it. */
export interface Outgoing {
  blob: Blob;
  name: string;
  width?: number;
  height?: number;
  duration_ms?: number;
  waveform?: number[];
  /** A small preview of a photo, uploaded after it. */
  thumb?: Blob;
}

const PHOTO_SIDE = 2560;
// Shown up to 280 CSS px wide, which a phone draws with two or three device pixels each.
const THUMB_SIDE = 640;

function fit(w: number, h: number, max: number): [number, number] {
  const k = Math.min(1, max / Math.max(w, h));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Draws the picture at a size and encodes it as WebP, or as JPEG where the
 * browser cannot write WebP: Safari quietly hands back a PNG instead.
 */
async function encode(bitmap: ImageBitmap, max: number, quality: number): Promise<{ blob: Blob; width: number; height: number }> {
  const [width, height] = fit(bitmap.width, bitmap.height, max);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d")!;
  // JPEG has no transparency: a PNG with see-through parts would turn black.
  g.fillStyle = "#fff";
  g.fillRect(0, 0, width, height);
  g.drawImage(bitmap, 0, 0, width, height);
  let blob = await toBlob(canvas, "image/webp", quality);
  if (!blob || blob.type !== "image/webp") blob = await toBlob(canvas, "image/jpeg", quality);
  if (!blob) throw new Error("The picture could not be encoded.");
  return { blob, width, height };
}

/**
 * A photo ready to send: at most 2560 px on the long side, re-encoded (which
 * also drops EXIF, location included), plus a 640 px preview. The camera's
 * rotation is applied first. Null when the browser cannot read the picture
 * (HEIC outside Safari, say): it then goes as a file.
 */
export async function preparePhoto(file: Blob, name: string): Promise<Outgoing | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return null;
  }
  try {
    const thumb = await encode(bitmap, THUMB_SIDE, 0.7);
    // An animated GIF would lose its animation; it goes as it is.
    if (file.type === "image/gif") return { blob: file, name, width: bitmap.width, height: bitmap.height, thumb: thumb.blob };
    const photo = await encode(bitmap, PHOTO_SIDE, 0.8);
    const ext = photo.blob.type === "image/webp" ? "webp" : "jpg";
    return { blob: photo.blob, name: name.replace(/\.[^.]*$/, "") + `.${ext}`, width: photo.width, height: photo.height, thumb: thumb.blob };
  } finally {
    bitmap.close();
  }
}

/** Whether a file chosen as a photo can be shown as one. */
export const isPhotoType = (type: string) => (INLINE_IMAGE_TYPES as readonly string[]).includes(type) || type === "image/heic" || type === "image/heif";

/**
 * Sends a file to POST /api/media, reporting progress (fetch cannot report
 * upload progress, XMLHttpRequest can), then its preview if it has one.
 */
export function upload(out: Outgoing, onProgress: (share: number) => void, signal?: AbortSignal): Promise<MediaDto> {
  const q = new URLSearchParams({ name: out.name });
  if (out.width) q.set("width", String(out.width));
  if (out.height) q.set("height", String(out.height));
  if (out.duration_ms) q.set("duration_ms", String(Math.round(out.duration_ms)));
  if (out.waveform) q.set("waveform", out.waveform.join(","));
  return new Promise<MediaDto>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/media?${q}`);
    xhr.setRequestHeader("Content-Type", out.blob.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data: unknown = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // an error page from something in between
      }
      if (xhr.status === 201) resolve(data as MediaDto);
      else reject(new ApiError(((data as { error?: ErrorCode } | null)?.error ?? "bad_request") as ErrorCode, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError("network", 0));
    xhr.onabort = () => reject(new ApiError("network", 0));
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(out.blob);
  }).then(async (media) => {
    if (!out.thumb) return media;
    const res = await fetch(`/api/media/${media.id}/thumb`, { method: "PUT", body: out.thumb, headers: { "Content-Type": out.thumb.type } }).catch(() => null);
    // A photo without its preview still works: the full picture is shown instead.
    return res?.ok ? ((await res.json()) as MediaDto) : media;
  });
}

export const tooLarge = (blob: Blob) => blob.size > LIMITS.fileBytes;

export function formatSize(bytes: number, lang: string): string {
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toLocaleString(lang, { maximumFractionDigits: i === 0 || n >= 10 ? 0 : 1 })} ${units[i]}`;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

// ---- Voice -----------------------------------------------------------------

/** The first format this browser records in. Chrome and Firefox do Opus; Safari may only do AAC in MP4. */
export function recordingType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const type of ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"]) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

/** Squeezes loudness samples into at most `points` levels from 0 to 100, loudest at 100. */
export function waveformOf(samples: number[], points: number = LIMITS.waveformPoints): number[] {
  if (samples.length === 0) return [];
  const n = Math.min(points, samples.length);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * samples.length) / n);
    const to = Math.max(from + 1, Math.floor(((i + 1) * samples.length) / n));
    out.push(Math.max(...samples.slice(from, to)));
  }
  const peak = Math.max(...out) || 1;
  return out.map((v) => Math.round((v / peak) * 100));
}

export interface Recording {
  /** Seconds so far, for the timer. */
  elapsed(): number;
  /** Stops and hands back the recording; null if it was too short to keep. */
  stop(): Promise<Outgoing | null>;
  cancel(): void;
}

/**
 * Starts recording from the microphone, measuring loudness ten times a
 * second for the bar under the play button. Throws if the microphone is
 * missing or not allowed.
 */
export async function startRecording(onLimit: () => void): Promise<Recording> {
  const type = recordingType();
  if (type === null) throw new Error("unsupported");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  const audio = new AudioContext();
  const analyser = audio.createAnalyser();
  analyser.fftSize = 1024;
  audio.createMediaStreamSource(stream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const samples: number[] = [];
  const meter = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    samples.push(Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length));
  }, 100);

  const started = performance.now();
  const limit = setTimeout(onLimit, LIMITS.voiceMs);
  recorder.start(1000);

  const release = () => {
    clearInterval(meter);
    clearTimeout(limit);
    stream.getTracks().forEach((t) => t.stop());
    void audio.close();
  };

  return {
    elapsed: () => (performance.now() - started) / 1000,
    stop() {
      const duration = performance.now() - started;
      return new Promise((resolve) => {
        recorder.onstop = () => {
          release();
          if (duration < 700 || chunks.length === 0) return resolve(null);
          const blob = new Blob(chunks, { type: (recorder.mimeType || type || "audio/webm").split(";")[0] });
          const ext = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
          resolve({ blob, name: `voice.${ext}`, duration_ms: duration, waveform: waveformOf(samples) });
        };
        recorder.stop();
      });
    },
    cancel() {
      recorder.onstop = release;
      recorder.stop();
    },
  };
}
