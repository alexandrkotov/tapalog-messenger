import { USERNAME_RE, type ResetInfoDto } from "@tapalog-messenger/shared";
import { useEffect, useState } from "preact/hooks";
import { api, ApiError } from "../api";
import { fmt } from "../i18n";
import { login, register, resetPassword } from "../state";
import { errorText, Link, useS } from "./common";

function useSubmit(action: () => Promise<void>) {
  const s = useS();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      await action();
    } catch (x) {
      setErr(errorText(s, x instanceof ApiError ? x.code : "generic"));
      setBusy(false);
    }
  };
  return { busy, err, submit };
}

export function Login() {
  const s = useS();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const { busy, err, submit } = useSubmit(() => login(username, password));
  return (
    <form class="card auth" onSubmit={submit}>
      <h1>{s.title}</h1>
      <label>
        {s.username}
        <input name="username" autocomplete="username" autocapitalize="none" required value={username} onInput={(e) => setUsername(e.currentTarget.value)} />
      </label>
      <label>
        {s.password}
        <input name="password" type="password" autocomplete="current-password" required value={password} onInput={(e) => setPassword(e.currentTarget.value)} />
      </label>
      {err && (
        <p class="error" role="alert">
          {err}
        </p>
      )}
      <button class="primary" disabled={busy}>
        {s.signIn}
      </button>
      <p class="hint">{s.needInvite}</p>
    </form>
  );
}

export function Register({ invite }: { invite: string }) {
  const s = useS();
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const { busy, err, submit } = useSubmit(() => register(invite, username.trim().toLowerCase(), name, password));
  return (
    <form class="card auth" onSubmit={submit}>
      <h1>{s.title}</h1>
      <h2>{s.createAccount}</h2>
      <label>
        {s.displayName}
        <input name="display_name" autocomplete="name" required maxLength={64} value={name} onInput={(e) => setName(e.currentTarget.value)} />
      </label>
      <label>
        {s.username}
        <input
          name="username"
          autocomplete="username"
          autocapitalize="none"
          required
          pattern={USERNAME_RE.source.slice(1, -1)}
          value={username}
          onInput={(e) => setUsername(e.currentTarget.value.toLowerCase())}
        />
        <small>{s.usernameHint}</small>
      </label>
      <label>
        {s.password}
        <input name="password" type="password" autocomplete="new-password" required minLength={8} value={password} onInput={(e) => setPassword(e.currentTarget.value)} />
        <small>{s.passwordHint}</small>
      </label>
      {err && (
        <p class="error" role="alert">
          {err}
        </p>
      )}
      <button class="primary" disabled={busy}>
        {s.createAccount}
      </button>
    </form>
  );
}

/** /reset/<code>: the page an administrator's password-reset link opens. */
export function ResetPassword({ code }: { code: string }) {
  const s = useS();
  const [who, setWho] = useState<ResetInfoDto | null>(null);
  const [invalid, setInvalid] = useState("");
  const [password, setPassword] = useState("");
  const { busy, err, submit } = useSubmit(() => resetPassword(code, password));
  useEffect(() => {
    api<ResetInfoDto>("GET", `/auth/reset/${encodeURIComponent(code)}`)
      .then(setWho)
      .catch((x) => setInvalid(errorText(s, x instanceof ApiError ? x.code : "generic")));
  }, [code]);
  return (
    <form class="card auth" onSubmit={submit} data-testid="reset-form">
      <h1>{s.title}</h1>
      <h2>{s.resetTitle}</h2>
      {invalid && (
        <p class="error" role="alert">
          {invalid}
        </p>
      )}
      {who && (
        <>
          <p>{fmt(s.resetFor, { name: who.display_name, username: who.username })}</p>
          <input type="text" name="username" autocomplete="username" value={who.username} hidden readOnly />
          <label>
            {s.newPassword}
            <input name="password" type="password" autocomplete="new-password" required minLength={8} value={password} onInput={(e) => setPassword(e.currentTarget.value)} />
            <small>{s.passwordHint}</small>
          </label>
          {err && (
            <p class="error" role="alert">
              {err}
            </p>
          )}
          <button class="primary" disabled={busy}>
            {s.resetSave}
          </button>
        </>
      )}
    </form>
  );
}

export function AlreadySignedIn() {
  const s = useS();
  return (
    <div class="card auth">
      <h1>{s.title}</h1>
      <p>{s.alreadySignedIn}</p>
      <Link href="/" class="button primary">
        {s.toChats}
      </Link>
    </div>
  );
}
