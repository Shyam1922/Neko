// Re-checking stored claims against today's sources: search, let the model read, let code decide.
// Shared by the then-vs-now chat flow (pipeline.ts) and the scheduled "Watch this" re-checks (watch/recheck.ts),
// so a watch reaches its verdict through exactly the same code as a question asked in the chat.

import type { Llm } from "../adapters/llm.ts";
import type { Search, SearchHit } from "../adapters/search.ts";
import type { Claim, SearchLog } from "../memory/store.ts";
import { compareClaim, resolveCurrent, type CurrentValue, type DiffItem } from "./compare.ts";

export type CheckEvent = { type: "searching"; queries: string[] } | { type: "search_done"; log: SearchLog } | { type: "step"; label: string };

export interface CheckResult {
  items: DiffItem[]; // one per claim, in the claims' order
  current: Map<string, CurrentValue | null>; // claim id -> the verified current value, if any
  logs: SearchLog[];
}

const unique = <T>(xs: T[]) => [...new Set(xs)];

/** One search job per product: up to two attributes, one query each. */
export function searchJobs(claims: Claim[]) {
  return unique(claims.map((c) => c.entity)).map((entity) => {
    const attrs = unique(claims.filter((c) => c.entity === entity).map((c) => c.attribute)).slice(0, 2);
    return {
      entity,
      objective: `Current ${attrs.join(" and ")} for ${entity}, with plan and billing period, from official sources.`,
      queries: attrs.map((a) => `${entity} ${a}`.slice(0, 120)),
    };
  });
}

export async function* checkClaims(
  llm: Llm,
  search: Search,
  claims: Claim[],
  opts: { sessionId: string; now: () => Date; signal?: AbortSignal },
): AsyncGenerator<CheckEvent, CheckResult> {
  const jobs = searchJobs(claims);
  yield { type: "searching", queries: jobs.flatMap((j) => j.queries) };
  const retrievedAt = opts.now().toISOString();
  const settled = await Promise.allSettled(jobs.map((j) => search.search({ objective: j.objective, queries: j.queries, sessionId: opts.sessionId })));

  const hitsByEntity = new Map<string, SearchHit[]>();
  const logs: SearchLog[] = [];
  settled.forEach((r, i) => {
    const log: SearchLog = { query: jobs[i].queries.join(" | "), urls: [], retrievedAt };
    if (r.status === "fulfilled") {
      hitsByEntity.set(jobs[i].entity, r.value);
      log.urls = r.value.map((h) => h.url);
    } else {
      log.error = String(r.reason?.message ?? r.reason).slice(0, 300);
    }
    logs.push(log);
  });
  for (const log of logs) yield { type: "search_done", log };

  // If every search failed there is nothing to read; skip the model call and report "could not verify".
  let current = new Map<string, CurrentValue | null>();
  if ([...hitsByEntity.values()].some((h) => h.length > 0)) {
    yield { type: "step", label: "Comparing then and now" };
    current = await resolveCurrent(llm, claims, hitsByEntity, opts.signal);
  }
  return { items: claims.map((c) => compareClaim(c, current.get(c.id) ?? null)), current, logs };
}
