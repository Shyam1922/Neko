import { test } from "node:test";
import assert from "node:assert/strict";
import { CachedSearch, parseSearchResponse, type Search, type SearchInput } from "../src/adapters/search.ts";

// Shaped like the real server's reply seen when probing it.
const sample = JSON.stringify({
  search_id: "search_abc",
  results: [
    { url: "https://blog.hubspot.com/x", title: "\n  HubSpot pricing guide \n", publish_date: "2026-09-09", excerpts: ["Pro $90/seat", "Onboarding $1,500"] },
    { url: "https://www.hubspot.com/pricing", title: "Pricing", publish_date: null, excerpts: [] },
    { title: "no url, dropped" },
  ],
});

test("parses the server's JSON-in-text reply, trims titles, keeps null dates", () => {
  const hits = parseSearchResponse(sample);
  assert.equal(hits.length, 2);
  assert.deepEqual(hits[0], { url: "https://blog.hubspot.com/x", title: "HubSpot pricing guide", publishDate: "2026-09-09", excerpts: ["Pro $90/seat", "Onboarding $1,500"] });
  assert.equal(hits[1].publishDate, null);
});

test("no results parses to an empty list; non-JSON is an error", () => {
  assert.deepEqual(parseSearchResponse('{"results":[]}'), []);
  assert.throws(() => parseSearchResponse("Rate limit exceeded"), /isn't JSON/);
});

test("cache: same queries (any order or case) hit the server once, until the TTL passes", async () => {
  let calls = 0;
  const inner: Search = { search: async () => (calls++, []) };
  let t = 0;
  const cached = new CachedSearch(inner, 1000, () => t);
  const input = (queries: string[]): SearchInput => ({ objective: "o", queries, sessionId: "s" });
  await cached.search(input(["Postgres price", "neon pricing"]));
  await cached.search(input(["NEON pricing", "postgres price"]));
  assert.equal(calls, 1);
  t = 1500;
  await cached.search(input(["postgres price", "neon pricing"]));
  assert.equal(calls, 2);
});

test("cache does not store failures", async () => {
  let calls = 0;
  const inner: Search = {
    search: async () => {
      if (calls++ === 0) throw new Error("boom");
      return [];
    },
  };
  const cached = new CachedSearch(inner);
  const input: SearchInput = { objective: "o", queries: ["q"], sessionId: "s" };
  await assert.rejects(cached.search(input), /boom/);
  await cached.search(input);
  assert.equal(calls, 2);
});
