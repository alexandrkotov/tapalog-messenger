import type { ChatDto, MessageDto } from "@tapalog-messenger/shared";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { fmt } from "../i18n";
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
  sendMessage,
  tickOf,
  typing,
  typingIn,
  useAppState,
  type Pending,
} from "../state";
import { ConnBanner } from "./ChatList";
import { Avatar, clockTime, lastSeenText, Link, Linkified, Ticks, useLang } from "./common";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

type Draft = { mode: "new" } | { mode: "reply"; seq: number } | { mode: "edit"; seq: number };

export function ChatView({ chatId }: { chatId: number }) {
  const { s, lang } = useLang();
  const st = useAppState();
  const chat = st.chats.get(chatId);
  const [draft, setDraft] = useState<Draft>({ mode: "new" });
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    void openChat(chatId);
    setDraft({ mode: "new" });
    setSelected(null);
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

  return (
    <section class="chat-view" data-testid="chat-view" data-chat={chatId}>
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
      <MessageList chat={chat} messages={messages} pending={pending} selected={selected} onSelect={setSelected}>
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
              {m.from === myId() && (
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
  children,
}: {
  chat: ChatDto;
  messages: MessageDto[];
  pending: Pending[];
  selected: number | null;
  onSelect: (seq: number | null) => void;
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
                  {reply.deleted ? s.deleted : reply.body}
                </span>
              )}
              <span class="body" data-testid="message-body">
                {m.deleted ? s.deleted : <Linkified text={m.body} />}
              </span>
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
            <span class="body" data-testid="message-body">
              <Linkified text={p.body} />
            </span>
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

function Composer({ chatId, draft, target, targetName, onDone }: { chatId: number; draft: Draft; target?: MessageDto; targetName: string; onDone: () => void }) {
  const { s } = useLang();
  const [text, setText] = useState(draft.mode === "edit" ? (target?.body ?? "") : "");
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => input.current?.focus(), []);

  const submit = () => {
    const body = text.trim();
    if (!body) return;
    if (draft.mode === "edit") {
      if (body !== target?.body) editMessage(chatId, draft.seq, body);
    } else sendMessage(chatId, body, draft.mode === "reply" ? draft.seq : undefined);
    setText("");
    onDone();
  };

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
            <strong>{draft.mode === "edit" ? s.editing : fmt(s.replyingTo, { name: targetName })}</strong>
            {target && !target.deleted && <span class="quote-text">{target.body}</span>}
          </span>
          <button type="button" class="link" onClick={onDone} aria-label={s.cancel}>
            ✕
          </button>
        </div>
      )}
      <div class="composer-row">
        <textarea
          ref={input}
          rows={1}
          placeholder={s.messagePlaceholder}
          aria-label={s.messagePlaceholder}
          maxLength={10_000}
          value={text}
          onInput={(e) => {
            setText(e.currentTarget.value);
            if (draft.mode !== "edit") typing(chatId);
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
        <button class="primary send" disabled={!text.trim()} aria-label={draft.mode === "edit" ? s.save : s.send}>
          {draft.mode === "edit" ? "✓" : "➤"}
        </button>
      </div>
    </form>
  );
}
