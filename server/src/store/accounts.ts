import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import type { DeviceDto, UserDto } from "@tapalog-messenger/shared";

/**
 * Users, signed-in devices and invites. All SQL for accounts lives here;
 * callers hash passwords (async) before calling in.
 */

export interface UserRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  is_admin: number;
  created_at: number;
  last_seen_at: number | null;
  avatar_media_id: string | null;
  blocked_at: number | null;
}

export interface InviteRow {
  code: string;
  created_by: number | null;
  grants_admin: number;
  created_at: number;
  expires_at: number | null;
  max_uses: number;
  used_count: number;
}

export const newSessionToken = () => randomBytes(32).toString("base64url");
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const newInviteCode = () => randomBytes(12).toString("base64url");

export const toUserDto = (u: Pick<UserRow, "id" | "username" | "display_name" | "avatar_media_id">): UserDto => ({
  id: u.id,
  username: u.username,
  display_name: u.display_name,
  avatar: u.avatar_media_id,
});

export function countUsers(db: Database): number {
  return (db.query("SELECT count(*) AS n FROM users").get() as { n: number }).n;
}

export function getUser(db: Database, id: number): UserRow | null {
  return db.query("SELECT * FROM users WHERE id = $id").get({ id }) as UserRow | null;
}

export function findUserByName(db: Database, username: string): UserRow | null {
  return db.query("SELECT * FROM users WHERE username = $username").get({ username }) as UserRow | null;
}

/** Up to `limit` users whose username or display name contains `q`, except `excludeId`. */
export function searchUsers(db: Database, q: string, excludeId: number, limit = 20): UserDto[] {
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = db
    .query(
      `SELECT id, username, display_name, avatar_media_id FROM users
       WHERE id != $excludeId AND (username LIKE $pattern ESCAPE '\\' OR display_name LIKE $pattern ESCAPE '\\')
       ORDER BY display_name COLLATE NOCASE LIMIT $limit`,
    )
    .all({ excludeId, pattern, limit }) as UserRow[];
  return rows.map(toUserDto);
}

export function updateDisplayName(db: Database, userId: number, displayName: string): void {
  db.query("UPDATE users SET display_name = $displayName WHERE id = $userId").run({ userId, displayName });
}

export function setAvatar(db: Database, userId: number, mediaId: string | null): void {
  db.query("UPDATE users SET avatar_media_id = $mediaId WHERE id = $userId").run({ userId, mediaId });
}

export function updatePasswordHash(db: Database, userId: number, passwordHash: string): void {
  db.query("UPDATE users SET password_hash = $passwordHash WHERE id = $userId").run({ userId, passwordHash });
}

export function setLastSeen(db: Database, userId: number, at: number): void {
  db.query("UPDATE users SET last_seen_at = $at WHERE id = $userId").run({ userId, at });
}

// ---- Devices and sessions -------------------------------------------------

/** Signs a device in; the returned token goes to the browser and only its hash is kept. */
export function createDevice(db: Database, userId: number, name: string, now: number): { deviceId: number; token: string } {
  const token = newSessionToken();
  const row = db
    .query(
      `INSERT INTO devices (user_id, name, session_token_hash, created_at, last_active_at)
       VALUES ($userId, $name, $hash, $now, $now) RETURNING id`,
    )
    .get({ userId, name, hash: hashToken(token), now }) as { id: number };
  return { deviceId: row.id, token };
}

export function sessionByToken(db: Database, token: string): { user: UserRow; deviceId: number; lastActiveAt: number } | null {
  const row = db
    .query(
      `SELECT d.id AS device_id, d.last_active_at, u.* FROM devices d JOIN users u ON u.id = d.user_id
       WHERE d.session_token_hash = $hash`,
    )
    .get({ hash: hashToken(token) }) as (UserRow & { device_id: number; last_active_at: number }) | null;
  if (!row) return null;
  const { device_id, last_active_at, ...user } = row;
  return { user, deviceId: device_id, lastActiveAt: last_active_at };
}

export function touchDevice(db: Database, deviceId: number, now: number): void {
  db.query("UPDATE devices SET last_active_at = $now WHERE id = $deviceId").run({ deviceId, now });
}

export function listDevices(db: Database, userId: number, currentDeviceId: number): DeviceDto[] {
  const rows = db
    .query("SELECT id, name, created_at, last_active_at FROM devices WHERE user_id = $userId ORDER BY last_active_at DESC")
    .all({ userId }) as Omit<DeviceDto, "current">[];
  return rows.map((d) => ({ ...d, current: d.id === currentDeviceId }));
}

/** Signs one device out. False if it is not this user's. */
export function deleteDevice(db: Database, userId: number, deviceId: number): boolean {
  return db.query("DELETE FROM devices WHERE id = $deviceId AND user_id = $userId").run({ userId, deviceId }).changes > 0;
}

// ---- Invites --------------------------------------------------------------

export function createInvite(
  db: Database,
  opts: { createdBy: number | null; grantsAdmin: boolean; maxUses: number; expiresAt: number | null; now: number },
): InviteRow {
  return db
    .query(
      `INSERT INTO invites (code, created_by, grants_admin, created_at, expires_at, max_uses)
       VALUES ($code, $createdBy, $grantsAdmin, $now, $expiresAt, $maxUses) RETURNING *`,
    )
    .get({
      code: newInviteCode(),
      createdBy: opts.createdBy,
      grantsAdmin: opts.grantsAdmin ? 1 : 0,
      now: opts.now,
      expiresAt: opts.expiresAt,
      maxUses: opts.maxUses,
    }) as InviteRow;
}

/** Invites that can still be used. */
export function listInvites(db: Database, now: number): InviteRow[] {
  return db
    .query("SELECT * FROM invites WHERE used_count < max_uses AND (expires_at IS NULL OR expires_at > $now) ORDER BY created_at DESC")
    .all({ now }) as InviteRow[];
}

export function deleteInvite(db: Database, code: string): boolean {
  return db.query("DELETE FROM invites WHERE code = $code").run({ code }).changes > 0;
}

/** Counts one use of the invite and returns it, or null if it is unknown, used up or expired. Call inside a transaction. */
export function consumeInvite(db: Database, code: string, now: number): InviteRow | null {
  return db
    .query(
      `UPDATE invites SET used_count = used_count + 1
       WHERE code = $code AND used_count < max_uses AND (expires_at IS NULL OR expires_at > $now) RETURNING *`,
    )
    .get({ code, now }) as InviteRow | null;
}

/**
 * While nobody has registered, keeps one single-use admin invite around so the
 * host can create the first account from the status page. Null once someone has.
 */
export function ensureSetupInvite(db: Database, now: number): InviteRow | null {
  if (countUsers(db) > 0) return null;
  const existing = db
    .query("SELECT * FROM invites WHERE created_by IS NULL AND grants_admin = 1 AND used_count < max_uses AND expires_at IS NULL LIMIT 1")
    .get() as InviteRow | null;
  return existing ?? createInvite(db, { createdBy: null, grantsAdmin: true, maxUses: 1, expiresAt: null, now });
}

export function createUser(
  db: Database,
  opts: { username: string; displayName: string; passwordHash: string; isAdmin: boolean; now: number },
): UserRow {
  return db
    .query(
      `INSERT INTO users (username, display_name, password_hash, is_admin, created_at)
       VALUES ($username, $displayName, $passwordHash, $isAdmin, $now) RETURNING *`,
    )
    .get({ username: opts.username, displayName: opts.displayName, passwordHash: opts.passwordHash, isAdmin: opts.isAdmin ? 1 : 0, now: opts.now }) as UserRow;
}
