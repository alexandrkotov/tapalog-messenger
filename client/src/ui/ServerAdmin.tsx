import type { AdminUserDto, DiskUsageDto, InviteDto, MeDto, PasswordResetDto } from "@tapalog-messenger/shared";
import { useEffect, useState } from "preact/hooks";
import { api, ApiError } from "../api";
import { fmt } from "../i18n";
import { formatSize } from "../media";
import { myId, setMe } from "../state";
import { Avatar, errorText, lastSeenText, Link, useLang } from "./common";

/** Settings → Server, for administrators: people, invites and disk space. */
export function ServerAdmin() {
  const { s, lang } = useLang();
  const [users, setUsers] = useState<AdminUserDto[]>([]);
  const [disk, setDisk] = useState<DiskUsageDto | null>(null);
  const [invites, setInvites] = useState<InviteDto[]>([]);
  const [resets, setResets] = useState<Record<number, string>>({});
  const [copied, setCopied] = useState("");
  const [problem, setProblem] = useState<{ user: number; text: string } | null>(null);

  const loadUsers = () => api<AdminUserDto[]>("GET", "/admin/users").then(setUsers).catch(() => {});
  const loadInvites = () => api<InviteDto[]>("GET", "/invites").then(setInvites).catch(() => {});
  useEffect(() => {
    void loadUsers();
    void loadInvites();
    void api<DiskUsageDto>("GET", "/admin/disk").then(setDisk).catch(() => {});
  }, []);

  const act = async (user: AdminUserDto, run: () => Promise<unknown>) => {
    setProblem(null);
    try {
      await run();
    } catch (err) {
      setProblem({ user: user.id, text: errorText(s, err instanceof ApiError ? err.code : "generic") });
    }
    await loadUsers();
    // Giving up one's own admin rights changes what this screen and Settings show.
    if (user.id === myId()) await api<MeDto>("GET", "/me").then(setMe).catch(() => {});
  };
  const change = (user: AdminUserDto, body: { blocked?: boolean; is_admin?: boolean }) => act(user, () => api("PATCH", `/admin/users/${user.id}`, body));
  const resetLink = (user: AdminUserDto) =>
    act(user, async () => {
      const link = await api<PasswordResetDto>("POST", `/admin/users/${user.id}/reset`);
      setResets({ ...resets, [user.id]: link.url });
    });
  const remove = (user: AdminUserDto) => {
    const groups = user.groups > 0 ? `\n\n${fmt(s.confirmDeleteUserGroups, { n: user.groups })}` : "";
    if (confirm(fmt(s.confirmDeleteUser, { name: user.display_name }) + groups)) void act(user, () => api("DELETE", `/admin/users/${user.id}`));
  };
  const copy = async (url: string) => {
    await navigator.clipboard?.writeText(url).catch(() => {});
    setCopied(url);
  };

  return (
    <section class="panel" data-testid="server-panel">
      <header class="bar">
        <Link href="/settings" class="icon-button back" aria-label={s.back}>
          ←
        </Link>
        <h2>{s.server}</h2>
      </header>
      <div class="panel-body">
        <p class="hint">{s.serverHint}</p>

        <h3>{s.spaceUsed}</h3>
        {disk && (
          <p data-testid="disk-usage">
            {fmt(s.diskDb, { size: formatSize(disk.db_bytes, lang) })}
            <br />
            {fmt(s.diskFiles, { size: formatSize(disk.media_bytes, lang), n: disk.media_files })}
            {disk.free_bytes !== null && (
              <>
                <br />
                {fmt(s.diskFree, { size: formatSize(disk.free_bytes, lang) })}
              </>
            )}
          </p>
        )}

        <h3>{s.users}</h3>
        <ul class="people">
          {users.map((u) => (
            <li key={u.id} class={`person admin-user${u.blocked ? " blocked" : ""}`} data-testid="admin-user" data-user={u.username}>
              <Avatar name={u.display_name} id={u.id} photo={u.avatar} online={u.online} size={36} />
              <span>
                <strong>
                  {u.display_name}
                  {u.id === myId() && ` (${s.you})`}
                </strong>
                <small>
                  @{u.username}
                  {u.is_admin && ` · ${s.admin}`}
                  {u.blocked && ` · ${s.blockedMark}`}
                  {" · "}
                  {u.online ? s.onlineNow : lastSeenText(s, u.last_active_at, lang)}
                  {" · "}
                  {fmt(s.deviceCount, { n: u.devices })}
                </small>
                <span class="row-actions wrap">
                  {u.id !== myId() && (
                    <button
                      type="button"
                      class={`link${u.blocked ? "" : " danger"}`}
                      data-testid={u.blocked ? "unblock" : "block"}
                      onClick={() => (u.blocked || confirm(fmt(s.confirmBlock, { name: u.display_name }))) && void change(u, { blocked: !u.blocked })}
                    >
                      {u.blocked ? s.unblock : s.block}
                    </button>
                  )}
                  {!u.blocked && (
                    <button type="button" class="link" data-testid="toggle-admin" onClick={() => void change(u, { is_admin: !u.is_admin })}>
                      {u.is_admin ? s.removeAdmin : s.makeAdmin}
                    </button>
                  )}
                  {!u.blocked && u.id !== myId() && (
                    <button type="button" class="link" data-testid="reset-link" onClick={() => void resetLink(u)}>
                      {s.resetLink}
                    </button>
                  )}
                  {u.id !== myId() && (
                    <button type="button" class="link danger" data-testid="delete-user" onClick={() => remove(u)}>
                      {s.deleteUser}
                    </button>
                  )}
                </span>
                {problem?.user === u.id && (
                  <small class="error" role="alert">
                    {problem.text}
                  </small>
                )}
                {resets[u.id] && (
                  <span class="reset-out">
                    <small>{fmt(s.resetLinkHint, { name: u.display_name })}</small>
                    <code data-testid="reset-url">{resets[u.id]}</code>
                    <button type="button" class="link" onClick={() => void copy(resets[u.id]!)}>
                      {copied === resets[u.id] ? s.copied : s.copy}
                    </button>
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>

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
      </div>
    </section>
  );
}
