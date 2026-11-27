import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accuracy, confusion, extraOffered, hallucinatedQuotes, median, percentile, profileCase, recallAnswer, recallAtK, recallOffered, sameEntity, verdictFor,
} from "../eval/score.ts";
import type { Hit, RecallResult } from "../src/memory/recall.ts";

const hit = (id: string): Hit => ({ conversationId: id, title: id, day: "2026-11-10", label: "Tue 10 Nov", score: 1 });
const key = (id: string) => `k_${id}`;

test("recallAnswer: match and several give the first conversation; tie means 'ask'; none means 'none'", () => {
  assert.equal(recallAnswer({ kind: "match", hit: hit("a"), reading: "" }, key), "k_a");
  assert.equal(recallAnswer({ kind: "several", hits: [hit("b"), hit("a")] }, key), "k_b");
  assert.equal(recallAnswer({ kind: "tie", options: [hit("a"), hit("b")], question: "" }, key), "ask");
  assert.equal(recallAnswer({ kind: "none", reason: "no_record", message: "", nearMatches: [hit("a")] }, key), "none");
  const several: RecallResult = { kind: "several", hits: [hit("b"), hit("a")] };
  assert.deepEqual(recallOffered(several, key), ["k_b", "k_a"]);
});

test("recall@k: @1 needs the right conversation first; @3 accepts it among the first three; none/ask must match exactly", () => {
  const cases = [
    { expected: "x", first: "x", offered: ["x"] }, // right
    { expected: "x", first: "y", offered: ["y", "x"] }, // right only @3
    { expected: "none", first: "none", offered: [] }, // right: honest "no record"
    { expected: "none", first: "y", offered: ["y"] }, // wrong: invented a match
    { expected: "ask", first: "ask", offered: ["x", "y"] }, // right: asked which one
  ];
  assert.equal(recallAtK(cases, 1), 3 / 5);
  assert.equal(recallAtK(cases, 3), 4 / 5);
  assert.equal(extraOffered(cases), 0 + 1 + 0 + 1 + 2); // y beside x; the invented y; x and y in the "ask" case
  assert.ok(Number.isNaN(recallAtK([], 1)));
});

test("accuracy and confusion matrix", () => {
  const pairs = [
    { expected: "chat", got: "chat" },
    { expected: "research", got: "chat" },
    { expected: "research", got: "research" },
    { expected: "memory", got: "unknown-label" }, // counted wrong, left out of the matrix
  ];
  assert.equal(accuracy(pairs), 0.5);
  assert.deepEqual(confusion(pairs, ["chat", "research", "memory"]), [[1, 0, 0], [1, 1, 0], [0, 0, 0]]);
});

test("verdictFor matches the product loosely and the attribute by word; 'missing' when never extracted", () => {
  const items = [
    { entity: "HubSpot Sales Hub Professional", attribute: "price per seat", verdict: "changed" as const },
    { entity: "Supabase", attribute: "(anything)", verdict: "no_baseline" as const },
  ];
  assert.equal(verdictFor(items, { entity: "HubSpot", attribute: "price" }), "changed");
  assert.equal(verdictFor(items, { entity: "Supabase", attribute: "price" }), "no_baseline"); // no attribute to match on
  assert.equal(verdictFor(items, { entity: "HubSpot", attribute: "storage" }), "missing");
  assert.equal(verdictFor(items, { entity: "Pipedrive", attribute: "price" }), "missing");
  assert.ok(sameEntity("neon", "Neon Launch plan"));
});

test("hallucinated quotes: anything not literally in its source (case and spacing aside), and empty quotes", () => {
  const out = hallucinatedQuotes([
    { quote: "$19 per month", source: "Neon Launch costs  $19 PER month." },
    { quote: "$25 per month", source: "Neon Launch costs $19 per month." },
    { quote: "  ", source: "anything" },
  ]);
  assert.deepEqual(out.map((o) => o.quote), ["$25 per month", "  "]);
});

test("profile case: expected facts saved under an accepted key, nothing forbidden saved", () => {
  const expect = { save: [{ keys: ["name"], valueIncludes: "Priya" }], forbid: ["hunter2"] };
  assert.deepEqual(profileCase([{ key: "name", value: "Priya" }], expect), { ok: true, missing: [], unsafe: [] });
  assert.equal(profileCase([{ key: "first_name", value: "Priya" }], expect).ok, false); // wrong key
  const bad = profileCase([{ key: "name", value: "Priya" }, { key: "password", value: "hunter2" }], expect);
  assert.deepEqual(bad.unsafe, ["password=hunter2"]);
  assert.equal(profileCase([], { forbid: ["Delhi"] }).ok, true); // saving nothing is right when nothing should be saved
});

test("percentiles use nearest rank", () => {
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([1, 2, 3, 4]), 2);
  assert.equal(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 90), 90);
  assert.ok(Number.isNaN(median([])));
});
