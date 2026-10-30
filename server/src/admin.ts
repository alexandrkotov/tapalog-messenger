import { type AdminUserDto, type PasswordResetDto } from "@tapalog-messenger/shared";
import type { ApiContext } from "./api";
import type { Session } from "./auth";
import { error, json, readJson } from "./http";
import * as accounts from "./store/accounts";
import * as chats from "./store/chats";

/**
 * /api/admin/*: the «Server» section, for administrators only. An account
 * can be blocked (and unblocked) or deleted; either way their messages stay
 * with the people they wrote to. The server is never left without an active
 * administrator.
 */

/** How long a password-reset link works. */
export const RESET_TTL_MS = 24 * 3600 * 1000;

function adminUserDto(u: accounts.AdminUserRow, online: boolean): AdminUserDto {
  return {
    ...accounts.toUserDto(u),
    is_admin: u.is_admin === 1,
    blocked: u.blocked_at !== null,
    online,
    created_at: u.created_at,
    last_active_at: u.last_active_at || null,
    devices: u.devices,
    groups: u.groups,
  };
}

export function createAdminApi(ctx: ApiContext) {
  const { db, hub } = ctx;
  const userView = (id: number) => {
    const row = accounts.listUsersForAdmin(db).find((u) => u.id === id);
    return row ? adminUserDto(row, hub.isOnline(row.id)) : null;
  };

  async function changeUser(req: Request, s: Session, target: accounts.UserRow): Promise<Response> {
    const body = await readJson(req);
    const blocked = body?.blocked;
    const isAdmin = body?.is_admin;
    if ((blocked !== undefined && typeof blocked !== "boolean") || (isAdmin !== undefined && typeof isAdmin !== "boolean")) return error("bad_request");
    const activeAdmin = target.is_admin === 1 && target.blocked_at === null;
    const losesAdmin = activeAdmin && (blocked === true || isAdmin === false);
    if (losesAdmin && accounts.countActiveAdmins(db) <= 1) return error("last_admin");
    if (blocked === true && target.id === s.user.id) return error("forbidden");

    if (isAdmin !== undefined) accounts.setAdmin(db, target.id, isAdmin);
    if (blocked !== undefined && blocked !== (target.blocked_at !== null)) {
      accounts.setBlocked(db, target.id, blocked ? ctx.now() : null);
      // Open tabs hear "signed out" and show the sign-in screen, where signing in is refused.
      if (blocked) hub.disconnectUser(target.id);
    }
    return json(userView(target.id));
  }

  function deleteUser(s: Session, target: accounts.UserRow): Response {
    if (target.id === s.user.id) return error("forbidden");
    if (target.is_admin === 1 && target.blocked_at === null && accounts.countActiveAdmins(db) <= 1) return error("last_admin");
    hub.disconnectUser(target.id);
    const { changed, removed } = accounts.deleteUser(db, target.id);
    for (const { chat, members } of removed) hub.publish(members, { t: "chat.removed", chat });
    for (const chat of changed) {
      hub.publishChat(chat);
      // Their messages now show as from a deleted account: open tabs load the chat again.
      hub.publish(chats.memberIds(db, chat), { t: "chat.reset", chat });
    }
    return json({ ok: true });
  }

  return async function adminRoute(req: Request, s: Session, parts: string[]): Promise<Response> {
    if (s.user.is_admin !== 1) return error("forbidden");
    if (parts[0] === "disk" && parts.length === 1 && req.method === "GET") return json(ctx.disk());
    if (parts[0] !== "users") return error("not_found");
    if (parts.length === 1 && req.method === "GET") return json(accounts.listUsersForAdmin(db).map((u) => adminUserDto(u, hub.isOnline(u.id))));

    const target = accounts.getUser(db, Number(parts[1]));
    if (!target) return error("not_found");
    if (parts.length === 2 && req.method === "PATCH") return changeUser(req, s, target);
    if (parts.length === 2 && req.method === "DELETE") return deleteUser(s, target);
    if (parts.length === 3 && parts[2] === "reset" && req.method === "POST") {
      if (target.blocked_at !== null) return error("blocked");
      const { code, expiresAt } = accounts.createPasswordReset(db, target.id, s.user.id, RESET_TTL_MS, ctx.now());
      const dto: PasswordResetDto = { url: `${ctx.inviteBase()}/reset/${code}`, expires_at: expiresAt };
      return json(dto, 201);
    }
    return error("not_found");
  };
}
