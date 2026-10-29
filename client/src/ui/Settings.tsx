import type { DeviceDto, MeDto } from "@tapalog-messenger/shared";
import { useEffect, useState } from "preact/hooks";
import { api, ApiError } from "../api";
import { fmt, LANGS, type Lang } from "../i18n";
import { pushState, turnOff, turnOn, type PushState } from "../push";
import { logout, setMe, useAppState } from "../state";
import { savedTheme, setTheme, type Theme } from "../theme";
import { AvatarEditor } from "./AvatarEditor";
import { errorText, Link, shortTime, useLang } from "./common";

export function Settings() {
  const { s, lang, setLang } = useLang();
  const me = useAppState().me!;
  const [name, setName] = useState(me.user.display_name);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [note, setNote] = useState("");
  const [devices, setDevices] = useState<DeviceDto[]>([]);
  const [push, setPush] = useState<PushState | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [theme, setThemeState] = useState<Theme>(savedTheme);

  const loadDevices = () => api<DeviceDto[]>("GET", "/devices").then(setDevices).catch(() => {});
  useEffect(() => {
    void loadDevices();
    void pushState().then(setPush);
  }, []);
  const togglePush = async () => {
    setPushBusy(true);
    try {
      setPush(await (push === "on" ? turnOff() : turnOn(lang)));
    } catch {
      setPush(await pushState());
    } finally {
      setPushBusy(false);
    }
  };

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
        <AvatarEditor name={me.user.display_name} id={me.user.id} photo={me.user.avatar} target="me" />
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

        <h3>{s.theme}</h3>
        <select
          aria-label={s.theme}
          value={theme}
          onChange={(e) => {
            const t = e.currentTarget.value as Theme;
            setTheme(t);
            setThemeState(t);
          }}
        >
          <option value="system">{s.themeSystem}</option>
          <option value="light">{s.themeLight}</option>
          <option value="dark">{s.themeDark}</option>
        </select>

        {push && (
          <>
            <h3>{s.notifications}</h3>
            <p class="hint" data-testid="push-state" data-state={push}>
              {{ on: s.notifyOn, off: s.notifyOff, denied: s.notifyDenied, "needs-install": s.notifyInstall, unsupported: s.notifyUnsupported }[push]}
            </p>
            {(push === "on" || push === "off") && (
              <button type="button" disabled={pushBusy} onClick={() => void togglePush()}>
                {push === "on" ? s.turnOff : s.turnOn}
              </button>
            )}
          </>
        )}

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
            <h3>{s.server}</h3>
            <p class="hint">{s.serverHint}</p>
            <Link href="/server" class="button" data-testid="server-section">
              {s.server}
            </Link>
          </>
        )}

        <button type="button" class="danger signout" onClick={() => void logout()}>
          {s.signOut}
        </button>
      </div>
    </section>
  );
}
