// "Watch this": facts from one of Neko's own answers, re-checked on a schedule.
//
// A watch stores the claims Neko already extracts for then-vs-now (verified quotes from the answer), so a
// re-check is the same then-vs-now check, run later by a job instead of by a question. Every query here is
// filtered by userId, like the other stores.

import { randomUUID } from "node:crypto";
import type { Db } from "../db/db.ts";
import type { DiffItem } from "../agent/compare.ts";
import type { Claim, SearchLog } from "./store.ts";

export const MAX_WATCHES = 10; // per user: each watch costs searches and a model call per re-check
export const DEFAULT_EVERY_DAYS = 7;
export const MAX_WATCH_CLAIMS = 6;

export type Outcome = "changed" | "unchanged" | "couldnt_verify" | "error";

export interface WatchCheck {
  id: string;
  checkedAt: string;
  outcome: Outcome;
  items: DiffItem[];
  searches: SearchLog[];
  error?: string;
}

export interface Watch {
  id: string;
  conversationId: string | null;
  messageId: string | null;
  title: string;
  claims: Claim[];
  status: "active" | "paused";
  everyDays: number;
  createdAt: string;
  nextCheckAt: string;
  lastCheckedAt: string | null;
  lastOutcome: Outcome | null;
  changedAt: string | null;
  unseenChange: boolean;
}

const COLS = "id, user_id, conversation_id, message_id, title, claims, status, every_days, created_at, next_check_at, last_checked_at, last_outcome, changed_at, unseen_change";
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

export function toWatch(r: any): Watch {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    messageId: r.message_id,
    title: r.title,
    claims: r.claims ?? [],
    status: r.status,
    everyDays: Number(r.every_days),
    createdAt: iso(r.created_at)!,
    nextCheckAt: iso(r.next_check_at)!,
    lastCheckedAt: iso(r.last_checked_at),
    lastOutcome: r.last_outcome ?? null,
    changedAt: iso(r.changed_at),
    unseenChange: Boolean(r.unseen_change),
  };
}

export function toCheck(r: any): WatchCheck {
  return { id: r.id, checkedAt: iso(r.checked_at)!, outcome: r.outcome, items: r.items ?? [], searches: r.searches ?? [], ...(r.error ? { error: r.error } : {}) };
}

/** A short name for a watch, from its claims: "Neon Launch plan", or "Neon and Supabase". The facts are listed in the panel. */
export function watchTitle(claims: Claim[]): string {
  const entities = [...new Set(claims.map((c) => c.entity))];
  const name = entities.length === 1 ? entities[0] : entities.length === 2 ? `${entities[0]} and ${entities[1]}` : `${entities[0]} and ${entities.length - 1} more`;
  return name.slice(0, 120);
}

export type CreateResult = { ok: true; watch: Watch } | { ok: false; reason: "limit" | "exists" };

export class WatchStore {
  constructor(private db: Db, readonly userId: string, private now: () => Date = () => new Date()) {}

  async list(): Promise<(Watch & { lastCheck: WatchCheck | null })[]> {
    const { rows } = await this.db.query(`SELECT ${COLS} FROM watches WHERE user_id = $1 ORDER BY unseen_change DESC, created_at DESC`, [this.userId]);
    const checks = await this.db.query(
      `SELECT DISTINCT ON (watch_id) watch_id, id, checked_at, outcome, items, searches, error
         FROM watch_checks WHERE user_id = $1 ORDER BY watch_id, checked_at DESC`,
      [this.userId],
    );
    const last = new Map(checks.rows.map((r: any) => [r.watch_id, toCheck(r)]));
    return rows.map((r) => ({ ...toWatch(r), lastCheck: last.get(r.id) ?? null }));
  }

  async get(id: string): Promise<(Watch & { checks: WatchCheck[] }) | null> {
    const { rows } = await this.db.query(`SELECT ${COLS} FROM watches WHERE id = $1 AND user_id = $2`, [id, this.userId]);
    if (!rows.length) return null;
    const checks = await this.db.query(
      "SELECT id, checked_at, outcome, items, searches, error FROM watch_checks WHERE watch_id = $1 AND user_id = $2 ORDER BY checked_at DESC LIMIT 10",
      [id, this.userId],
    );
    return { ...toWatch(rows[0]), checks: checks.rows.map(toCheck) };
  }

  /** Starts watching. The first re-check is due `everyDays` from now. At most MAX_WATCHES per user. */
  create(w: { conversationId: string; messageId: string; claims: Claim[]; everyDays?: number }): Promise<CreateResult> {
    return this.db.tx(async (q) => {
      await q.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [this.userId]); // two clicks can't both pass the cap
      const dup = await q.query("SELECT id FROM watches WHERE user_id = $1 AND message_id = $2", [this.userId, w.messageId]);
      if (dup.rows.length) return { ok: false, reason: "exists" } as const;
      const n = await q.query<{ n: number }>("SELECT count(*)::int AS n FROM watches WHERE user_id = $1", [this.userId]);
      if (Number(n.rows[0].n) >= MAX_WATCHES) return { ok: false, reason: "limit" } as const;
      const now = this.now();
      const every = w.everyDays ?? DEFAULT_EVERY_DAYS;
      const claims = w.claims.slice(0, MAX_WATCH_CLAIMS);
      const { rows } = await q.query(
        `INSERT INTO watches (id, user_id, conversation_id, message_id, title, claims, status, every_days, created_at, next_check_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'active', $7, $8, $9) RETURNING ${COLS}`,
        [randomUUID(), this.userId, w.conversationId, w.messageId, watchTitle(claims), JSON.stringify(claims), every, now.toISOString(), new Date(now.getTime() + every * 86_400_000).toISOString()],
      );
      return { ok: true, watch: toWatch(rows[0]) } as const;
    });
  }

  /** Pause or resume. A resumed watch is checked at the next run if it was already due. */
  async setStatus(id: string, status: "active" | "paused"): Promise<Watch | null> {
    const { rows } = await this.db.query(`UPDATE watches SET status = $3 WHERE id = $1 AND user_id = $2 RETURNING ${COLS}`, [id, this.userId, status]);
    return rows.length ? toWatch(rows[0]) : null;
  }

  /** The user has looked at the change. */
  async markSeen(id: string): Promise<boolean> {
    const { rows } = await this.db.query("UPDATE watches SET unseen_change = false WHERE id = $1 AND user_id = $2 RETURNING id", [id, this.userId]);
    return rows.length > 0;
  }

  async remove(id: string): Promise<boolean> {
    const { rows } = await this.db.query("DELETE FROM watches WHERE id = $1 AND user_id = $2 RETURNING id", [id, this.userId]);
    return rows.length > 0;
  }
}
