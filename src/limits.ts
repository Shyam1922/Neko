// Protects the model key on a public deploy. Three limits, all in code:
//   - turns per user per hour        (one person can't burn the quota)
//   - turns per day across all users (the whole demo stays under the key's daily quota)
//   - new users per IP per hour      (clearing cookies doesn't buy a fresh hourly allowance)
// The first two count user messages already in the database, so they hold across restarts and across
// several app instances with no extra table. A value of 0 turns that limit off.

import type http from "node:http";
import type { Db } from "./db/db.ts";

export interface Limits {
  turnsPerHour: number;
  turnsPerDay: number;
  newUsersPerIpPerHour: number;
  trustProxy: boolean; // behind Render/Railway/Fly: the client address is in X-Forwarded-For
}

export const NO_LIMITS: Limits = { turnsPerHour: 0, turnsPerDay: 0, newUsersPerIpPerHour: 0, trustProxy: false };

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Why this user may not send another message right now, in words for them, or null if they may. */
export async function turnLimitReason(db: Db, userId: string, now: Date, limits: Limits): Promise<string | null> {
  if (limits.turnsPerHour > 0) {
    const { rows } = await db.query<{ n: number; oldest: Date | null }>(
      "SELECT count(*)::int AS n, min(at) AS oldest FROM messages WHERE user_id = $1 AND role = 'user' AND at > $2 AND at <= $3",
      [userId, new Date(now.getTime() - HOUR).toISOString(), now.toISOString()],
    );
    if (rows[0].n >= limits.turnsPerHour) {
      // The window frees up when the oldest message in it turns an hour old.
      const freeAt = new Date(rows[0].oldest!).getTime() + HOUR;
      const mins = Math.max(1, Math.ceil((freeAt - now.getTime()) / 60_000));
      return `You've sent ${limits.turnsPerHour} messages in the last hour, which is this demo's limit. You can send another in about ${mins} minute${mins === 1 ? "" : "s"}.`;
    }
  }
  if (limits.turnsPerDay > 0) {
    const { rows } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM messages WHERE role = 'user' AND at > $1 AND at <= $2",
      [new Date(now.getTime() - DAY).toISOString(), now.toISOString()],
    );
    if (rows[0].n >= limits.turnsPerDay) {
      return "Neko has used up its free model quota for today. Please try again tomorrow.";
    }
  }
  return null;
}

/** The caller's IP. Behind a proxy, the last X-Forwarded-For entry is the one the proxy added (earlier ones can be forged). */
export function clientIp(req: http.IncomingMessage, trustProxy: boolean): string {
  const fwd = req.headers["x-forwarded-for"];
  if (trustProxy && typeof fwd === "string" && fwd.trim()) return fwd.split(",").at(-1)!.trim();
  return req.socket.remoteAddress ?? "unknown";
}

/** Counts events per key over a sliding window, in memory. Good enough for one instance; resets on restart. */
export class SlidingWindow {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number, private now: () => number = Date.now) {}

  /** Records a hit and returns true, or returns false if the key is already at the limit. */
  take(key: string): boolean {
    if (this.max <= 0) return true;
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => x > t - this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.prune(t); // keep memory bounded under a flood of addresses
    return true;
  }

  private prune(t: number) {
    for (const [k, v] of this.hits) if (!v.some((x) => x > t - this.windowMs)) this.hits.delete(k);
  }
}
