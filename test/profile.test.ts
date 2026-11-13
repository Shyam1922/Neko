import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MAX_FACTS, ProfileStore } from "../src/memory/profile.ts";
import { JsonStore } from "../src/memory/store.ts";
import { acceptCandidates, cleanValue, labelOf, profileBlock } from "../src/agent/personalize.ts";
import { validateDecision } from "../src/agent/router.ts";

const tmp = () => mkdtemp(path.join(os.tmpdir(), "recall-prof-"));
const src = { conversationId: "c1", messageId: "m1" };
const fact = (key: string, value = "v") => ({ key, value, quote: "q" });

test("upsert adds, then replaces by key (same id, new value), and persists", async () => {
  const dir = await tmp();
  const store = new ProfileStore(dir);
  const a = await store.upsert({ key: "team_size", value: "20 people", quote: "a 20-person team" }, src);
  assert.equal(a?.previous, undefined);
  const b = await store.upsert({ key: "team_size", value: "25 people", quote: "now 25 of us" }, { conversationId: "c2", messageId: "m9" });
  assert.equal(b?.previous, "20 people");
  assert.equal(b?.fact.id, a?.fact.id);
  assert.equal(b?.fact.statedAt, a?.fact.statedAt); // first stated time kept
  const again = await new ProfileStore(dir).list(); // a fresh instance reads it from disk
  assert.deepEqual(again.map((f) => [f.key, f.value, f.conversationId]), [["team_size", "25 people", "c2"]]);
});

test("the profile lives in a subfolder, so the conversation store never mistakes it for a chat", async () => {
  const dir = await tmp();
  await new ProfileStore(dir).upsert(fact("name", "Alex"), src);
  assert.equal((await new JsonStore(dir).list()).length, 0);
  assert.ok((await readdir(dir)).includes("profile"));
});

test("edit, remove and clear; the profile is capped", async () => {
  const store = new ProfileStore(await tmp());
  const { fact: f } = (await store.upsert(fact("name", "Shy"), src))!;
  assert.equal((await store.update(f.id, "Alex"))?.value, "Alex");
  assert.equal(await store.update("nope", "x"), null);
  assert.equal(await store.remove(f.id), true);
  assert.equal(await store.remove(f.id), false);
  for (let i = 0; i < MAX_FACTS; i++) await store.upsert(fact(`key_${i}`), src);
  assert.equal(await store.upsert(fact("one_too_many"), src), null); // full
  assert.ok(await store.upsert(fact("key_3", "changed"), src)); // existing keys can still be updated
  await store.clear();
  assert.deepEqual(await store.list(), []);
});

test("cleanValue rejects secrets, emails, long numbers, and over-long or empty values", () => {
  assert.equal(cleanValue("  20   people "), "20 people");
  for (const bad of ["", "   ", "x".repeat(121), "my password is hunter2", "me@example.com", "9876543210", "4111 1111 1111 1111", "AIzaSyA1234567890abcdef", "sk-abcdefghijklmnop", "diagnosed with flu", 42]) {
    assert.equal(cleanValue(bad), null, String(bad));
  }
  assert.equal(cleanValue("500000 a month"), "500000 a month"); // a budget is fine
});

test("acceptCandidates: verbatim quote required, sane keys only, deduped, capped", () => {
  const said = "I'm Alex, I run sales for a 20-person team in Lisbon";
  const out = acceptCandidates(
    [
      { key: "Name", value: "Alex", quote: "I'm Alex" },
      { key: "name", value: "Shy", quote: "I'm Alex" }, // duplicate key
      { key: "team_size", value: "20 people", quote: "a 20-person team" },
      { key: "role", value: "CEO", quote: "I am the CEO" }, // never said
      { key: "bad key!", value: "x", quote: "I'm Alex" }, // invalid key
      { key: "password_hint", value: "x", quote: "I'm Alex" }, // sensitive key
    ],
    said,
  );
  assert.deepEqual(out.map((c) => [c.key, c.value]), [["name", "Alex"], ["team_size", "20 people"]]);
  const many = Array.from({ length: 9 }, (_, i) => ({ key: `fact_${i}`, value: "v", quote: "I'm Alex" }));
  assert.equal(acceptCandidates(many, said).length, 5);
});

test("profileBlock lists the facts and tells the model how (and how not) to use them", () => {
  assert.equal(profileBlock([]), "");
  const block = profileBlock([{ id: "1", key: "team_size", value: "20 people", quote: "q", conversationId: "c", messageId: "m", statedAt: "t", updatedAt: "t" }]);
  assert.match(block, /- Team size: 20 people/);
  assert.match(block, /never convert from memory/);
  assert.match(block, /Do not recite/);
  assert.equal(labelOf("answer_format"), "Answer format");
});

test("the router's proposed facts are shaped and capped before anything trusts them", () => {
  const ok = validateDecision({
    route: "chat", time_phrase: "", topic: "", entities: [], rejects_previous: false,
    profile_updates: [{ key: "name", value: "Alex", quote: "I'm Alex" }, { key: 5, value: "x", quote: "y" }, "junk", null],
  });
  assert.deepEqual(ok?.profileUpdates, [{ key: "name", value: "Alex", quote: "I'm Alex" }]);
  assert.deepEqual(validateDecision({ route: "chat" })?.profileUpdates, []); // missing field is fine
});
