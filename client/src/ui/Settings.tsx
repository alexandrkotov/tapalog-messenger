import type { DeviceDto, InviteDto, MeDto } from "@tapalog-messenger/shared";
import { useEffect, useState } from "preact/hooks";
import { api, ApiError } from "../api";
import { fmt, LANGS, type Lang } from "../i18n";
import { logout, setMe, useAppState } from "../state";
import { errorText, Link, shortTime, useLang } from "./common";

export function Settings() {
  const { s, lang, setLang } = useLang();
  const me = useAppState().me!;
  const [name, setName] = useState(me.user.display_name);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [note, setNote] = useState("");
  const [devices, setDevices] = useState<DeviceDto[]>([]);
  const [invites, setInvites] = useState<InviteDto[]>([]);
  const [copied, setCopied] = useState("");

  const loadDevices = () => api<DeviceDto[]>("GET", "/devices").then(setDevices).catch(() => {});
  const loadInvites = async () => {
    if (me.user.is_admin) await api<InviteDto[]>("GET", "/invites").then(setInvites).catch(() => {});
  };
  useEffect(() => {
    void loadDevices();
    void loadInvites();
  }, []);

  const save = async (body: unknown) => {
    setNote("");
    try {
      setMe(await api<MeDto>("PATCH", "/me", body));
      setNote(s.saved);
      setCurrent("");
      setNext("");
    } catch (err) {
      setNote(errorText(s, err instanceof ApiError ? err.code : "generic"));
    }
  };
  const copy = async (url: string) => {
    await navigator.clipboard?.writeText(url).catch(() => {});
    setCopied(url);
  };

  return (
    <section class="panel" data-testid="settings-panel">
      <header class="bar">
        <Link href="/" class="icon-button back" aria-label={s.back}>
          ←
        </Link>
        <h2>{s.settings}</h2>
      </header>
      <div class="panel-body">
        <h3>{s.profile}</h3>
        <form class="row" onSubmit={(e) => (e.preventDefault(), void save({ display_name: name.trim() }))}>
          <input aria-label={s.displayName} value={name} maxLength={64} onInput={(e) => setName(e.currentTarget.value)} />
          <button disabled={!name.trim() || name.trim() === me.user.display_name}>{s.save}</button>
        </form>
        <p class="hint">@{me.user.username}</p>

        <h3>{s.changePassword}</h3>
        <form class="stack" onSubmit={(e) => (e.preventDefault(), void save({ password: { current, next } }))}>
          <input type="password" autocomplete="current-password" placeholder={s.currentPassword} aria-label={s.currentPassword} value={current} onInput={(e) => setCurrent(e.currentTarget.value)} />
          <input type="password" autocomplete="new-password" minLength={8} placeholder={s.newPassword} aria-label={s.newPassword} value={next} onInput={(e) => setNext(e.currentTarget.value)} />
          <button disabled={!current || next.length < 8}>{s.changePassword}</button>
        </form>
        {note && (
          <p class="hint" role="status">
            {note}
          </p>
        )}

        <h3>{s.language}</h3>
        <select aria-label={s.language} value={lang} onChange={(e) => setLang(e.currentTarget.value as Lang)}>
          {LANGS.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>

        <h3>{s.devices}</h3>
        <ul class="list">
          {devices.map((d) => (
            <li key={d.id}>
              <span>
                <strong>{d.name}</strong>
                <small>{d.current ? s.thisDevice : fmt(s.lastActive, { time: shortTime(d.last_active_at, lang) })}</small>
              </span>
              {!d.current && (
                <button type="button" class="link danger" onClick={() => void api("DELETE", `/devices/${d.id}`).then(loadDevices)}>
                  {s.signOutDevice}
                </button>
              )}
            </li>
          ))}
        </ul>

        {me.user.is_admin && (
          <>
            <h3>{s.invites}</h3>
            <p class="hint">{s.inviteHint}</p>
            <button type="button" data-testid="create-invite" onClick={() => void api<InviteDto>("POST", "/invites", {}).then(loadInvites)}>
              {s.createInvite}
            </button>
            <ul class="list">
              {invites.map((i) => (
                <li key={i.code}>
                  <span>
                    <code data-testid="invite-url">{i.url}</code>
                    <small>{fmt(s.usesLeft, { used: i.used_count, max: i.max_uses })}</small>
                  </span>
                  <button type="button" class="link" onClick={() => void copy(i.url)}>
                    {copied === i.url ? s.copied : s.copy}
                  </button>
                  <button type="button" class="link danger" onClick={() => void api("DELETE", `/invites/${i.code}`).then(loadInvites)}>
                    {s.remove}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        <button type="button" class="danger signout" onClick={() => void logout()}>
          {s.signOut}
        </button>
      </div>
    </section>
  );
}
