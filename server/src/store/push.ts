import type { Database } from "bun:sqlite";

/** Browsers that asked to be woken for new messages, one row per subscription. */

export interface SubscriptionRow {
  endpoint: string;
  device_id: number;
  p256dh: string;
  auth: string;
  lang: string;
}

/** Adds or refreshes a subscription. A browser that signed in again keeps its endpoint, which then moves to the new device. */
export function saveSubscription(db: Database, deviceId: number, sub: { endpoint: string; p256dh: string; auth: string; lang: string }, now: number): void {
  db.query(
    `INSERT INTO push_subscriptions (endpoint, device_id, p256dh, auth, lang, created_at) VALUES ($endpoint, $deviceId, $p256dh, $auth, $lang, $now)
     ON CONFLICT (endpoint) DO UPDATE SET device_id = excluded.device_id, p256dh = excluded.p256dh, auth = excluded.auth, lang = excluded.lang`,
  ).run({ ...sub, deviceId, now });
}

/** Removes a subscription, but only one of this user's own devices. */
export function deleteSubscription(db: Database, userId: number, endpoint: string): boolean {
  return (
    db
      .query("DELETE FROM push_subscriptions WHERE endpoint = $endpoint AND device_id IN (SELECT id FROM devices WHERE user_id = $userId)")
      .run({ endpoint, userId }).changes > 0
  );
}

/** A push service said the subscription is gone. */
export function forgetSubscription(db: Database, endpoint: string): void {
  db.query("DELETE FROM push_subscriptions WHERE endpoint = $endpoint").run({ endpoint });
}

/** Every subscription of these users' devices. */
export function subscriptionsOf(db: Database, userIds: number[]): (SubscriptionRow & { user_id: number })[] {
  if (userIds.length === 0) return [];
  return db
    .query(
      `SELECT s.endpoint, s.device_id, s.p256dh, s.auth, s.lang, d.user_id FROM push_subscriptions s JOIN devices d ON d.id = s.device_id
       WHERE d.user_id IN (${userIds.map(() => "?").join(",")})`,
    )
    .all(...userIds) as (SubscriptionRow & { user_id: number })[];
}
