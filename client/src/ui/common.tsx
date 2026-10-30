import { createContext, type ComponentChildren } from "preact";
import { useContext } from "preact/hooks";
import { fmt, t, type Lang, type Strings } from "../i18n";
import { navigate } from "../router";
import { fold, type CallRecord, type MessageKind } from "@tapalog-messenger/shared";
import { myId, type Tick } from "../state";

export const LangContext = createContext<{ lang: Lang; s: Strings; setLang: (l: Lang) => void }>({ lang: "en", s: t("en"), setLang: () => {} });
export const useLang = () => useContext(LangContext);
export const useS = () => useContext(LangContext).s;

/** Today: 14:05. This week: Tue. Older: 12.10.26 (in the reader's language). */
export function shortTime(ms: number, lang: Lang): string {
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
  if (now.getTime() - ms < 6 * 24 * 3600 * 1000) return d.toLocaleDateString(lang, { weekday: "short" });
  return d.toLocaleDateString(lang, { day: "2-digit", month: "2-digit", year: "2-digit" });
}

export function clockTime(ms: number, lang: Lang): string {
  return new Date(ms).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
}

export function lastSeenText(s: Strings, ms: number | null, lang: Lang): string {
  if (ms === null) return "";
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = sameDay ? clockTime(ms, lang) : d.toLocaleString(lang, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return fmt(s.lastSeen, { time });
}

const HUES = [160, 200, 260, 330, 20, 40, 100];

/** A round photo, or the first letter on a colour picked by id when there is none (or it cannot load, offline say). */
export function Avatar({ name, id, photo, online, size = 40 }: { name: string; id: number; photo?: string | null; online?: boolean; size?: number }) {
  const letter = [...name.trim()][0]?.toUpperCase() ?? "?";
  return (
    <span class="avatar" style={{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.42)}px`, background: `hsl(${HUES[id % HUES.length]} 45% 45%)` }} aria-hidden="true">
      {letter}
      {photo && <img src={`/media/${photo}/thumb`} alt="" data-testid="avatar-photo" onError={(e) => (e.currentTarget.hidden = true)} />}
      {online && <span class="avatar-online" />}
    </span>
  );
}

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;

/** Message text with links made clickable. Everything else stays plain text: no HTML from messages, ever. */
export function Linkified({ text }: { text: string }) {
  const parts: ComponentChildren[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <a href={m[0]} target="_blank" rel="noopener noreferrer">
        {m[0]}
      </a>,
    );
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

export function Ticks({ tick }: { tick: Tick }) {
  const label = { pending: "🕓", failed: "!", sent: "✓", delivered: "✓✓", read: "✓✓" }[tick];
  return (
    <span class={`ticks ticks-${tick}`} data-testid="ticks" data-tick={tick} aria-label={tick}>
      {label}
    </span>
  );
}

export function Link({ href, children, class: cls, ...rest }: { href: string; children: ComponentChildren; class?: string; [k: string]: unknown }) {
  return (
    <a
      href={href}
      class={cls}
      {...rest}
      onClick={(e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;
        e.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}

export function errorText(s: Strings, code: string): string {
  const key = `err_${code}` as keyof Strings;
  return key in s ? s[key] : s.err_generic;
}

/** One line standing for a message in a quote or the chat list: its text, or what it carries. */
export function quoteText(s: Strings, m: { kind: MessageKind; body: string; media?: { name: string } | null; from?: number | null; call?: CallRecord }): string {
  if (m.kind === "text") return m.body;
  if (m.kind === "call") return m.call ? callText(s, m.call, m.from === myId()) : "📞";
  const what = m.kind === "image" ? `📷 ${s.photo}` : m.kind === "voice" ? `🎤 ${s.voiceMessage}` : `📄 ${m.media?.name ?? s.file}`;
  return m.body ? `${what}: ${m.body}` : what;
}

/** A call's record as the reader sees it: "📞 Outgoing call · 2:31", "📹 Missed call". */
export function callText(s: Strings, call: CallRecord, mine: boolean): string {
  const words = {
    answered: mine ? s.callOut : s.callIn,
    missed: mine ? s.callNoAnswer : s.callMissed,
    rejected: mine ? s.callDeclinedByThem : s.callDeclinedByMe,
    busy: mine ? s.callBusy : s.callMissed,
  }[call.outcome];
  const long = call.outcome === "answered" ? ` · ${Math.floor(call.duration / 60)}:${String(call.duration % 60).padStart(2, "0")}` : "";
  return `${call.video ? "📹" : "📞"} ${words}${long}`;
}

/** The words a search looks for, folded the way the server folds them. */
export const searchWords = (q: string) => [...new Set(fold(q).split(/\s+/).filter(Boolean))];

/** `text` with every place one of `words` occurs marked, matched the way search matches. */
export function Highlighted({ text, words }: { text: string; words: string[] }) {
  // Folded a character at a time, so positions in it are positions in `text`.
  const folded = Array.from({ length: text.length }, (_, i) => {
    const f = fold(text[i]!);
    return f.length === 1 ? f : text[i]!;
  }).join("");
  const marked = new Array<boolean>(text.length).fill(false);
  for (const w of words) for (let at = folded.indexOf(w); at >= 0; at = folded.indexOf(w, at + 1)) marked.fill(true, at, at + w.length);
  const parts: ComponentChildren[] = [];
  for (let i = 0; i < text.length; ) {
    let j = i;
    while (j < text.length && marked[j] === marked[i]) j++;
    parts.push(marked[i] ? <mark key={i}>{text.slice(i, j)}</mark> : text.slice(i, j));
    i = j;
  }
  return <>{parts}</>;
}
