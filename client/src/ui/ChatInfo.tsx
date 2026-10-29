import type { ChatDto } from "@tapalog-messenger/shared";
import { useState } from "preact/hooks";
import { api } from "../api";
import { fmt } from "../i18n";
import { navigate } from "../router";
import { chatName, myId, upsertChat, useAppState } from "../state";
import { Avatar, lastSeenText, Link, useLang } from "./common";
import { useUserSearch } from "./NewChat";

export function ChatInfo({ chatId }: { chatId: number }) {
  const { s, lang } = useLang();
  const chat = useAppState().chats.get(chatId);
  const [title, setTitle] = useState(chat?.title ?? "");
  const [q, setQ] = useState("");
  const found = useUserSearch(q);
  if (!chat) return null;

  const isAdmin = chat.kind === "group" && chat.members.find((m) => m.id === myId())?.role === "admin";
  const apply = async (method: string, path: string, body?: unknown) => {
    const res = await api<ChatDto | { left: true }>(method, `/chats/${chatId}${path}`, body);
    if ("id" in res) upsertChat(res);
  };

  return (
    <section class="panel" data-testid="chat-info">
      <header class="bar">
        <Link href={`/chat/${chatId}`} class="icon-button back" aria-label={s.back}>
          ←
        </Link>
        <h2>{chatName(chat)}</h2>
      </header>
      <div class="panel-body">
        {isAdmin && (
          <form class="row" onSubmit={(e) => (e.preventDefault(), void apply("PATCH", "", { title: title.trim() }))}>
            <input aria-label={s.groupTitle} value={title} maxLength={100} onInput={(e) => setTitle(e.currentTarget.value)} />
            <button disabled={!title.trim() || title.trim() === chat.title}>{s.rename}</button>
          </form>
        )}
        <div class="chat-card">
          <Avatar name={chatName(chat)} id={chat.kind === "direct" ? (chat.members.find((m) => m.id !== myId())?.id ?? chat.id) : chat.id} size={64} />
          <strong>{chatName(chat)}</strong>
        </div>

        <h3>{s.notifications}</h3>
        <label class="check">
          <input type="checkbox" checked={chat.muted} onChange={(e) => void apply("PATCH", "", { muted: e.currentTarget.checked })} />
          {s.muteChat}
        </label>
        <h3>{fmt(s.members, { n: chat.members.length })}</h3>
        <ul class="people">
          {chat.members.map((m) => (
            <li key={m.id} class="person" data-testid="member">
              <Avatar name={m.display_name} id={m.id} online={m.online} size={36} />
              <span>
                <strong>
                  {m.display_name}
                  {m.id === myId() && ` (${s.you})`}
                </strong>
                <small>
                  @{m.username}
                  {m.role === "admin" && chat.kind === "group" && ` · ${s.admin}`}
                  {" · "}
                  {m.online ? s.onlineNow : lastSeenText(s, m.last_seen_at, lang)}
                </small>
              </span>
              {isAdmin && m.id !== myId() && (
                <span class="row-actions">
                  <button type="button" class="link" onClick={() => void apply("PATCH", `/members/${m.id}`, { role: m.role === "admin" ? "member" : "admin" })}>
                    {m.role === "admin" ? s.removeAdmin : s.makeAdmin}
                  </button>
                  <button type="button" class="link danger" onClick={() => void apply("DELETE", `/members/${m.id}`)}>
                    {s.remove}
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
        {isAdmin && (
          <>
            <h3>{s.addMember}</h3>
            <input type="search" class="search" placeholder={s.findPeople} aria-label={s.addMember} value={q} onInput={(e) => setQ(e.currentTarget.value)} />
            <ul class="people">
              {found
                ?.filter((u) => !chat.members.some((m) => m.id === u.id))
                .map((u) => (
                  <li key={u.id}>
                    <button type="button" class="person" onClick={() => (void apply("POST", "/members", { user: u.id }), setQ(""))}>
                      <Avatar name={u.display_name} id={u.id} size={36} />
                      <span>
                        <strong>{u.display_name}</strong>
                        <small>@{u.username}</small>
                      </span>
                    </button>
                  </li>
                ))}
            </ul>
          </>
        )}
        {chat.kind === "group" && (
          <button
            type="button"
            class="danger"
            onClick={async () => {
              if (!confirm(s.confirmLeave)) return;
              await api("DELETE", `/chats/${chatId}/members/${myId()}`);
              navigate("/", true);
            }}
          >
            {s.leaveGroup}
          </button>
        )}
      </div>
    </section>
  );
}
