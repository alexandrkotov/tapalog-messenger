import { useState } from "preact/hooks";
import { chatActivity, chatName, myId, otherMembers, tickOf, typingIn, useAppState } from "../state";
import { Avatar, Link, quoteText, shortTime, Ticks, useLang } from "./common";

export function ChatList() {
  const { s, lang } = useLang();
  const st = useAppState();
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const chats = [...st.chats.values()]
    .filter((c) => !query || chatName(c).toLowerCase().includes(query) || otherMembers(c).some((m) => m.username.includes(query)))
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
      {chats.length === 0 && !query && <p class="empty">{s.noChats}</p>}
      <ul>
        {chats.map((chat) => {
          const name = chatName(chat);
          const other = chat.kind === "direct" ? otherMembers(chat)[0] : undefined;
          const typers = typingIn(chat.id);
          const pending = st.outbox.filter((p) => p.chat === chat.id).at(-1);
          const last = chat.last_message;
          const fromMe = pending || (last && last.from === myId());
          const sender = chat.kind === "group" && last && !fromMe ? chat.members.find((m) => m.id === last.from)?.display_name : undefined;
          const preview = pending
            ? quoteText(s, { kind: pending.kind, body: pending.body, media: pending.file })
            : last
              ? last.deleted
                ? s.deleted
                : quoteText(s, last)
              : "";
          return (
            <li key={chat.id}>
              <Link href={`/chat/${chat.id}`} class={`chat-row${st.openChat === chat.id ? " active" : ""}`} data-testid="chat-row" data-chat={chat.id}>
                <Avatar name={name} id={other?.id ?? chat.id} online={other?.online} />
                <span class="chat-row-main">
                  <span class="chat-row-top">
                    <span class="chat-row-name">{name}</span>
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
    </nav>
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

