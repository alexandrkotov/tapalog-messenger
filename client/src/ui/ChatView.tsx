import { LIMITS, type ChatDto, type MediaDto, type MessageDto, type SearchHit } from "@tapalog-messenger/shared";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api, ApiError } from "../api";
import { fmt } from "../i18n";
import { formatDuration, startRecording, type Recording } from "../media";
import {
  chatName,
  chatPhoto,
  deleteMessage,
  discard,
  editMessage,
  jumpTo,
  loadNewer,
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
  toLatest,
  typing,
  typingIn,
  useAppState,
  type Pending,
} from "../state";
import { ConnBanner, SEARCH_DELAY_MS } from "./ChatList";
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
  const [searching, setSearching] = useState(false);
  /** The search hit being shown, marked until the search is closed. */
  const [hit, setHit] = useState<number | null>(null);

  useEffect(() => {
    void openChat(chatId);
    setDraft({ mode: "new" });
    setSelected(null);
    setViewing(null);
    setDropped([]);
    setSearching(false);
    setHit(null);
    return () => void openChat(null);
  }, [chatId]);

  if (!chat) return <section class="chat-view empty-main">{st.chats.size ? s.pickChat : ""}</section>;

  const messages = st.messages.get(chatId) ?? [];
  const pending = st.outbox.filter((p) => p.chat === chatId);
  const name = chatName(chat, s);
  const other = chat.kind === "direct" ? otherMembers(chat)[0] : undefined;
  const typers = typingIn(chatId);
  const subtitle = chat.peer_deleted
    ? ""
    : typers.length
      ? chat.kind === "group"
        ? fmt(s.typingName, { name: chat.members.find((m) => m.id === typers[0])?.display_name ?? "" })
        : s.typing
      : other
        ? other.online
          ? s.onlineNow
          : lastSeenText(s, other.last_seen_at, lang)
        : fmt(s.members, { n: chat.members.length });
  const byId = (id: number | null) => chat.members.find((m) => m.id === id);
  const nameOf = (id: number | null | undefined) => (id === null ? s.deletedAccount : byId(id ?? -1)?.display_name);
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
          <Avatar name={name} id={other?.id ?? chat.id} photo={chatPhoto(chat)} online={other?.online} size={36} />
          <span>
            <strong>
              {name}
              {chat.muted && (
                <span class="muted-mark" title={s.mutedChat} aria-label={s.mutedChat} data-testid="muted">
                  {" "}
                  🔕
                </span>
              )}
            </strong>
            <small class={typers.length ? "typing" : ""} data-testid="chat-subtitle">
              {subtitle}
            </small>
          </span>
        </Link>
        <button
          type="button"
          class={`icon-button${searching ? " on" : ""}`}
          aria-label={s.searchChat}
          title={s.searchChat}
          aria-expanded={searching}
          data-testid="chat-search"
          onClick={() => (setSearching(!searching), setHit(null))}
        >
          🔍
        </button>
      </header>
      {searching && <ChatSearch chatId={chatId} onShow={setHit} onClose={() => (setSearching(false), setHit(null))} />}
      <ConnBanner inChat />
      <MessageList chat={chat} messages={messages} pending={pending} selected={selected} hit={hit} onSelect={setSelected} onOpenPhoto={setViewing}>
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
      {chat.peer_deleted ? (
        <p class="hint composer-closed" data-testid="peer-deleted">
          {s.peerDeleted}
        </p>
      ) : (
        <Composer
          key={`${chatId}-${draft.mode}-${"seq" in draft ? draft.seq : ""}`}
          chatId={chatId}
          draft={draft}
          target={"seq" in draft ? bySeq(draft.seq) : undefined}
          targetName={"seq" in draft ? (nameOf(bySeq(draft.seq)?.from) ?? "") : ""}
          onDone={() => setDraft({ mode: "new" })}
          dropped={dropped}
          onTakeDropped={() => setDropped([])}
        />
      )}
    </section>
  );
}

/** Search in this chat: the newest hit first, arrows to older and newer ones, each scrolled to and marked. */
function ChatSearch({ chatId, onShow, onClose }: { chatId: number; onShow: (seq: number | null) => void; onClose: () => void }) {
  const { s } = useLang();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [all, setAll] = useState(false);
  const [i, setI] = useState(0);
  const [problem, setProblem] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const fetchPage = (after?: SearchHit) =>
    api<SearchHit[]>("GET", `/search?q=${encodeURIComponent(q.trim())}&chat=${chatId}${after ? `&before=${after.at}:${after.chat}:${after.seq}` : ""}`);

  const show = (list: SearchHit[], k: number) => {
    setI(k);
    onShow(list[k]?.seq ?? null);
    if (list[k]) void jumpTo(chatId, list[k].seq).catch(() => {});
  };

  useEffect(() => {
    setHits(null);
    setProblem("");
    onShow(null);
    if (!q.trim()) return;
    let live = true;
    const timer = setTimeout(() => {
      fetchPage()
        .then((page) => {
          if (!live) return;
          setHits(page);
          setAll(page.length < LIMITS.searchPage);
          show(page, 0);
        })
        .catch((e) => live && setProblem(errorText(s, e instanceof ApiError ? e.code : "generic")));
    }, SEARCH_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q]);

  const older = async () => {
    if (!hits) return;
    if (i + 1 < hits.length) return show(hits, i + 1);
    if (all) return;
    const page = await fetchPage(hits.at(-1)).catch(() => null);
    if (!page) return;
    const list = [...hits, ...page];
    setHits(list);
    setAll(page.length < LIMITS.searchPage);
    if (page.length) show(list, i + 1);
  };
  const newer = () => hits && i > 0 && show(hits, i - 1);

  const status = problem || (hits === null ? "" : hits.length === 0 ? s.nothingFound : fmt(s.foundCount, { i: i + 1, n: `${hits.length}${all ? "" : "+"}` }));
  return (
    <div class="chat-search" role="search">
      <input
        ref={input}
        class="search"
        type="search"
        placeholder={s.searchChat}
        aria-label={s.searchChat}
        value={q}
        data-testid="chat-search-input"
        onInput={(e) => setQ(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          else if (e.key === "Enter") {
            e.preventDefault();
            void (e.shiftKey ? newer() : older());
          }
        }}
      />
      <small class="chat-search-status" role="status" data-testid="chat-search-status">
        {status}
      </small>
      <button type="button" class="icon-button" aria-label={s.prevFound} title={s.prevFound} data-testid="found-older" disabled={!hits || (all && i + 1 >= hits.length)} onClick={() => void older()}>
        ↑
      </button>
      <button type="button" class="icon-button" aria-label={s.nextFound} title={s.nextFound} data-testid="found-newer" disabled={!hits || i === 0} onClick={() => void newer()}>
        ↓
      </button>
      <button type="button" class="icon-button" aria-label={s.closeSearch} title={s.closeSearch} onClick={onClose}>
        ✕
      </button>
    </div>
  );
}

function MessageList({
  chat,
  messages,
  pending,
  selected,
  hit,
  onSelect,
  onOpenPhoto,
  children,
}: {
  chat: ChatDto;
  messages: MessageDto[];
  pending: Pending[];
  selected: number | null;
  /** A search hit to keep marked. */
  hit: number | null;
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

  // A message asked for (a search hit, or the newest after leaving older history): scrolled to, and flashed if found.
  const focus = st.focus?.chat === chat.id ? st.focus : null;
  useLayoutEffect(() => {
    const row = focus && ref.current?.querySelector<HTMLElement>(`[data-seq="${focus.seq}"]`);
    if (!focus || !row) return;
    st.focus = null;
    row.scrollIntoView({ block: focus.flash ? "center" : "end" });
    atBottom.current = !focus.flash;
    if (focus.flash) {
      const color = getComputedStyle(row).getPropertyValue("--accent").trim();
      row.querySelector(".bubble")?.animate([{ outline: `3px solid ${color}` }, { outline: "3px solid transparent" }], { duration: 2000, easing: "ease-in" });
    }
  }, [focus?.n, messages]);

  const newer = st.newer.get(chat.id) ?? false;

  const byId = (id: number | null) => chat.members.find((m) => m.id === id);
  const nameOf = (id: number | null) => (id === null ? s.deletedAccount : byId(id)?.display_name);
  const bySeq = (seq: number) => messages.find((m) => m.seq === seq);

  return (
    <div
      class="messages"
      ref={ref}
      data-testid="messages"
      onScroll={(e) => {
        const el = e.currentTarget;
        const left = el.scrollHeight - el.scrollTop - el.clientHeight;
        // Below what is loaded there is more: nothing to stay pinned to; near the end, the next page comes.
        atBottom.current = !newer && left < 40;
        if (newer && left < 300) void loadNewer(chat.id).catch(() => {});
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
          <div key={m.seq} class={`msg-row${mine ? " mine" : ""}${hit === m.seq ? " hit" : ""}`} data-testid="message" data-seq={m.seq} data-hit={hit === m.seq || undefined}>
            <div class={`bubble${m.deleted ? " deleted" : ""}${selected === m.seq ? " selected" : ""}`} onClick={() => onSelect(selected === m.seq ? null : m.seq)}>
              {chat.kind === "group" && !mine && <span class="sender">{nameOf(m.from) ?? "?"}</span>}
              {reply && (
                <span class="quote">
                  <strong>{nameOf(reply.from)}</strong>
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
      {newer && (
        <>
          <button type="button" class="link load-older" onClick={() => void loadNewer(chat.id).catch(() => {})}>
            {s.loadLater}
          </button>
          <button type="button" class="to-latest" aria-label={s.toLatest} title={s.toLatest} data-testid="to-latest" onClick={() => void toLatest(chat.id).catch(() => {})}>
            ↓
          </button>
        </>
      )}
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
