// The scheduled re-check of watched facts. Called by POST /api/cron/recheck (a daily GitHub Actions job,
// because Render's free service sleeps and can't keep a timer) and by `npm run recheck` locally.
//
// Each call handles a bounded batch of due watches, and never more than today's model quota has left
// (TURNS_PER_DAY counts chat turns and re-checks together). The verdicts come from the same then-vs-now code
// as the chat: code decides Changed, Unchanged or Couldn't verify. A watch is marked changed, and the user
// told, only on a real Changed verdict.

import { randomUUID } from "node:crypto";
import type { Email, Mailer } from "../adapters/email.ts";
import type { Llm } from "../adapters/llm.ts";
import type { Search } from "../adapters/search.ts";
import type { Db } from "../db/db.ts";
import { dailyUsage, type Limits } from "../limits.ts";
import { logEvent, userTag } from "../log.ts";
import { notifyTarget } from "../memory/account.ts";
import type { Claim } from "../memory/store.ts";
import { toWatch, type Outcome, type Watch } from "../memory/watches.ts";
import { checkClaims, type CheckResult } from "./check.ts";
import type { DiffItem } from "./compare.ts";

export interface RecheckDeps {
  db: Db;
  llm: Llm;
  search: Search;
  now: () => Date;
  limits: Limits;
  batch: number; // most watches per call
  mailer?: Mailer;
  publicUrl: string; // for links in emails
}

export interface RecheckSummary {
  due: number;
  checked: number;
  changed: number;
  emailed: number;
  errors: number;
  quotaLeft: number | null; // null = no daily limit
}

const DAY = 86_400_000;
const RETRY_AFTER_ERROR = DAY; // a failed run (rate limit, outage) is retried tomorrow, not next week

/** The rule: "changed" only if code found a real change; "unchanged" only if every fact matched. */
export function outcomeOf(items: DiffItem[]): Exclude<Outcome, "error"> {
  if (items.some((i) => i.verdict === "changed")) return "changed";
  if (items.length > 0 && items.every((i) => i.verdict === "unchanged")) return "unchanged";
  return "couldnt_verify";
}

/** After a change, today's verified value becomes the baseline, so the same change is reported once, not weekly. */
export function rebaseline(claims: Claim[], checked: CheckResult, now: Date): Claim[] {
  return claims.map((c, i) => {
    const cur = checked.current.get(c.id);
    if (checked.items[i]?.verdict !== "changed" || !cur) return c;
    return {
      ...c,
      valueText: cur.valueText,
      ...(cur.amount !== undefined ? { amount: cur.amount } : {}),
      ...(cur.unit ? { unit: cur.unit } : {}),
      qualifiers: { ...c.qualifiers, ...Object.fromEntries(Object.entries(cur.qualifiers).filter(([, v]) => v)) },
      quote: cur.quote,
      assertedAt: now.toISOString(),
      provenance: "searched",
      sources: [cur.url],
    };
  });
}

export function changeEmail(watch: Pick<Watch, "id" | "title">, items: DiffItem[], publicUrl: string, unsubscribeToken: string): Email {
  const lines = items
    .filter((i) => i.verdict === "changed")
    .map((i) => `- ${i.entity}, ${i.attribute}: ${i.baseline?.valueText ?? "?"} -> ${i.current?.valueText ?? "?"}${i.current?.url ? `\n  Source: ${i.current.url}` : ""}`);
  const unsub = `${publicUrl}/api/email/unsubscribe?t=${encodeURIComponent(unsubscribeToken)}`;
  return {
    to: "",
    subject: `Changed: ${watch.title}`.slice(0, 140),
    text: [
      "Neko re-checked something you're watching, and it has changed.",
      "",
      watch.title,
      ...lines,
      "",
      `See it in Neko: ${publicUrl}/#watch-${watch.id}`,
      "",
      `Stop these emails: ${unsub}`,
    ].join("\n"),
    headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}

export async function runRecheck(deps: RecheckDeps, opts: { dueNow?: boolean } = {}): Promise<RecheckSummary> {
  const { db, now } = deps;
  const started = now();
  let quotaLeft: number | null = null;
  if (deps.limits.turnsPerDay > 0) quotaLeft = Math.max(0, deps.limits.turnsPerDay - (await dailyUsage(db, started)));
  const take = Math.max(0, Math.min(deps.batch, quotaLeft ?? deps.batch));
  const summary: RecheckSummary = { due: 0, checked: 0, changed: 0, emailed: 0, errors: 0, quotaLeft };
  if (take === 0) return summary;

  // Lease the batch: push its next check an hour out inside one transaction, so a second call running at the
  // same time (a retried cron, a manual run) picks different watches instead of checking these twice.
  const dueBy = opts.dueNow ? new Date(started.getTime() + 3650 * DAY) : started;
  const leased = await db.tx(async (q) => {
    const { rows } = await q.query(
      `UPDATE watches SET next_check_at = $3
        WHERE id IN (SELECT id FROM watches WHERE status = 'active' AND next_check_at <= $1
                      ORDER BY next_check_at LIMIT $2 FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [dueBy.toISOString(), take, new Date(started.getTime() + 3600_000).toISOString()],
    );
    return rows;
  });
  summary.due = leased.length;

  for (const row of leased) {
    const watch = toWatch(row);
    const userId: string = row.user_id;
    const at = now();
    try {
      const gen = checkClaims(deps.llm, deps.search, watch.claims, { sessionId: watch.id, now });
      let step = await gen.next();
      while (!step.done) step = await gen.next(); // progress events are for the chat page; nobody is watching here
      const checked = step.value;
      const outcome = outcomeOf(checked.items);
      const changed = outcome === "changed";
      await db.tx(async (q) => {
        await q.query(
          "INSERT INTO watch_checks (id, watch_id, user_id, checked_at, outcome, items, searches) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)",
          [randomUUID(), watch.id, userId, at.toISOString(), outcome, JSON.stringify(checked.items), JSON.stringify(checked.logs)],
        );
        await q.query(
          `UPDATE watches SET last_checked_at = $2, last_outcome = $3, next_check_at = $4,
                  changed_at = CASE WHEN $5 THEN $2 ELSE changed_at END,
                  unseen_change = unseen_change OR $5,
                  claims = CASE WHEN $5 THEN $6::jsonb ELSE claims END
            WHERE id = $1`,
          [watch.id, at.toISOString(), outcome, new Date(at.getTime() + watch.everyDays * DAY).toISOString(), changed, JSON.stringify(rebaseline(watch.claims, checked, at))],
        );
      });
      summary.checked++;
      if (changed) {
        summary.changed++;
        const target = deps.mailer ? await notifyTarget(db, userId) : null;
        if (deps.mailer && target) {
          try {
            await deps.mailer.send({ ...changeEmail(watch, checked.items, deps.publicUrl, target.unsubscribeToken), to: target.email });
            summary.emailed++;
          } catch (err: any) {
            logEvent("email_error", { user: userTag(userId), error: String(err?.message ?? err).slice(0, 300) }); // the in-app badge still shows it
          }
        }
      }
      logEvent("recheck", { user: userTag(userId), watch: watch.id.slice(0, 8), outcome, claims: watch.claims.length, searches: checked.logs.length });
    } catch (err: any) {
      summary.errors++;
      const error = String(err?.message ?? err).slice(0, 300);
      await db.query(
        "INSERT INTO watch_checks (id, watch_id, user_id, checked_at, outcome, error) VALUES ($1, $2, $3, $4, 'error', $5)",
        [randomUUID(), watch.id, userId, at.toISOString(), error],
      );
      await db.query("UPDATE watches SET last_checked_at = $2, last_outcome = 'error', next_check_at = $3 WHERE id = $1", [watch.id, at.toISOString(), new Date(at.getTime() + RETRY_AFTER_ERROR).toISOString()]);
      logEvent("recheck", { user: userTag(userId), watch: watch.id.slice(0, 8), outcome: "error", error });
    }
  }
  return summary;
}
