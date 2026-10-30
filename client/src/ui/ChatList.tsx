import { LIMITS, type SearchHit } from "@tapalog-messenger/shared";
import { useEffect, useState } from "preact/hooks";
import { api, ApiError } from "../api";
import { match, navigate, usePath } from "../router";
import { chatActivity, chatName, chatPhoto, jumpTo, myId, otherMembers, tickOf, typingIn, useAppState } from "../state";
import { Avatar, errorText, Highlighted, Link, quoteText, searchWords, shortTime, Ticks, useLang } from "./common";

export function ChatList() {
  const { s, lang } = useLang();
  const st = useAppState();
  const path = usePath();
  // The chat open on the right, its info page included, stays marked here.
  const current = Number((match("/chat/:id", path) ?? match("/chat/:id/info", path))?.id);
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const chats = [...st.chats.values()]
    .filter((c) => !query || chatName(c, s).toLowerCase().includes(query) || otherMembers(c).some((m) => m.username.includes(query)))
    .sort((a, b) => chatActivity(b) - chatActivity(a) || b.id - a.id);

  return (
    <nav class="chat-list" aria-label={s.chats}>
      <header class="bar">
        <h1 class="brand">{s.chats}</h1>
        <Link href="/new" class="icon-button" aria-label={s.newChat} title={s.newChat} data-testid="new-chat">
          ✎
        </Link>
        <Link href="/settings" class="icon-button" aria-label={s.settings} title={s.settings} data-testid="settings">
          ⚙
        </Link>
      </header>
      <ConnBanner />
      <input class="search" type="search" placeholder={s.search} aria-label={s.search} value={q} onInput={(e) => setQ(e.currentTarget.value)} />
      <div class="chat-list-scroll">
      {chats.length === 0 && !query && <p class="empty">{s.noChats}</p>}
      <ul>
        {chats.map((chat) => {
          const name = chatName(chat, s);
          const other = chat.kind === "direct" ? otherMembers(chat)[0] : undefined;
          const typers = typingIn(chat.id);
          const pending = st.outbox.filter((p) => p.chat === chat.id).at(-1);
          const last = chat.last_message;
          const fromMe = pending || (last && last.from === myId());
          const sender = chat.kind === "group" && last && !fromMe ? (last.from === null ? s.deletedAccount : chat.members.find((m) => m.id === last.from)?.display_name) : undefined;
          const preview = pending
            ? quoteText(s, { kind: pending.kind, body: pending.body, media: pending.file })
            : last
              ? last.deleted
                ? s.deleted
                : quoteText(s, last)
              : "";
          return (
            <li key={chat.id}>
              <Link href={`/chat/${chat.id}`} class={`chat-row${current === chat.id ? " active" : ""}`} data-testid="chat-row" data-chat={chat.id}>
                <Avatar name={name} id={other?.id ?? chat.id} photo={chatPhoto(chat)} online={other?.online} />
                <span class="chat-row-main">
                  <span class="chat-row-top">
                    <span class="chat-row-name">{name}</span>
                    {chat.muted && (
                      <span class="muted-mark" title={s.mutedChat} aria-label={s.mutedChat} data-testid="muted">
                        🔕
                      </span>
                    )}
                    {(pending || last) && <span class="chat-row-time">{shortTime(pending?.at ?? last!.at, lang)}</span>}
                  </span>
                  <span class="chat-row-bottom">
                    {typers.length ? (
                      <span class="typing">{s.typing}</span>
                    ) : (
                      <span class="chat-row-preview">
                        {fromMe && <Ticks tick={pending ? (pending.failed ? "failed" : "pending") : tickOf(chat, last!.seq)} />}
                        {fromMe && `${s.you}: `}
                        {sender && `${sender}: `}
                        {preview}
                      </span>
                    )}
                    {chat.unread > 0 && (
                      <span class="badge" data-testid="unread">
                        {chat.unread}
                      </span>
                    )}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {query && <FoundMessages q={q.trim()} />}
      </div>
    </nav>
  );
}

/** Typing pauses this long before the server is asked. */
export const SEARCH_DELAY_MS = 300;

/** Messages in all of my chats that contain every word typed, newest first, under the chats whose names match. */
function FoundMessages({ q }: { q: string }) {
  const { s, lang } = useLang();
  const st = useAppState();
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [more, setMore] = useState(false);
  const [problem, setProblem] = useState("");

  const fetchPage = (after?: SearchHit) =>
    api<SearchHit[]>("GET", `/search?q=${encodeURIComponent(q)}${after ? `&before=${after.at}:${after.chat}:${after.seq}` : ""}`);

  useEffect(() => {
    setHits(null);
    setProblem("");
    let live = true;
    const timer = setTimeout(() => {
      fetchPage()
        .then((page) => live && (setHits(page), setMore(page.length === LIMITS.searchPage)))
        .catch((e) => live && setProblem(errorText(s, e instanceof ApiError ? e.code : "generic")));
    }, SEARCH_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q]);

  if (problem)
    return (
      <p class="empty" data-testid="search-problem">
        {problem}
      </p>
    );
  if (!hits) return null;
  const words = searchWords(q);
  return (
    <section aria-label={s.foundMessages} data-testid="found-messages">
      <h2 class="list-heading">{s.foundMessages}</h2>
      {hits.length === 0 && <p class="empty">{s.nothingFound}</p>}
      <ul>
        {hits.map((h) => {
          const chat = st.chats.get(h.chat);
          if (!chat) return null;
          const name = chatName(chat, s);
          const other = chat.kind === "direct" ? otherMembers(chat)[0] : undefined;
          const sender = h.from === myId() ? s.you : chat.kind === "group" ? (h.from === null ? s.deletedAccount : chat.members.find((m) => m.id === h.from)?.display_name) : undefined;
          const icon = h.kind === "image" ? "📷 " : h.kind === "voice" ? "🎤 " : h.kind === "file" ? "📄 " : "";
          return (
            <li key={`${h.chat}:${h.seq}`}>
              <a
                href={`/chat/${h.chat}`}
                class="chat-row"
                data-testid="found-message"
                onClick={(e) => {
                  e.preventDefault();
                  void jumpTo(h.chat, h.seq)
                    .then(() => navigate(`/chat/${h.chat}`))
                    .catch(() => {});
                }}
              >
                <Avatar name={name} id={other?.id ?? chat.id} photo={chatPhoto(chat)} />
                <span class="chat-row-main">
                  <span class="chat-row-top">
                    <span class="chat-row-name">{name}</span>
                    <span class="chat-row-time">{shortTime(h.at, lang)}</span>
                  </span>
                  <span class="chat-row-bottom">
                    <span class="chat-row-preview found-snippet">
                      {sender && `${sender}: `}
                      {icon}
                      <Highlighted text={h.snippet} words={words} />
                    </span>
                  </span>
                </span>
              </a>
            </li>
          );
        })}
      </ul>
      {more && (
        <button
          type="button"
          class="link show-more"
          onClick={() =>
            void fetchPage(hits.at(-1))
              .then((page) => (setHits([...hits, ...page]), setMore(page.length === LIMITS.searchPage)))
              .catch(() => {})
          }
        >
          {s.showMore}
        </button>
      )}
    </section>
  );
}

/** "Connecting…" under a header. The chat view has its own copy for phones, where the list is hidden. */
export function ConnBanner({ inChat = false }: { inChat?: boolean }) {
  const s = useLang().s;
  const conn = useAppState().conn;
  return (
    <p
      class={`conn-banner conn-${conn}${inChat ? " phone-only" : ""}`}
      role="status"
      data-testid={inChat ? "connection-chat" : "connection"}
      data-state={conn}
      hidden={conn === "online"}
    >
      {conn === "connecting" ? s.connecting : navigator.onLine ? s.connecting : s.waitingForNetwork}
    </p>
  );
}

