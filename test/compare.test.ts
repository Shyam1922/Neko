import { test } from "node:test";
import assert from "node:assert/strict";
import { compareClaim, quoteHasNumber, sameUnit, resolveCurrent, verifyCurrent, type CurrentValue } from "../src/agent/compare.ts";
import { quoteAppears, verifyClaims } from "../src/agent/claims.ts";
import type { Claim, Conversation } from "../src/memory/store.ts";
import type { Llm } from "../src/adapters/llm.ts";
import type { SearchHit } from "../src/adapters/search.ts";

const claim = (over: Partial<Claim> = {}): Claim => ({
  id: "m1:0", messageId: "m1", entity: "HubSpot Sales Hub", attribute: "price per seat", valueText: "$90", amount: 90, unit: "USD/seat/month",
  qualifiers: { plan: "professional", billing: "annual" }, quote: "Professional is $90/seat", assertedAt: "2026-11-03T06:00:00Z",
  provenance: "searched", perishability: "volatile", sources: [], ...over,
});
const current = (over: Partial<CurrentValue> = {}): CurrentValue => ({
  claimId: "m1:0", valueText: "$100", amount: 100, unit: "USD/seat/month", qualifiers: { plan: "professional", billing: "annual" },
  url: "https://x.com/p", quote: "Professional costs $100 per seat", publishDate: "2026-11-10", ...over,
});

test("numbers: changed, with absolute and percent delta", () => {
  const d = compareClaim(claim(), current());
  assert.equal(d.verdict, "changed");
  assert.deepEqual(d.delta, { abs: 10, pct: 11.11 });
});

test("numbers: equal is unchanged", () => {
  assert.equal(compareClaim(claim(), current({ amount: 90, valueText: "$90" })).verdict, "unchanged");
});

test("no current value found: could not verify (never 'unchanged')", () => {
  const d = compareClaim(claim(), null);
  assert.equal(d.verdict, "couldnt_verify");
  assert.equal(d.baseline?.valueText, "$90");
});

test("like for like: a different billing period or plan is not comparable", () => {
  const monthly = compareClaim(claim(), current({ qualifiers: { plan: "professional", billing: "monthly" } }));
  assert.equal(monthly.verdict, "couldnt_verify");
  assert.match(monthly.reason!, /billing/);
  const plan = compareClaim(claim(), current({ qualifiers: { plan: "enterprise", billing: "annual" } }));
  assert.equal(plan.verdict, "couldnt_verify");
});

test("like for like: a source that omits the billing period can't confirm a billing-specific baseline", () => {
  const d = compareClaim(claim(), current({ qualifiers: { plan: "professional" } }));
  assert.equal(d.verdict, "couldnt_verify");
  assert.match(d.reason!, /doesn't say the billing/);
});

test("a different unit is not comparable", () => {
  assert.equal(compareClaim(claim(), current({ unit: "USD/seat/year" })).verdict, "couldnt_verify");
});

test("units compare by what the price is per, ignoring currency wording", () => {
  assert.equal(sameUnit("USD/CU-hour", "CU-hour"), true);
  assert.equal(sameUnit("$ per GB-month", "USD/GB-month"), true);
  assert.equal(sameUnit("USD/seat/month", "USD/seat/year"), false);
  // and it flows through: same price, one unit missing its currency, is "unchanged" not "could not verify"
  assert.equal(compareClaim(claim({ unit: "USD/CU-hour", amount: 0.106 }), current({ unit: "CU-hour", amount: 0.106 })).verdict, "unchanged");
});

test("text values: only differing figures count as a change; different wording alone does not", () => {
  const text = (valueText: string) => current({ amount: undefined, unit: undefined, valueText });
  const old = claim({ amount: undefined, unit: undefined, valueText: "Up to 5 users" });
  assert.equal(compareClaim(old, text(" up to 5  USERS ")).verdict, "unchanged"); // same words
  assert.equal(compareClaim(old, text("5 users maximum")).verdict, "unchanged"); // reworded, same figure
  const changed = compareClaim(old, text("Up to 10 users"));
  assert.equal(changed.verdict, "changed"); // the figure moved
  assert.match(changed.reason!, /figures/);
});

test("text values: rewording with no figures, or one side mentioning extra figures, cannot be called a change", () => {
  const text = (valueText: string) => current({ amount: undefined, unit: undefined, valueText });
  const noFigures = claim({ amount: undefined, unit: undefined, valueText: "No monthly base fee" });
  const d = compareClaim(noFigures, text("No minimum monthly commitment, pay only for what you use"));
  assert.equal(d.verdict, "couldnt_verify");
  assert.match(d.reason!, /can't tell/);

  const egress = claim({ amount: undefined, unit: undefined, valueText: "500 GB per project included, then $0.10 per GB" });
  assert.equal(compareClaim(egress, text("Within 500 GB included")).verdict, "couldnt_verify"); // {500} inside {500, 0.10}
});

test("quote helpers ignore case, whitespace and thousands separators", () => {
  assert.equal(quoteAppears("is  $90/seat", "Professional IS $90/seat annually"), true);
  assert.equal(quoteAppears("is $95/seat", "Professional is $90/seat"), false);
  assert.equal(quoteHasNumber("one-time fee of $1,500", 1500), true);
  assert.equal(quoteHasNumber("costs $100", 90), false);
});

const hits: SearchHit[] = [{ url: "https://x.com/p", title: "P", publishDate: "2026-11-10", excerpts: ["Professional costs $100 per seat, billed annually."] }];

test("verifyCurrent drops values whose quote or number isn't in the source", () => {
  assert.equal(verifyCurrent(current(), hits)?.publishDate, "2026-11-10"); // attaches the source's date
  assert.equal(verifyCurrent(current({ quote: "Professional costs $120 per seat" }), hits), null); // quote not in page
  assert.equal(verifyCurrent(current({ url: "https://evil.com" }), hits), null); // url wasn't a search result
  assert.equal(verifyCurrent(current({ amount: 80 }), hits), null); // number not in the quote
});

const llmReturning = (json: unknown): Llm => ({ stream: async function* () {}, generateJson: async () => json });

test("resolveCurrent: unsupported or hallucinated model output becomes null", async () => {
  const c = claim();
  const good = llmReturning({ current: [{ claim_id: "m1:0", found: true, value_text: "$100", amount: 100, unit: "USD/seat/month", plan: "Professional", billing: "annual", url: "https://x.com/p", quote: "Professional costs $100 per seat" }] });
  const got = await resolveCurrent(good, [c], new Map([[c.entity, hits]]));
  assert.equal(got.get("m1:0")?.amount, 100);
  assert.equal(got.get("m1:0")?.qualifiers.plan, "professional"); // normalized

  const made = llmReturning({ current: [{ claim_id: "m1:0", found: true, value_text: "$80", amount: 80, url: "https://x.com/p", quote: "Professional costs $80 per seat" }] });
  assert.equal((await resolveCurrent(made, [c], new Map([[c.entity, hits]]))).get("m1:0"), null);

  const notFound = llmReturning({ current: [{ claim_id: "m1:0", found: false }] });
  assert.equal((await resolveCurrent(notFound, [c], new Map([[c.entity, hits]]))).get("m1:0"), null);
});

test("verifyClaims keeps only claims whose quote is really in the cited assistant message, and sets provenance from the log", () => {
  const conv: Conversation = {
    id: "c", startedAt: "2026-11-03T06:00:00Z", lastAt: "2026-11-03T06:00:00Z", title: "t",
    messages: [
      { id: "u1", role: "user", text: "prices?", at: "2026-11-03T06:00:00Z", tz: "UTC", searches: [] },
      { id: "a1", role: "assistant", text: "Professional is $90/seat billed annually.", at: "2026-11-03T06:01:00Z", tz: "UTC", searches: [{ query: "q", urls: ["https://x.com"], retrievedAt: "t" }] },
      { id: "a2", role: "assistant", text: "Starter is $9/seat.", at: "2026-11-03T06:02:00Z", tz: "UTC", searches: [{ query: "q", urls: [], retrievedAt: "t", error: "down" }] },
    ],
  };
  const row = (message_id: string, quote: string) => ({ message_id, quote, entity: "HubSpot", attribute: "price", value_text: "x", perishability: "volatile" });
  const claims = verifyClaims({ claims: [row("a1", "Professional is $90/seat"), row("a1", "Professional is $50/seat"), row("u1", "prices?"), row("zzz", "x"), row("a2", "Starter is $9/seat")] }, conv);
  assert.equal(claims.length, 2); // fabricated quote, user message and unknown id are dropped
  assert.equal(claims[0].provenance, "searched");
  assert.deepEqual(claims[0].sources, ["https://x.com"]);
  assert.equal(claims[1].provenance, "model_knowledge"); // its search failed, so it was not a searched answer
});
