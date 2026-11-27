import { test } from "node:test";
import assert from "node:assert/strict";
import { EMBED_DIMS, type Embedder, type EmbedKind } from "../src/adapters/embed.ts";
import { SemanticIndex } from "../src/memory/semantic.ts";
import { ConversationStore } from "../src/memory/store.ts";
import { ProfileStore } from "../src/memory/profile.ts";
import { recall, semanticScore, SEMANTIC_FLOOR, SEMANTIC_FULL } from "../src/memory/recall.ts";
import { runAgent, type AgentEvent } from "../src/agent/pipeline.ts";
import type { Llm, LlmEvent, StreamRequest } from "../src/adapters/llm.ts";
import { newUser, testDb } from "./db-helper.ts";

// A deterministic stand-in for the embedding model: words in the same concept group get the same direction,
// so "laptops" and "notebook" are close and "laptops" and "gold" are not. A small constant first component
// keeps every vector non-zero.
const CONCEPTS = [
  ["laptop", "notebook", "macbook", "computer"],
  ["postgres", "database", "neon", "hosting"],
  ["gold", "silver", "metal"],
  ["uganda", "kampala", "africa"],
];
class FakeEmbedder implements Embedder {
  readonly model = "fake-embedder";
  readonly dims = EMBED_DIMS;
  calls: { texts: string[]; kind: EmbedKind }[] = [];
  fail = false;
  async embed(texts: string[], kind: EmbedKind) {
    this.calls.push({ texts, kind });
    if (this.fail) throw new Error("quota exhausted");
    return texts.map((t) => {
      const v = new Array(EMBED_DIMS).fill(0);
      v[0] = 0.2;
      for (const w of t.toLowerCase().split(/[^a-z]+/)) {
        CONCEPTS.forEach((group, i) => {
          if (group.some((g) => w.startsWith(g))) v[i + 1] += 1;
        });
      }
      return v;
    });
  }
}

const NOW = new Date("2026-11-12T08:00:00Z");
const TZ = "Asia/Kolkata";

async function setup() {
  const db = await testDb();
  const user = await newUser();
  let clock = NOW;
  const store = new ConversationStore(db, user, () => clock);
  const embedder = new FakeEmbedder();
  const index = new SemanticIndex(db, embedder);
  const at = (iso: string) => void (clock = new Date(iso));
  return { db, user, store, embedder, index, at };
}

test("calibration: cosine maps onto the keyword scale, clamped to 0..1", () => {
  assert.equal(semanticScore(SEMANTIC_FLOOR), 0);
  assert.equal(semanticScore(SEMANTIC_FULL), 1);
  assert.equal(semanticScore(0.2), 0);
  assert.equal(semanticScore(0.99), 1);
  assert.ok(semanticScore(0.625) >= 0.499 && semanticScore(0.625) <= 0.501); // the "strong match" line
});

test("indexing embeds every message once, as documents; queries are embedded as queries", async () => {
  const { store, embedder, index, user } = await setup();
  const { conversation } = await store.append(undefined, { role: "user", text: "Which notebook should I buy?" });
  await store.append(conversation.id, { role: "assistant", text: "A MacBook Air is a good pick." });
  await index.indexPending();
  assert.ok(embedder.calls.every((c) => c.kind === "document"));
  const embeddedOnce = embedder.calls.flatMap((c) => c.texts);
  assert.ok(embeddedOnce.includes("Which notebook should I buy?"));

  const before = embedder.calls.length;
  await index.indexPending(); // nothing new for this user
  const again = embedder.calls.slice(before).flatMap((c) => c.texts);
  assert.ok(!again.includes("Which notebook should I buy?"));

  const sims = await index.similar(user, "laptops");
  assert.equal(embedder.calls.at(-1)!.kind, "query");
  assert.ok(sims.get(conversation.id)! > 0.9);
});

test("similarity search is per user: another user's chats are never candidates", async () => {
  const a = await setup();
  const { conversation } = await a.store.append(undefined, { role: "user", text: "Which notebook should I buy?" });
  await a.index.indexPending();
  const bob = await newUser();
  assert.equal((await a.index.similar(bob, "laptops")).has(conversation.id), false);
});

test("deleting a conversation deletes its vectors", async () => {
  const { db, store, index, user } = await setup();
  const { conversation } = await store.append(undefined, { role: "user", text: "gold price?" });
  await index.indexPending();
  await store.remove(conversation.id);
  assert.equal((await index.similar(user, "gold")).size, 0);
  const { rows } = await db.query("SELECT count(*)::int AS n FROM message_embeddings WHERE conversation_id = $1", [conversation.id]);
  assert.equal(rows[0].n, 0);
});

test("kick never throws when the model fails, and catches up on the next run", async () => {
  const { store, embedder, index, user } = await setup();
  const { conversation } = await store.append(undefined, { role: "user", text: "Kampala trip" });
  embedder.fail = true;
  await index.kick(); // logged, not thrown
  embedder.fail = false;
  await index.kick();
  assert.ok((await index.similar(user, "Uganda")).get(conversation.id)! > 0.9);
});

test("hybrid recall: finds a chat by meaning when no keyword matches, and says so", async () => {
  const { store, index, user, at } = await setup();
  at("2026-11-10T06:00:00Z");
  const laptop = await store.append(undefined, { role: "user", text: "Which notebook should I buy for coding?", tz: TZ });
  at("2026-11-10T07:00:00Z");
  await store.append(undefined, { role: "user", text: "whats the gold price today", tz: TZ });
  await index.indexPending();
  const pool = await store.getAll();

  const keywordsOnly = recall({ topic: "laptops", now: NOW, tz: TZ }, pool);
  assert.equal(keywordsOnly.kind, "none"); // "laptops" never appears in the text

  const semantic = await index.similar(user, "laptops");
  const hybrid = recall({ topic: "laptops", now: NOW, tz: TZ, semantic }, pool);
  assert.equal(hybrid.kind, "match");
  assert.equal(hybrid.kind === "match" && hybrid.hit.conversationId, laptop.conversation.id);
  assert.equal(hybrid.kind === "match" && hybrid.hit.via, "meaning");
});

test("hybrid recall never overrides the date: a close match on another day is not 'Tuesday's chat'", async () => {
  const { store, index, user, at } = await setup();
  at("2026-11-09T06:00:00Z"); // Monday
  await store.append(undefined, { role: "user", text: "Which notebook should I buy?", tz: TZ });
  at("2026-11-10T06:00:00Z"); // Tuesday
  await store.append(undefined, { role: "user", text: "whats the gold price today", tz: TZ });
  await index.indexPending();
  const semantic = await index.similar(user, "laptops");
  const r = recall({ phrase: "Tuesday", topic: "laptops", now: NOW, tz: TZ, semantic }, await store.getAll());
  assert.equal(r.kind, "none");
  assert.match(r.kind === "none" ? r.message : "", /closest is "Which notebook should I buy\?" on 2026-11-09/); // offered, not assumed
});

// The whole turn: the router asks for memory, recall finds the chat by meaning, and a failing embedder
// degrades to keywords instead of breaking the turn.
class RouterLlm implements Llm {
  system = "";
  async generateJson() {
    return { route: "memory", time_phrase: "", topic: "laptops", entities: [], rejects_previous: false, profile_updates: [] };
  }
  async *stream(req: StreamRequest): AsyncIterable<LlmEvent> {
    this.system = req.system;
    yield { type: "text", text: "ok" };
  }
}

async function ask(ctx: Awaited<ReturnType<typeof setup>>, llm: RouterLlm) {
  const saved = await ctx.store.append(undefined, { role: "user", text: "did we ever talk about laptops?", tz: TZ });
  const events: AgentEvent[] = [];
  const deps = { llm, search: { search: async () => [] }, store: ctx.store, profile: new ProfileStore(ctx.db, ctx.user), semantic: ctx.index };
  for await (const ev of runAgent(deps, { conv: saved.conversation, tz: TZ, now: () => NOW })) events.push(ev);
  return events;
}

test("pipeline: a memory question finds the chat by meaning and logs hybrid mode", async () => {
  const ctx = await setup();
  ctx.at("2026-11-10T06:00:00Z");
  await ctx.store.append(undefined, { role: "user", text: "Which notebook should I buy for coding?", tz: TZ });
  await ctx.index.indexPending();
  ctx.at(NOW.toISOString());
  const llm = new RouterLlm();
  const events = await ask(ctx, llm);
  assert.ok(events.some((e) => e.type === "recall_mode" && e.mode === "hybrid"));
  assert.ok(events.some((e) => e.type === "recall"));
  assert.match(llm.system, /The user said: "Which notebook should I buy for coding\?"/); // still quoted by code
});

test("pipeline: if the embedding model is down, recall falls back to keywords and the turn still answers", async () => {
  const ctx = await setup();
  ctx.at("2026-11-10T06:00:00Z");
  await ctx.store.append(undefined, { role: "user", text: "Which notebook should I buy for coding?", tz: TZ });
  await ctx.index.indexPending();
  ctx.embedder.fail = true;
  ctx.at(NOW.toISOString());
  const events = await ask(ctx, new RouterLlm());
  const mode = events.find((e) => e.type === "recall_mode");
  assert.equal(mode && mode.type === "recall_mode" && mode.mode, "keywords");
  assert.match(events.flatMap((e) => (e.type === "token" ? [e.text] : [])).join(""), /no record/i); // keywords alone can't find it, and says so honestly
});
