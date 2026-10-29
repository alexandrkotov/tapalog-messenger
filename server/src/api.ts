import type { Database } from "bun:sqlite";
import { LIMITS, USERNAME_RE, type InviteDto, type MeDto } from "@tapalog-messenger/shared";
import { authenticate, clearSessionCookie, sessionCookie, type Origins, type Session } from "./auth";
import type { createFiles } from "./files";
import type { Notifier } from "./notify";
import * as subscriptions from "./store/push";
import { error, json, RateLimiter, readJson } from "./http";
import type { Hub } from "./hub";
import * as accounts from "./store/accounts";
import * as chats from "./store/chats";

/** REST under /api/. Everything except register and login needs a session. */

export interface ApiContext {
  db: Database;
  hub: Hub;
  files: ReturnType<typeof createFiles>;
  /** Null when Web Push is not set up (tests that do not need it). */
  push: Notifier | null;
  origins: Origins;
  /** Base for invite links: the public address if there is one, else the local one. */
  inviteBase: () => string;
  now: () => number;
}

const DAY_MS = 24 * 3600 * 1000;
// Spent on unknown usernames too, so a login does not reveal which names exist by how fast it fails.
const DUMMY_HASH = await Bun.password.hash("not a real password", { algorithm: "argon2id" });

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim().length > 0 && v.length <= max ? v.trim() : null);
const isId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

export function inviteDto(row: accounts.InviteRow, base: string): InviteDto {
  return {
    code: row.code,
    url: `${base}/invite/${row.code}`,
    grants_admin: row.grants_admin === 1,
    expires_at: row.expires_at,
    max_uses: row.max_uses,
    used_count: row.used_count,
  };
}

function me(session: Session): MeDto {
  const u = session.user;
  return { user: { ...accounts.toUserDto(u), is_admin: u.is_admin === 1 }, device_id: session.deviceId };
}

export function createApi(ctx: ApiContext) {
  const { db, hub } = ctx;
  // Failed tries per client IP: ten a minute is plenty for a person, too slow for guessing.
  const authLimiter = new RateLimiter(10, 60_000);
  const failed = (ip: string, code: Parameters<typeof error>[0]) => {
    authLimiter.record(ip, ctx.now());
    return error(code);
  };

  async function register(req: Request, ip: string): Promise<Response> {
    if (!authLimiter.allowed(ip, ctx.now())) return error("rate_limited");
    const body = await readJson(req);
    const invite = str(body?.invite, 100);
    const username = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
    const displayName = str(body?.display_name, LIMITS.displayName);
    const password = typeof body?.password === "string" ? body.password : "";
    const deviceName = str(body?.device_name, LIMITS.deviceName) ?? "Browser";
    if (!invite || !USERNAME_RE.test(username) || !displayName || password.length < LIMITS.passwordMin || password.length > LIMITS.passwordMax) {
      return failed(ip, "bad_request");
    }
    const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
    const now = ctx.now();
    const result = db.transaction(() => {
      if (accounts.findUserByName(db, username)) return "username_taken" as const;
      const inv = accounts.consumeInvite(db, invite, now);
      if (!inv) return "invite_invalid" as const;
      const user = accounts.createUser(db, { username, displayName, passwordHash: hash, isAdmin: inv.grants_admin === 1, now });
      return { user, ...accounts.createDevice(db, user.id, deviceName, now) };
    })();
    if (typeof result === "string") return failed(ip, result);
    return json(me({ user: result.user, deviceId: result.deviceId }), 201, { "Set-Cookie": sessionCookie(req, ctx.origins, result.token) });
  }

  async function login(req: Request, ip: string): Promise<Response> {
    if (!authLimiter.allowed(ip, ctx.now())) return error("rate_limited");
    const body = await readJson(req);
    const username = typeof body?.username === "string" ? body.username.trim() : "";
    const password = typeof body?.password === "string" ? body.password.slice(0, LIMITS.passwordMax) : "";
    const deviceName = str(body?.device_name, LIMITS.deviceName) ?? "Browser";
    const user = username ? accounts.findUserByName(db, username) : null;
    const ok = await Bun.password.verify(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) return failed(ip, "wrong_password");
    const { deviceId, token } = accounts.createDevice(db, user.id, deviceName, ctx.now());
    return json(me({ user, deviceId }), 200, { "Set-Cookie": sessionCookie(req, ctx.origins, token) });
  }

  async function updateMe(req: Request, s: Session): Promise<Response> {
    const body = await readJson(req);
    if (!body) return error("bad_request");
    if (body.display_name !== undefined) {
      const name = str(body.display_name, LIMITS.displayName);
      if (!name) return error("bad_request");
      accounts.updateDisplayName(db, s.user.id, name);
    }
    if (body.password !== undefined) {
      const p = body.password as { current?: unknown; next?: unknown } | null;
      const next = typeof p?.next === "string" ? p.next : "";
      if (typeof p?.current !== "string" || next.length < LIMITS.passwordMin || next.length > LIMITS.passwordMax) return error("bad_request");
      if (!(await Bun.password.verify(p.current, s.user.password_hash))) return error("wrong_password");
      accounts.updatePasswordHash(db, s.user.id, await Bun.password.hash(next, { algorithm: "argon2id" }));
    }
    const user = accounts.getUser(db, s.user.id)!;
    // Everyone who sees this person in a chat gets the new name.
    if (body.display_name !== undefined) for (const chat of chats.chatsOfUser(db, s.user.id, hub.isOnline)) hub.publishChat(chat.id);
    return json(me({ user, deviceId: s.deviceId }));
  }

  async function createChat(req: Request, s: Session): Promise<Response> {
    const body = await readJson(req);
    const now = ctx.now();
    if (body?.kind === "direct" && isId(body.user)) {
      if (!accounts.getUser(db, body.user)) return error("not_found");
      const { chatId, created } = chats.findOrCreateDirect(db, s.user.id, body.user, now);
      if (created) hub.publishChat(chatId);
      return json(chats.getChat(db, chatId, s.user.id, hub.isOnline), created ? 201 : 200);
    }
    if (body?.kind === "group" && Array.isArray(body.members) && body.members.every(isId)) {
      const title = str(body.title, LIMITS.groupTitle);
      if (!title) return error("bad_request");
      const res = chats.createGroup(db, s.user.id, title, body.members as number[], now);
      if (typeof res === "string") return error(res);
      hub.publishChat(res);
      return json(chats.getChat(db, res, s.user.id, hub.isOnline), 201);
    }
    return error("bad_request");
  }

  /** Routes /api/chats/{id}/… */
  async function chatRoute(req: Request, url: URL, s: Session, chatId: number, rest: string[]): Promise<Response> {
    if (!chats.memberRole(db, chatId, s.user.id)) return error("not_found");
    const done = (res: true | chats.Refusal, extra: number[] = []) => {
      if (res !== true) return error(res);
      hub.publishChat(chatId, extra);
      return json(chats.getChat(db, chatId, s.user.id, hub.isOnline) ?? { left: true });
    };

    if (rest.length === 0) {
      if (req.method === "GET") return json(chats.getChat(db, chatId, s.user.id, hub.isOnline));
      if (req.method === "PATCH") {
        const body = await readJson(req);
        // Muting is one person's own setting: only their view of the chat changes.
        if (typeof body?.muted === "boolean") {
          const res = chats.setMuted(db, chatId, s.user.id, body.muted);
          return res === true ? json(chats.getChat(db, chatId, s.user.id, hub.isOnline)) : error(res);
        }
        const title = str(body?.title, LIMITS.groupTitle);
        return title ? done(chats.renameGroup(db, chatId, s.user.id, title)) : error("bad_request");
      }
    }
    if (rest[0] === "messages" && rest.length === 1 && req.method === "GET") {
      const before = url.searchParams.get("before_seq");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      if ((before !== null && !isId(Number(before))) || !isId(limit)) return error("bad_request");
      return json(chats.history(db, chatId, before === null ? null : Number(before), Math.min(limit, LIMITS.pageMax)));
    }
    if (rest[0] === "members") {
      if (rest.length === 1 && req.method === "POST") {
        const user = (await readJson(req))?.user;
        return isId(user) ? done(chats.addMember(db, chatId, s.user.id, user, ctx.now())) : error("bad_request");
      }
      const target = Number(rest[1]);
      if (rest.length === 2 && isId(target)) {
        if (req.method === "DELETE") return done(chats.removeMember(db, chatId, s.user.id, target), [target]);
        if (req.method === "PATCH") {
          const r = (await readJson(req))?.role;
          return r === "admin" || r === "member" ? done(chats.setRole(db, chatId, s.user.id, target, r)) : error("bad_request");
        }
      }
    }
    return error("not_found");
  }

  async function pushSubscription(req: Request, s: Session): Promise<Response> {
    const body = await readJson(req);
    const endpoint = typeof body?.endpoint === "string" && body.endpoint.length <= 2048 ? body.endpoint : null;
    if (!ctx.push || !endpoint) return error("bad_request");
    if (req.method === "DELETE") {
      subscriptions.deleteSubscription(db, s.user.id, endpoint);
      return json({ ok: true });
    }
    const keys = body?.keys as { p256dh?: unknown; auth?: unknown } | undefined;
    const bytes = (v: unknown) => (typeof v === "string" && /^[\w-]+=*$/.test(v) ? Buffer.from(v, "base64url") : null);
    const p256dh = bytes(keys?.p256dh);
    const auth = bytes(keys?.auth);
    // A browser's key is an uncompressed P-256 point (65 bytes from 0x04); its secret is 16 bytes.
    if (!ctx.push.allowEndpoint(endpoint) || p256dh?.length !== 65 || p256dh[0] !== 4 || auth?.length !== 16) return error("bad_request");
    const lang = ["en", "ru", "uk"].includes(body?.lang as string) ? (body!.lang as string) : "en";
    subscriptions.saveSubscription(db, s.deviceId, { endpoint, p256dh: keys!.p256dh as string, auth: keys!.auth as string, lang }, ctx.now());
    return json({ ok: true }, 201);
  }

  async function invites(req: Request, s: Session, code: string | undefined): Promise<Response> {
    if (s.user.is_admin !== 1) return error("forbidden");
    const now = ctx.now();
    if (!code && req.method === "GET") return json(accounts.listInvites(db, now).map((i) => inviteDto(i, ctx.inviteBase())));
    if (!code && req.method === "POST") {
      const body = (await readJson(req)) ?? {};
      const maxUses = body.max_uses === undefined ? 1 : body.max_uses;
      const days = body.expires_in_days === undefined ? 7 : body.expires_in_days;
      if (!isId(maxUses) || maxUses > 1000 || !isId(days) || days > 365) return error("bad_request");
      const row = accounts.createInvite(db, { createdBy: s.user.id, grantsAdmin: false, maxUses, expiresAt: now + days * DAY_MS, now });
      return json(inviteDto(row, ctx.inviteBase()), 201);
    }
    if (code && req.method === "DELETE") return accounts.deleteInvite(db, code) ? json({ ok: true }) : error("not_found");
    return error("not_found");
  }

  return async function handleApi(req: Request, url: URL, ip: string): Promise<Response> {
    const parts = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"
    const route = parts.join("/");
    if (route === "auth/register" && req.method === "POST") return register(req, ip);
    if (route === "auth/login" && req.method === "POST") return login(req, ip);

    const s = authenticate(db, req, ctx.now());
    if (!s) return error("unauthorized");

    if (route === "auth/logout" && req.method === "POST") {
      accounts.deleteDevice(db, s.user.id, s.deviceId);
      hub.disconnectDevice(s.deviceId);
      return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie(req, ctx.origins) });
    }
    if (route === "me" && req.method === "GET") return json(me(s));
    if (route === "me" && req.method === "PATCH") return updateMe(req, s);
    if (route === "devices" && req.method === "GET") return json(accounts.listDevices(db, s.user.id, s.deviceId));
    if (parts[0] === "devices" && parts.length === 2 && req.method === "DELETE") {
      const id = Number(parts[1]);
      if (!isId(id) || !accounts.deleteDevice(db, s.user.id, id)) return error("not_found");
      hub.disconnectDevice(id);
      return json({ ok: true });
    }
    if (route === "users" && req.method === "GET") {
      const q = (url.searchParams.get("q") ?? "").trim();
      return json(q ? accounts.searchUsers(db, q.slice(0, 64), s.user.id) : []);
    }
    if (route === "chats" && req.method === "GET") return json(chats.chatsOfUser(db, s.user.id, hub.isOnline));
    if (route === "chats" && req.method === "POST") return createChat(req, s);
    if (parts[0] === "chats" && parts.length >= 2) {
      const chatId = Number(parts[1]);
      return isId(chatId) ? chatRoute(req, url, s, chatId, parts.slice(2)) : error("not_found");
    }
    if (parts[0] === "invites" && parts.length <= 2) return invites(req, s, parts[1]);
    if (route === "media" && req.method === "POST") return ctx.files.upload(req, url, s);
    if (route === "push/key" && req.method === "GET") return ctx.push ? json({ public_key: ctx.push.publicKey }) : error("not_found");
    if (route === "push/subscribe" && (req.method === "POST" || req.method === "DELETE")) return pushSubscription(req, s);
    if (parts[0] === "media" && parts[2] === "thumb" && parts.length === 3 && req.method === "PUT") return ctx.files.putThumb(req, parts[1]!, s);
    return error("not_found");
  };
}
