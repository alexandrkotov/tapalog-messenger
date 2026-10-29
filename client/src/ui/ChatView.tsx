import type { ChatDto, MediaDto, MessageDto } from "@tapalog-messenger/shared";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { fmt } from "../i18n";
import { formatDuration, startRecording, type Recording } from "../media";
import {
  chatName,
  deleteMessage,
  discard,
  editMessage,
  loadOlder,
  myId,
  openChat,
  otherMembers,
  react,
  retry,
  sendFiles,
  sendMessage,
  sendVoice,
  tickOf,
  typing,
  typingIn,
  useAppState,
  type Pending,
} from "../state";
import { ConnBanner } from "./ChatList";
import { Avatar, clockTime, errorText, lastSeenText, Link, Linkified, quoteText, Ticks, useLang } from "./common";
import { AttachmentChip, MessageMedia, PendingMedia, PhotoViewer } from "./Media";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

type Draft = { mode: "new" } | { mode: "reply"; seq: number } | { mode: "edit"; seq: number };

export function ChatView({ chatId }: { chatId: number }) {
  const { s, lang } = useLang();
  const st = useAppState();
  const chat = st.chats.get(chatId);
  const [draft, setDraft] = useState<Draft>({ mode: "new" });
  const [selected, setSelected] = useState<number | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const [dropped, setDropped] = useState<File[]>([]);

  useEffect(() => {
    void openChat(chatId);
    setDraft({ mode: "new" });
    setSelected(null);
    setViewing(null);
    setDropped([]);
    return () => void openChat(null);
  }, [chatId]);

  if (!chat) return <section class="chat-view empty-main">{st.chats.size ? s.pickChat : ""}</section>;

  const messages = st.messages.get(chatId) ?? [];
  const pending = st.outbox.filter((p) => p.chat === chatId);
  const name = chatName(chat);
  const other = chat.kind === "direct" ? otherMembers(chat)[0] : undefined;
  const typers = typingIn(chatId);
  const subtitle = typers.length
    ? chat.kind === "group"
      ? fmt(s.typingName, { name: chat.members.find((m) => m.id === typers[0])?.display_name ?? "" })
      : s.typing
    : other
      ? other.online
        ? s.onlineNow
        : lastSeenText(s, other.last_seen_at, lang)
      : fmt(s.members, { n: chat.members.length });
  const byId = (id: number | null) => chat.members.find((m) => m.id === id);
  const bySeq = (seq: number) => messages.find((m) => m.seq === seq);
  const isAdmin = chat.kind === "group" && byId(myId())?.role === "admin";
  const photos = messages.filter((m) => m.kind === "image" && m.media).map((m) => m.media as MediaDto);
  const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");

  return (
    <section
      class="chat-view"
      data-testid="chat-view"
      data-chat={chatId}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => e.relatedTarget === null && setDropping(false)}
      onDrop={(e) => {
        setDropping(false);
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDropped([...(e.dataTransfer?.files ?? [])]);
      }}
    >
      {dropping && <div class="drop-overlay">{s.dropHere}</div>}
      {viewing && <PhotoViewer photos={photos} id={viewing} onClose={() => setViewing(null)} onShow={setViewing} />}
      <header class="bar">
        <Link href="/" class="icon-button back" aria-label={s.back}>
          ←
        </Link>
        <Link href={`/chat/${chatId}/info`} class="chat-title" data-testid="chat-title">
          <Avatar name={name} id={other?.id ?? chat.id} online={other?.online} size={36} />
          <span>
            <strong>{name}</strong>
            <small class={typers.length ? "typing" : ""} data-testid="chat-subtitle">
              {subtitle}
            </small>
          </span>
        </Link>
      </header>
      <ConnBanner inChat />
      <MessageList chat={chat} messages={messages} pending={pending} selected={selected} onSelect={setSelected} onOpenPhoto={setViewing}>
        {(m) =>
          selected === m.seq &&
          !m.deleted && (
            <div class="msg-actions" role="toolbar">
              {QUICK_REACTIONS.map((e) => (
                <button
                  key={e}
                  type="button"
                  class={m.reactions[e]?.includes(myId()) ? "on" : ""}
                  onClick={() => {
                    react(chatId, m.seq, m.reactions[e]?.includes(myId()) ? "" : e);
                    setSelected(null);
                  }}
                >
                  {e}
                </button>
              ))}
              <button type="button" onClick={() => (setDraft({ mode: "reply", seq: m.seq }), setSelected(null))}>
                {s.reply}
              </button>
              {m.from === myId() && m.kind === "text" && (
                <button type="button" onClick={() => (setDraft({ mode: "edit", seq: m.seq }), setSelected(null))}>
                  {s.edit}
                </button>
              )}
              {(m.from === myId() || isAdmin) && (
                <button
                  type="button"
                  class="danger"
                  onClick={() => {
                    if (confirm(s.confirmDelete)) deleteMessage(chatId, m.seq);
                    setSelected(null);
                  }}
                >
                  {s.delete}
                </button>
              )}
            </div>
          )
        }
      </MessageList>
      <Composer
        key={`${chatId}-${draft.mode}-${"seq" in draft ? draft.seq : ""}`}
        chatId={chatId}
        draft={draft}
        target={"seq" in draft ? bySeq(draft.seq) : undefined}
        targetName={"seq" in draft ? (byId(bySeq(draft.seq)?.from ?? null)?.display_name ?? "") : ""}
        onDone={() => setDraft({ mode: "new" })}
        dropped={dropped}
        onTakeDropped={() => setDropped([])}
      />
    </section>
  );
}

function MessageList({
  chat,
  messages,
  pending,
  selected,
  onSelect,
  onOpenPhoto,
  children,
}: {
  chat: ChatDto;
  messages: MessageDto[];
  pending: Pending[];
  selected: number | null;
  onSelect: (seq: number | null) => void;
  onOpenPhoto: (id: string) => void;
  children: (m: MessageDto) => unknown;
}) {
  const { s, lang } = useLang();
  const st = useAppState();
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const lastKey = `${messages.at(-1)?.seq ?? 0}:${pending.length}`;

  // Stay pinned to the newest message unless the reader scrolled up.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [lastKey, chat.id]);

  const byId = (id: number | null) => chat.members.find((m) => m.id === id);
  const bySeq = (seq: number) => messages.find((m) => m.seq === seq);

  return (
    <div
      class="messages"
      ref={ref}
      data-testid="messages"
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {st.older.get(chat.id) && (
        <button type="button" class="link load-older" onClick={() => void loadOlder(chat.id)}>
          {s.loadEarlier}
        </button>
      )}
      {messages.map((m) => {
        const mine = m.from === myId();
        const reply = m.reply_to !== null ? bySeq(m.reply_to) : undefined;
        const reactions = Object.entries(m.reactions);
        return (
          <div key={m.seq} class={`msg-row${mine ? " mine" : ""}`} data-testid="message" data-seq={m.seq}>
            <div class={`bubble${m.deleted ? " deleted" : ""}${selected === m.seq ? " selected" : ""}`} onClick={() => onSelect(selected === m.seq ? null : m.seq)}>
              {chat.kind === "group" && !mine && <span class="sender">{byId(m.from)?.display_name ?? "?"}</span>}
              {reply && (
                <span class="quote">
                  <strong>{byId(reply.from)?.display_name}</strong>
                  {reply.deleted ? s.deleted : quoteText(s, reply)}
                </span>
              )}
              {!m.deleted && <MessageMedia msg={m} onOpenPhoto={onOpenPhoto} />}
              {(m.deleted || m.body) && (
                <span class="body" data-testid="message-body">
                  {m.deleted ? s.deleted : <Linkified text={m.body} />}
                </span>
              )}
              <span class="meta">
                {m.edited_at !== null && !m.deleted && <span>{s.edited}</span>}
                {clockTime(m.at, lang)}
                {mine && !m.deleted && <Ticks tick={tickOf(chat, m.seq)} />}
              </span>
              {reactions.length > 0 && (
                <span class="reactions" data-testid="reactions">
                  {reactions.map(([emoji, users]) => (
                    <span key={emoji} class={users.includes(myId()) ? "on" : ""} title={users.map((u) => byId(u)?.display_name).join(", ")}>
                      {emoji}
                      {users.length > 1 && ` ${users.length}`}
                    </span>
                  ))}
                </span>
              )}
            </div>
            {children(m)}
          </div>
        );
      })}
      {pending.map((p) => (
        <div key={p.client_id} class="msg-row mine" data-testid="message" data-pending="true">
          <div class={`bubble${p.failed ? " failed" : ""}`} onClick={() => p.failed && retry(p.client_id)} title={p.failed ? s.notSent : undefined}>
            {p.file && <PendingMedia kind={p.kind} file={p.file} progress={p.progress} />}
            {p.body && (
              <span class="body" data-testid="message-body">
                <Linkified text={p.body} />
              </span>
            )}
            {p.failed && p.error && (
              <small class="error" role="alert">
                {p.error === "rate_limited" && p.file ? s.uploadLimit : errorText(s, p.error)}
              </small>
            )}
            <span class="meta">
              {clockTime(p.at, lang)}
              <Ticks tick={p.failed ? "failed" : "pending"} />
              {p.failed && (
                <button type="button" class="link" onClick={(e) => (e.stopPropagation(), discard(p.client_id))}>
                  ✕
                </button>
              )}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function Composer({
  chatId,
  draft,
  target,
  targetName,
  onDone,
  dropped,
  onTakeDropped,
}: {
  chatId: number;
  draft: Draft;
  target?: MessageDto;
  targetName: string;
  onDone: () => void;
  dropped: File[];
  onTakeDropped: () => void;
}) {
  const { s } = useLang();
  const [text, setText] = useState(draft.mode === "edit" ? (target?.body ?? "") : "");
  const [files, setFiles] = useState<File[]>([]);
  const [asFiles, setAsFiles] = useState(false);
  const [menu, setMenu] = useState(false);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [, setClock] = useState(0);
  const [notice, setNotice] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const editing = draft.mode === "edit";
  const replyTo = draft.mode === "reply" ? draft.seq : undefined;
  useEffect(() => input.current?.focus(), []);

  useEffect(() => {
    if (!dropped.length || editing) return;
    setFiles((f) => [...f, ...dropped]);
    onTakeDropped();
  }, [dropped]);

  // The recording timer ticks; the recording itself stops on its own at the length limit.
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setClock((n) => n + 1), 250);
    return () => clearInterval(timer);
  }, [recording]);
  useEffect(() => () => recording?.cancel(), [recording]);

  const addFiles = (list: FileList | null) => {
    if (list?.length) setFiles((f) => [...f, ...list]);
    setMenu(false);
  };

  const submit = () => {
    const body = text.trim();
    if (files.length) {
      void sendFiles(chatId, files, body, { asFiles, replyTo });
      setFiles([]);
      setAsFiles(false);
    } else if (!body) return;
    else if (editing) {
      if (body !== target?.body) editMessage(chatId, draft.seq, body);
    } else sendMessage(chatId, body, replyTo);
    setText("");
    onDone();
  };

  const record = async () => {
    setNotice("");
    try {
      const r = await startRecording(() => void finishRecording(r));
      setRecording(r);
    } catch (err) {
      setNotice(err instanceof Error && err.message === "unsupported" ? s.micUnsupported : s.micDenied);
    }
  };

  const finishRecording = async (r: Recording | null = recording) => {
    if (!r) return;
    setRecording(null);
    const out = await r.stop();
    if (out === "silent") setNotice(s.micSilent);
    else if (out) sendVoice(chatId, out, replyTo);
    onDone();
  };

  const cancelRecording = () => {
    recording?.cancel();
    setRecording(null);
  };

  const hasPhotos = files.some((f) => f.type.startsWith("image/"));
  const canSend = Boolean(text.trim() || files.length);

  return (
    <form
      class="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {draft.mode !== "new" && (
        <div class="composer-context">
          <span>
            <strong>{editing ? s.editing : fmt(s.replyingTo, { name: targetName })}</strong>
            {target && !target.deleted && <span class="quote-text">{quoteText(s, target)}</span>}
          </span>
          <button type="button" class="link" onClick={onDone} aria-label={s.cancel}>
            ✕
          </button>
        </div>
      )}
      {files.length > 0 && (
        <div class="attachments">
          <div class="attachment-list">
            {files.map((f, i) => (
              <AttachmentChip key={`${f.name}-${i}`} file={f} onRemove={() => setFiles(files.filter((_, j) => j !== i))} />
            ))}
          </div>
          {hasPhotos && (
            <label class="check">
              <input type="checkbox" checked={asFiles} onChange={(e) => setAsFiles(e.currentTarget.checked)} data-testid="send-as-files" />
              {s.sendAsFiles}
            </label>
          )}
        </div>
      )}
      {notice && (
        <p class="error composer-notice" role="alert">
          {notice}
        </p>
      )}
      <input ref={photoInput} type="file" accept="image/*" multiple hidden onChange={(e) => (addFiles(e.currentTarget.files), (e.currentTarget.value = ""))} data-testid="photo-input" />
      <input ref={fileInput} type="file" multiple hidden onChange={(e) => (addFiles(e.currentTarget.files), (e.currentTarget.value = ""))} data-testid="file-input" />
      {recording ? (
        <div class="composer-row recording" data-testid="recording">
          <button type="button" class="icon-button" onClick={cancelRecording} aria-label={s.cancel} data-testid="record-cancel">
            ✕
          </button>
          <span class="rec-dot" aria-hidden="true" />
          <span class="rec-time">{formatDuration(recording.elapsed() * 1000)}</span>
          <button type="button" class="primary send" onClick={() => void finishRecording()} aria-label={s.stopAndSend} data-testid="record-send">
            ➤
          </button>
        </div>
      ) : (
        <div class="composer-row">
          {!editing && (
            <div class="attach-wrap">
              <button type="button" class="icon-button attach" onClick={() => setMenu(!menu)} aria-label={s.attach} aria-expanded={menu} title={s.attach} data-testid="attach">
                📎
              </button>
              {menu && (
                <div class="attach-menu" role="menu">
                  <button type="button" role="menuitem" onClick={() => photoInput.current?.click()} data-testid="attach-photo">
                    🖼 {s.photo}
                  </button>
                  <button type="button" role="menuitem" onClick={() => fileInput.current?.click()} data-testid="attach-file">
                    📄 {s.file}
                  </button>
                </div>
              )}
            </div>
          )}
          <textarea
            ref={input}
            rows={1}
            placeholder={files.length ? s.captionPlaceholder : s.messagePlaceholder}
            aria-label={s.messagePlaceholder}
            maxLength={10_000}
            value={text}
            onInput={(e) => {
              setText(e.currentTarget.value);
              if (!editing) typing(chatId);
            }}
            onPaste={(e) => {
              const pasted = [...(e.clipboardData?.files ?? [])];
              if (!pasted.length || editing) return;
              e.preventDefault();
              setFiles((f) => [...f, ...pasted]);
            }}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter is a new line (as in WhatsApp Web and Telegram).
              if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                submit();
              }
              if (e.key === "Escape" && draft.mode !== "new") onDone();
            }}
          />
          {canSend || editing ? (
            <button class="primary send" disabled={!canSend} aria-label={editing ? s.save : s.send}>
              {editing ? "✓" : "➤"}
            </button>
          ) : (
            <button type="button" class="primary send" onClick={() => void record()} aria-label={s.recordVoice} title={s.recordVoice} data-testid="record">
              🎤
            </button>
          )}
        </div>
      )}
    </form>
  );
}
