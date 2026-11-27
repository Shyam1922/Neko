import { test } from "node:test";
import assert from "node:assert/strict";
import { recall } from "../src/memory/recall.ts";
import type { Conversation } from "../src/memory/store.ts";

// Thursday 12 November 2026.
const NOW = new Date("2026-11-12T08:30:00Z");
const TZ = "Asia/Kolkata";

let n = 0;
function conv(title: string, at: string, extra: string[] = []): Conversation {
  const id = `c${++n}`;
  const mk = (role: "user" | "assistant", text: string) => ({ id: `${id}-${n++}`, role, text, at, tz: TZ, searches: [] });
  return { id, title, startedAt: at, lastAt: at, messages: [mk("user", title), mk("assistant", "answer"), ...extra.map((t) => mk("user", t))] };
}

const postgres = conv("Postgres hosting options for a small team", "2026-11-03T06:00:00Z");
const crm = conv("CRM tools for a 20 person sales team", "2026-11-09T06:00:00Z");
const recipes = conv("Pasta recipes for dinner", "2026-11-10T06:00:00Z");
const all = [postgres, crm, recipes];
const ask = (q: Partial<Parameters<typeof recall>[0]>, data = all) => recall({ now: NOW, tz: TZ, ...q }, data);

test("date + topic picks the right conversation and states its reading", () => {
  const r = ask({ phrase: "last Tuesday", topic: "Postgres hosting pricing" });
  assert.equal(r.kind, "match");
  if (r.kind === "match") {
    assert.equal(r.hit.conversationId, postgres.id);
    assert.equal(r.reading, 'Taking that as Tue 3 Nov, the "Postgres hosting options for a small team" chat.');
  }
});

test("date alone with one conversation that day is a match", () => {
  const r = ask({ phrase: "on Monday" });
  assert.equal(r.kind, "match");
  if (r.kind === "match") assert.equal(r.hit.conversationId, crm.id);
});

test("two candidate Tuesdays both match: ask by default, or take the newer on request", () => {
  const second = conv("Postgres hosting again", "2026-11-10T09:00:00Z");
  const data = [postgres, second, crm];
  const r = ask({ phrase: "last Tuesday", topic: "Postgres hosting" }, data);
  assert.equal(r.kind, "tie");
  if (r.kind === "tie") assert.deepEqual(r.options.map((o) => o.label), ["Tue 10 Nov", "Tue 3 Nov"]);
  const recent = ask({ phrase: "last Tuesday", topic: "Postgres hosting", onAmbiguousDays: "recent" }, data);
  assert.equal(recent.kind, "match");
  if (recent.kind === "match") assert.equal(recent.hit.conversationId, second.id);
});

test("two topic-matching conversations the same day are a tie", () => {
  const a = conv("Postgres hosting on Neon", "2026-11-03T05:00:00Z");
  const b = conv("Postgres hosting on Supabase", "2026-11-03T07:00:00Z");
  const r = ask({ phrase: "3 November", topic: "Postgres hosting" }, [a, b]);
  assert.equal(r.kind, "tie");
});

test("no record: says so plainly and does not invent a baseline", () => {
  const r = ask({ phrase: "yesterday", topic: "Kubernetes" });
  assert.equal(r.kind, "none");
  if (r.kind === "none") {
    assert.equal(r.reason, "no_record");
    assert.match(r.message, /no record/);
    assert.deepEqual(r.nearMatches, []);
  }
});

test("date and topic conflict: reports no record but offers the near match", () => {
  const r = ask({ phrase: "yesterday", topic: "Postgres hosting" }); // Postgres chat was 3 Nov
  assert.equal(r.kind, "none");
  if (r.kind === "none") {
    assert.equal(r.nearMatches[0]?.conversationId, postgres.id);
    assert.match(r.message, /closest is .*Postgres/);
  }
});

test("a topic that doesn't match the day's conversation is not a match", () => {
  const r = ask({ phrase: "on Monday", topic: "Postgres hosting" }); // Monday chat is about CRMs
  assert.equal(r.kind, "none");
});

test("excluded conversations are skipped (correction ladder)", () => {
  const r = ask({ phrase: "last Tuesday", topic: "Postgres hosting", excluded: [postgres.id] });
  assert.equal(r.kind, "none");
});

test("topic only, several chats match: all are returned (best score, then newest), with distinguishing times and snippets", () => {
  const a = conv("Hello", "2026-11-03T06:00:00Z", ["what is the capital of uganda"]);
  const b = conv("Hello", "2026-11-05T06:00:00Z", ["uganda coffee exports"]);
  const r = ask({ topic: "uganda" }, [a, b, recipes]);
  assert.equal(r.kind, "several");
  if (r.kind === "several") {
    assert.deepEqual(r.hits.map((h) => h.conversationId), [b.id, a.id]); // same score: newest first
    assert.equal(r.hits[0].label, "Thu 5 Nov 11:30"); // 06:00 UTC is 11:30 in Asia/Kolkata
    assert.equal(r.hits[1].snippet, "what is the capital of uganda");
  }
});

test("a phrase that names no day ('when I last asked') falls back to the newest topic match", () => {
  const older = conv("CRM tools older chat", "2026-11-02T06:00:00Z");
  const r = ask({ phrase: "when i last asked you", topic: "CRM tools" }, [older, crm]);
  assert.equal(r.kind, "match"); // not a tie, and not "couldn't work out which day"
  if (r.kind === "match") assert.equal(r.hit.conversationId, crm.id); // the most recent one
});

test("unparsed phrase and nothing on the topic: plain no-record, without echoing the odd phrase", () => {
  const r = ask({ phrase: "when i last asked you", topic: "Kubernetes" });
  assert.equal(r.kind, "none");
  if (r.kind === "none") assert.doesNotMatch(r.message, /when i last asked/);
});

test("an unparsed phrase with no topic is reported, not guessed", () => {
  const r = ask({ phrase: "sometime recently" });
  assert.equal(r.kind, "none");
  if (r.kind === "none") assert.equal(r.reason, "unparsed_phrase");
});

test("topic only (no date) finds the best strong match", () => {
  const r = ask({ topic: "CRM sales tools" });
  assert.equal(r.kind, "match");
  if (r.kind === "match") assert.equal(r.hit.conversationId, crm.id);
});

test("a day means the day in the message's own timezone", () => {
  // 20:00 UTC on 2 Nov is already 3 Nov in Asia/Kolkata, so "3 November" finds it.
  const late = conv("Postgres hosting late night", "2026-11-02T20:00:00Z");
  const r = ask({ phrase: "3 November", topic: "Postgres hosting" }, [late]);
  assert.equal(r.kind, "match");
});

test("assistant-only days don't count as the user having asked something", () => {
  const c = conv("Pasta", "2026-11-03T06:00:00Z");
  c.messages = c.messages.filter((m) => m.role === "assistant");
  assert.equal(ask({ phrase: "3 November" }, [c]).kind, "none");
});

// ---- found by the eval set ----------------------------------------------------------------------
import { recall as recallFn } from "../src/memory/recall.ts";
import type { Conversation as Conv } from "../src/memory/store.ts";
const chat = (id: string, at: string, text: string): Conv => ({
  id, title: text, startedAt: at, lastAt: at,
  messages: [{ id: `${id}-m`, role: "user", text, at, tz: "Asia/Kolkata", searches: [] }],
});
const EVAL_NOW = new Date("2026-11-12T08:00:00Z");

test("a topic made only of words about the conversation itself is ignored: the date alone decides", () => {
  const pool = [chat("neon", "2026-11-03T06:00:00Z", "Postgres hosting: what does Neon cost?")];
  const r = recallFn({ phrase: "3 November", topic: "previous conversation", now: EVAL_NOW, tz: "Asia/Kolkata" }, pool);
  assert.equal(r.kind, "match");
  const q = recallFn({ phrase: "yesterday", topic: "previous questions", now: EVAL_NOW, tz: "Asia/Kolkata" }, [chat("trip", "2026-11-11T06:00:00Z", "Plan a trip to Goa")]);
  assert.equal(q.kind, "match");
});

test("a list of topic matches keeps only those near the best: a clear winner isn't padded with half-matches", () => {
  const pool = [
    chat("trip", "2026-11-11T06:00:00Z", "Plan my holiday trip to Goa"),
    chat("fitness", "2026-11-07T06:00:00Z", "Give me a workout plan"), // shares only "plan"
  ];
  const r = recallFn({ topic: "holiday plans", now: EVAL_NOW, tz: "Asia/Kolkata" }, pool);
  assert.equal(r.kind, "match"); // fitness (0.5) is more than 0.3 below trip (1.0)
  const twins = [chat("u1", "2026-11-10T06:00:00Z", "capital of uganda"), chat("u2", "2026-11-10T07:00:00Z", "capital of uganda?")];
  const both = recallFn({ topic: "Uganda", now: EVAL_NOW, tz: "Asia/Kolkata" }, twins);
  assert.equal(both.kind === "several" && both.hits.length, 2); // equally good matches are all listed
});
