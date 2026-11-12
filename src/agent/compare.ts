// Then versus now. The model reads search results and proposes the CURRENT value for each
// old claim, with a quote. Code does everything that decides the outcome: it checks the
// quote is really in that page's excerpt, checks the number is really in the quote,
// insists on like-for-like (same plan, billing period, unit), and computes the verdict.

import type { Llm } from "../adapters/llm.ts";
import type { SearchHit } from "../adapters/search.ts";
import type { Claim } from "../memory/store.ts";
import { quoteAppears } from "./claims.ts";

export type Verdict = "changed" | "unchanged" | "couldnt_verify" | "no_baseline";
type Qualifiers = Claim["qualifiers"];

export interface CurrentValue {
  claimId: string;
  valueText: string;
  amount?: number;
  unit?: string;
  qualifiers: Qualifiers;
  url: string;
  quote: string;
  publishDate: string | null;
}

export interface DiffItem {
  entity: string;
  attribute: string;
  verdict: Verdict;
  baseline?: Pick<Claim, "valueText" | "amount" | "unit" | "assertedAt" | "provenance" | "qualifiers">;
  current?: Pick<CurrentValue, "valueText" | "amount" | "unit" | "url" | "quote" | "publishDate">;
  delta?: { abs: number; pct?: number };
  reason?: string;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const round2 = (n: number) => Math.round(n * 100) / 100;
/** The numbers that appear in a piece of text, ignoring thousands separators ("$1,500" -> 1500). */
const figures = (s: string) => new Set((s.replace(/(\d),(?=\d{3})/g, "$1").match(/\d+(?:\.\d+)?/g) ?? []).map(Number));

/** True if the number appears in the quote (ignoring thousands separators). */
export function quoteHasNumber(quote: string, amount: number): boolean {
  const nums = quote.replace(/(\d),(?=\d{3})/g, "$1").match(/\d+(?:\.\d+)?/g) ?? [];
  return nums.some((n) => Number(n) === amount);
}

export function verifyCurrent(cv: CurrentValue, hits: SearchHit[]): CurrentValue | null {
  const hit = hits.find((h) => h.url === cv.url);
  if (!hit || !quoteAppears(cv.quote, hit.excerpts.join("\n"))) return null;
  if (cv.amount !== undefined && !quoteHasNumber(cv.quote, cv.amount)) return null;
  return { ...cv, publishDate: hit.publishDate };
}

// "USD/CU-hour" and "CU-hour" are the same unit; "USD/seat/month" and "USD/seat/year" are not.
// Currency words and symbols are ignored; what must match is what the price is per.
const unitCore = (u: string) => u.toLowerCase().replace(/usd|us\$|\$|dollars?|\bper\b|[\s/]+/g, "");
export function sameUnit(a: string, b: string): boolean {
  const x = unitCore(a);
  const y = unitCore(b);
  return x === y || x === "" || y === "";
}

export function noBaseline(entity: string): DiffItem {
  return { entity, attribute: "(anything)", verdict: "no_baseline", reason: "I have no stored value for this from the earlier conversation." };
}

export function compareClaim(old: Claim, cur: CurrentValue | null): DiffItem {
  const base = {
    entity: old.entity,
    attribute: old.attribute,
    baseline: { valueText: old.valueText, amount: old.amount, unit: old.unit, assertedAt: old.assertedAt, provenance: old.provenance, qualifiers: old.qualifiers },
  };
  if (!cur) return { ...base, verdict: "couldnt_verify", reason: "No source I found states this today." };
  const current = { valueText: cur.valueText, amount: cur.amount, unit: cur.unit, url: cur.url, quote: cur.quote, publishDate: cur.publishDate };
  const unverified = (reason: string): DiffItem => ({ ...base, current, verdict: "couldnt_verify", reason });

  // Like for like: every qualifier the old answer named must be named, and equal, in the source.
  for (const key of ["plan", "seats", "billing"] as const) {
    const was = old.qualifiers[key];
    if (!was) continue;
    const now = cur.qualifiers[key];
    if (!now) return unverified(`The source doesn't say the ${key}, so it isn't like for like (earlier: ${was}).`);
    if (now !== was && !now.includes(was) && !was.includes(now)) return unverified(`Different ${key}: earlier "${was}", source says "${now}".`);
  }

  if (old.amount !== undefined && cur.amount !== undefined) {
    if (old.unit && cur.unit && !sameUnit(old.unit, cur.unit)) return unverified(`Different unit: earlier "${old.unit}", source "${cur.unit}".`);
    const abs = round2(cur.amount - old.amount);
    if (Math.abs(abs) < 0.005) return { ...base, current, verdict: "unchanged" };
    return { ...base, current, verdict: "changed", delta: { abs, ...(old.amount !== 0 ? { pct: round2((abs / old.amount) * 100) } : {}) } };
  }
  // Non-numeric value. Different wording is NOT evidence of change (sources paraphrase), so only figures decide.
  if (norm(old.valueText) === norm(cur.valueText)) return { ...base, current, verdict: "unchanged" };
  const a = figures(old.valueText);
  const b = figures(cur.valueText);
  if (a.size > 0 && b.size > 0) {
    const aInB = [...a].every((n) => b.has(n));
    const bInA = [...b].every((n) => a.has(n));
    if (aInB && bInA) return { ...base, current, verdict: "unchanged", reason: "Worded differently, same figures." };
    if (!aInB && !bInA) return { ...base, current, verdict: "changed", reason: "The figures in the text differ." };
    // One side just mentions more figures than the other: can't tell if anything changed.
  }
  return unverified("The wording differs and there are no figures to compare, so I can't tell whether this changed.");
}

// ---- the model's part: read sources, propose current values -------------------------------

const SCHEMA = {
  type: "object",
  properties: {
    current: {
      type: "array",
      items: {
        type: "object",
        properties: {
          claim_id: { type: "string" },
          found: { type: "boolean", description: "False if the sources do not state this fact for this plan and billing period." },
          value_text: { type: "string" },
          amount: { type: "number" },
          unit: { type: "string" },
          plan: { type: "string" },
          seats: { type: "string" },
          billing: { type: "string", description: "'annual' or 'monthly' as the source states it." },
          url: { type: "string", description: "URL of the source, exactly as given." },
          quote: { type: "string", description: "Exact words copied from that source's excerpt that state the value." },
        },
        required: ["claim_id", "found"],
      },
    },
  },
  required: ["current"],
};

const SYSTEM = [
  "You compare earlier claims against today's search results.",
  "For each claim, find the CURRENT value in the sources, for the same plan and billing period as the claim.",
  "Copy an exact quote from the source excerpt and give its URL exactly. If the sources do not state it, set found=false. Never guess or reuse the old value.",
  "Output only JSON.",
].join("\n");

const q = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().toLowerCase() : undefined);

export async function resolveCurrent(
  llm: Llm,
  claims: Claim[],
  hitsByEntity: Map<string, SearchHit[]>,
  signal?: AbortSignal,
): Promise<Map<string, CurrentValue | null>> {
  const claimLines = claims
    .map((c) => `- claim_id=${c.id} | ${c.entity} | ${c.attribute} | earlier value: ${c.valueText} | plan=${c.qualifiers.plan ?? "?"} billing=${c.qualifiers.billing ?? "?"} seats=${c.qualifiers.seats ?? "?"}`)
    .join("\n");
  const sources = [...hitsByEntity]
    .map(([entity, hits]) => `## ${entity}\n` + hits.slice(0, 4).map((h) => `URL: ${h.url}\nPublished: ${h.publishDate ?? "unknown"}\n${h.excerpts.join("\n").slice(0, 1200)}`).join("\n---\n"))
    .join("\n\n");
  const raw = (await llm.generateJson({ system: SYSTEM, prompt: `Claims:\n${claimLines}\n\nSearch results:\n${sources}`, schema: SCHEMA, signal })) as { current?: unknown };

  const out = new Map<string, CurrentValue | null>(claims.map((c) => [c.id, null]));
  for (const r of (Array.isArray(raw?.current) ? raw.current : []) as Record<string, unknown>[]) {
    const claim = claims.find((c) => c.id === r.claim_id);
    if (!claim || r.found !== true || typeof r.url !== "string" || typeof r.quote !== "string" || typeof r.value_text !== "string") continue;
    const candidate: CurrentValue = {
      claimId: claim.id,
      valueText: r.value_text.trim(),
      ...(typeof r.amount === "number" && Number.isFinite(r.amount) ? { amount: r.amount } : {}),
      ...(typeof r.unit === "string" && r.unit.trim() ? { unit: r.unit.trim() } : {}),
      qualifiers: { plan: q(r.plan), seats: q(r.seats), billing: q(r.billing) },
      url: r.url,
      quote: r.quote.trim(),
      publishDate: null,
    };
    out.set(claim.id, verifyCurrent(candidate, hitsByEntity.get(claim.entity) ?? [])); // unverifiable -> null
  }
  return out;
}
