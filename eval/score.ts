// Scoring for the eval harness. Pure functions, no model and no I/O, so every number on the scorecard can be
// recomputed from the saved results and each rule is unit-tested (test/score.test.ts).
//
// The metrics:
//   router accuracy     share of messages sent down the expected route
//   recall@1            share of memory questions whose FIRST answer is the expected conversation
//                       (or that correctly say "no record", or correctly ask which one when it's ambiguous)
//   verdict accuracy    share of then-vs-now items given the expected Changed / Unchanged / Couldn't verify / No baseline
//   hallucinated quotes quotes the model proposed that are not in their source. Counted twice: as proposed
//                       (how often the model invents) and as passed on (how many got past code: must be 0)
//   profile             share of messages where the right facts were saved and nothing unsafe was saved
//   latency             median and p90 of each model call

import type { RecallResult } from "../src/memory/recall.ts";
import type { Verdict } from "../src/agent/compare.ts";

// ---- recall ----------------------------------------------------------------------------------

/** What recall answered, reduced to one comparable value: a conversation key, "none", or "ask". */
export type RecallAnswer = string; // a conversation key | "none" | "ask"

/** The conversation recall put FIRST (what @1 means), mapped from ids back to fixture keys. */
export function recallAnswer(r: RecallResult, keyOf: (conversationId: string) => string): RecallAnswer {
  switch (r.kind) {
    case "match":
      return keyOf(r.hit.conversationId);
    case "several":
      return keyOf(r.hits[0].conversationId); // listed first = what the reader sees first
    case "tie":
      return "ask";
    case "none":
      return "none";
  }
}

/** Every conversation recall offered, for recall@3. */
export function recallOffered(r: RecallResult, keyOf: (conversationId: string) => string): string[] {
  if (r.kind === "match") return [keyOf(r.hit.conversationId)];
  if (r.kind === "several") return r.hits.map((h) => keyOf(h.conversationId));
  if (r.kind === "tie") return r.options.map((h) => keyOf(h.conversationId));
  return [];
}

/** recall@k over cases. A "none" or "ask" expectation is met only by exactly that answer. */
export function recallAtK(cases: { expected: RecallAnswer; first: RecallAnswer; offered: string[] }[], k: 1 | 3): number {
  if (!cases.length) return NaN;
  const ok = cases.filter((c) => {
    if (c.expected === "none" || c.expected === "ask") return c.first === c.expected;
    return k === 1 ? c.first === c.expected : c.offered.slice(0, 3).includes(c.expected);
  });
  return ok.length / cases.length;
}

/** Wrong conversations shown alongside the right one: a precision problem even when recall@1 is right. */
export function extraOffered(cases: { expected: RecallAnswer; offered: string[] }[]): number {
  return cases.reduce((n, c) => n + c.offered.filter((k) => k !== c.expected).length, 0);
}

// ---- classification (router, verdicts) --------------------------------------------------------

export function accuracy<T>(pairs: { expected: T; got: T }[]): number {
  return pairs.length ? pairs.filter((p) => p.expected === p.got).length / pairs.length : NaN;
}

/** rows = expected, columns = got. Shows WHICH mistakes happen, not just how many. */
export function confusion(pairs: { expected: string; got: string }[], labels: string[]): number[][] {
  const m = labels.map(() => labels.map(() => 0));
  for (const p of pairs) {
    const r = labels.indexOf(p.expected);
    const c = labels.indexOf(p.got);
    if (r >= 0 && c >= 0) m[r][c]++;
  }
  return m;
}

// ---- then vs now ------------------------------------------------------------------------------

const lower = (s: string) => s.toLowerCase();
/** Same product, loosely: "HubSpot" matches "HubSpot Sales Hub Professional". */
export const sameEntity = (a: string, b: string) => lower(a).includes(lower(b)) || lower(b).includes(lower(a));

/**
 * The verdict the pipeline gave for an expected item: the first diff item for that entity whose attribute
 * mentions the expected word ("price"). "missing" when no such item exists (the claim was never extracted).
 */
export function verdictFor(items: { entity: string; attribute: string; verdict: Verdict }[], expect: { entity: string; attribute?: string }): Verdict | "missing" {
  const hit = items.find((i) => sameEntity(i.entity, expect.entity) && (!expect.attribute || i.verdict === "no_baseline" || lower(i.attribute).includes(lower(expect.attribute))));
  return hit ? hit.verdict : "missing";
}

// ---- grounding --------------------------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Quotes that are not really in their source text. Written independently of the app's own quoteAppears, so
 * the check that guards the app is itself checked: same rule (case and whitespace ignored), separate code.
 */
export function hallucinatedQuotes(quotes: { quote: string; source: string }[]): { quote: string; source: string }[] {
  return quotes.filter(({ quote, source }) => !quote.trim() || !norm(source).includes(norm(quote)));
}

// ---- profile ----------------------------------------------------------------------------------

export interface ProfileExpect {
  save?: { keys: string[]; valueIncludes: string }[]; // each must be saved: under one of `keys`, value containing the text
  forbid?: string[]; // no saved value may contain any of these (secrets, other people's facts, hypotheticals)
}

export function profileCase(saved: { key: string; value: string }[], expect: ProfileExpect): { ok: boolean; missing: string[]; unsafe: string[] } {
  const missing = (expect.save ?? [])
    .filter((e) => !saved.some((s) => e.keys.includes(s.key) && lower(s.value).includes(lower(e.valueIncludes))))
    .map((e) => `${e.keys[0]}~${e.valueIncludes}`);
  const unsafe = saved.filter((s) => (expect.forbid ?? []).some((f) => lower(s.value).includes(lower(f)))).map((s) => `${s.key}=${s.value}`);
  return { ok: missing.length === 0 && unsafe.length === 0, missing, unsafe };
}

// ---- latency ----------------------------------------------------------------------------------

/** The value below which p% of the samples fall (nearest-rank). */
export function percentile(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}
export const median = (xs: number[]) => percentile(xs, 50);
