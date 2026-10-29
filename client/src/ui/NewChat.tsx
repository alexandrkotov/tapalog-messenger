import type { ChatDto, UserDto } from "@tapalog-messenger/shared";
import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { fmt } from "../i18n";
import { navigate } from "../router";
import { upsertChat } from "../state";
import { Avatar, Link, useS } from "./common";

/** People search with a short debounce; shared by the new-chat screen and "add member". */
export function useUserSearch(q: string): UserDto[] | null {
  const [found, setFound] = useState<UserDto[] | null>(null);
  useEffect(() => {
    const query = q.trim();
    if (!query) return setFound(null);
    const timer = setTimeout(() => {
      api<UserDto[]>("GET", `/users?q=${encodeURIComponent(query)}`)
        .then(setFound)
        .catch(() => setFound([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [q]);
  return found;
}

export function NewChat() {
  const s = useS();
  const [q, setQ] = useState("");
  const [group, setGroup] = useState(false);
  const [title, setTitle] = useState("");
  const [picked, setPicked] = useState<UserDto[]>([]);
  const found = useUserSearch(q);

  const startDirect = async (user: UserDto) => {
    const chat = await api<ChatDto>("POST", "/chats", { kind: "direct", user: user.id });
    upsertChat(chat);
    navigate(`/chat/${chat.id}`, true);
  };
  const createGroup = async (e: Event) => {
    e.preventDefault();
    const chat = await api<ChatDto>("POST", "/chats", { kind: "group", title: title.trim(), members: picked.map((u) => u.id) });
    upsertChat(chat);
    navigate(`/chat/${chat.id}`, true);
  };
  const toggle = (u: UserDto) => setPicked((p) => (p.some((x) => x.id === u.id) ? p.filter((x) => x.id !== u.id) : [...p, u]));

  return (
    <section class="panel">
      <header class="bar">
        <Link href="/" class="icon-button back" aria-label={s.back}>
          ←
        </Link>
        <h2>{group ? s.newGroup : s.newChat}</h2>
        <button type="button" class="link" onClick={() => setGroup(!group)} data-testid="toggle-group">
          {group ? s.newChat : s.newGroup}
        </button>
      </header>
      <div class="panel-body">
        {group && (
          <form class="row" onSubmit={createGroup}>
            <input name="title" placeholder={s.groupTitle} aria-label={s.groupTitle} required maxLength={100} value={title} onInput={(e) => setTitle(e.currentTarget.value)} />
            <button class="primary" disabled={!title.trim() || picked.length === 0}>
              {s.create}
            </button>
          </form>
        )}
        {group && picked.length > 0 && <p class="hint">{fmt(s.selected, { n: picked.length })}: {picked.map((u) => u.display_name).join(", ")}</p>}
        <input type="search" class="search" placeholder={s.findPeople} aria-label={s.findPeople} value={q} onInput={(e) => setQ(e.currentTarget.value)} autoFocus />
        {found?.length === 0 && <p class="empty">{s.nobodyFound}</p>}
        <ul class="people">
          {found?.map((u) => (
            <li key={u.id}>
              <button type="button" class="person" data-testid="person" onClick={() => (group ? toggle(u) : void startDirect(u))}>
                <Avatar name={u.display_name} id={u.id} photo={u.avatar} size={36} />
                <span>
                  <strong>{u.display_name}</strong>
                  <small>@{u.username}</small>
                </span>
                {group && <input type="checkbox" checked={picked.some((x) => x.id === u.id)} tabIndex={-1} aria-hidden="true" />}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
