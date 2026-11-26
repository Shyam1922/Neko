import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent, type AgentEvent } from "../src/agent/pipeline.ts";
import { ConversationStore, type Conversation } from "../src/memory/store.ts";
import { newUser, testDb } from "./db-helper.ts";
import { ProfileStore } from "../src/memory/profile.ts";
import type { JsonRequest, Llm, LlmEvent, StreamRequest } from "../src/adapters/llm.ts";
import type { Search, SearchHit } from "../src/adapters/search.ts";

const TZ = "Asia/Kolkata";
const NOW = new Date("2026-11-12T08:00:00Z"); // Thursday 12 Nov 2026

// A model that answers the router / claim extractor / comparator from canned data and records every call.
class FakeAgentLlm implements Llm {
  jsonCalls: { kind: "route" | "claims" | "compare"; prompt: string }[] = [];
  streamed: StreamRequest[] = [];
  constructor(private h: { route: (prompt: string) => unknown; claims?: (prompt: string) => unknown; compare?: (prompt: string) => unknown }) {}
  async generateJson(req: JsonRequest) {
    const props = (req.schema as any).properties;
    const kind = props.route ? "route" : props.claims ? "claims" : "compare";
    this.jsonCalls.push({ kind, prompt: req.prompt });
    return this.h[kind]!(req.prompt);
  }
  async *stream(req: StreamRequest): AsyncIterable<LlmEvent> {
    this.streamed.push(req);
    yield { type: "text", text: "ok" };
  }
  get system() {
    return this.streamed.at(-1)!.system;
  }
  count = (k: string) => this.jsonCalls.filter((c) => c.kind === k).length;
}

const decision = (o: Record<string, unknown>) => ({ route: "chat", time_phrase: "", topic: "", entities: [], rejects_previous: false, ...o });

class FakeSearch implements Search {
  calls = 0;
  constructor(private hits: SearchHit[], private fail = false) {}
  async search() {
    this.calls++;
    if (this.fail) throw new Error("search down");
    return this.hits;
  }
}

const profiles = new WeakMap<ConversationStore, ProfileStore>();
async function setup() {
  let clock = NOW;
  const db = await testDb();
  const user = await newUser();
  const store = new ConversationStore(db, user, () => clock);
  profiles.set(store, new ProfileStore(db, user, () => clock));
  const at = (iso: string) => void (clock = new Date(iso));
  return { store, at };
}

// 3 Nov: the user asked about Neon; the assistant searched and answered with a price.
async function seedNeon(store: ConversationStore, at: (iso: string) => void) {
  at("2026-11-03T06:00:00Z");
  const u = await store.append(undefined, { role: "user", text: "Postgres hosting: what does Neon cost?", tz: TZ });
  at("2026-11-03T06:01:00Z");
  const a = await store.append(u.conversation.id, {
    role: "assistant", tz: TZ,
    text: "Neon Launch is $19/month billed monthly.",
    searches: [{ query: "neon pricing", urls: ["https://neon.com/pricing"], retrievedAt: "2026-11-03T06:01:00.000Z" }],
  });
  return { conv: u.conversation, assistantId: a.message.id };
}

const textOf = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "token" ? [e.text] : [])).join("");

async function ask(llm: FakeAgentLlm, search: Search, store: ConversationStore, at: (iso: string) => void, text: string, convId?: string) {
  at(NOW.toISOString());
  const saved = await store.append(convId, { role: "user", text, tz: TZ });
  const events: AgentEvent[] = [];
  for await (const ev of runAgent({ llm, search, store, profile: profiles.get(store)! }, { conv: saved.conversation, tz: TZ, now: () => NOW })) events.push(ev);
  return { events, convId: saved.conversation.id };
}

test("chat route: one routing call, no memory lookup; search stays available in case the router misjudged", async () => {
  const { store, at } = await setup();
  const llm = new FakeAgentLlm({ route: () => decision({ route: "chat" }) });
  const { events } = await ask(llm, new FakeSearch([]), store, at, "what is 2+2?");
  assert.equal(llm.jsonCalls.length, 1);
  assert.equal(llm.streamed.length, 1); // small talk costs exactly 2 model calls: route + answer
  assert.equal(llm.streamed[0].tools?.length, 1);
  assert.equal(events.some((e) => e.type === "recall" || e.type === "search_done"), false);
});

test("memory route: answers from a record quoted verbatim by code, and remembers what it recalled", async () => {
  const { store, at } = await setup();
  const { conv } = await seedNeon(store, at);
  const llm = new FakeAgentLlm({ route: () => decision({ route: "memory", time_phrase: "3 November", topic: "Postgres hosting" }) });
  const { events } = await ask(llm, new FakeSearch([]), store, at, "What did I ask you on 3 November?");
  assert.match(llm.system, /Taking that as Tue 3 Nov/);
  assert.match(llm.system, /The user said: "Postgres hosting: what does Neon cost\?"/);
  assert.match(llm.system, /after a web search/);
  const meta = events.find((e) => e.type === "recall");
  assert.deepEqual(meta && meta.type === "recall" && meta.meta.ids, [conv.id]);
  assert.equal(llm.streamed[0].tools, undefined);
});

test("memory with no matching conversation: says there is no record, never invents one", async () => {
  const { store, at } = await setup();
  await seedNeon(store, at);
  const llm = new FakeAgentLlm({ route: () => decision({ route: "memory", time_phrase: "yesterday", topic: "Kubernetes" }) });
  const { events } = await ask(llm, new FakeSearch([]), store, at, "What did I ask yesterday about Kubernetes?");
  assert.match(textOf(events), /^I have no record of a conversation about Kubernetes from Wed 11 Nov\./); // written by code, with the resolved day
  assert.equal(llm.streamed.length, 0); // a plain "no record" needs no second model call
  assert.equal(events.some((e) => e.type === "recall"), false);
});

test("nothing in earlier conversations, but the answer is earlier in THIS chat: the model is given that chat with exact times", async () => {
  const { store, at } = await setup();
  at("2026-11-12T07:00:00Z");
  const first = await store.append(undefined, { role: "user", text: "whats the gold price today", tz: TZ });
  await store.append(first.conversation.id, { role: "assistant", text: "Gold is about $3,900 per ounce.", tz: TZ });
  const llm = new FakeAgentLlm({ route: () => decision({ route: "memory", time_phrase: "when i last asked you", topic: "gold price" }) });
  await ask(llm, new FakeSearch([]), store, at, "when did i last ask you about prices", first.conversation.id);
  assert.match(llm.system, /Earlier in this same chat/);
  assert.match(llm.system, /The user said: "whats the gold price today"/);
  assert.match(llm.system, /answer from it/);
  assert.doesNotMatch(llm.system, /no memory of earlier conversations/); // the stale contradiction is gone
});

test("no record + 'has it changed since X?': says so, then researches what changed on the web since that date", async () => {
  const { store, at } = await setup();
  const llm = new FakeAgentLlm({ route: () => decision({ route: "memory_research", time_phrase: "Last Tuesday", topic: "postgres hosting" }) });
  const { events } = await ask(llm, new FakeSearch([]), store, at, "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?");
  assert.equal(events.some((e) => e.type === "recall"), false); // nothing was recalled
  // The "no record" sentence is code's, not the model's, so it can't be reworded into a false "I have no access".
  assert.match(textOf(events), /^I have no record of a conversation about postgres hosting from Tue 10 Nov\.\n\n/);
  assert.match(llm.system, /ALREADY been shown/);
  assert.match(llm.system, /MUST call web_search/);
  assert.match(llm.system, /never state flatly that nothing has changed/);
  assert.match(llm.system, /cannot say what you told them before/);
  assert.match(llm.system, /Tue 10 Nov \(2026-11-10\)/); // the date, resolved by code, so the model can look for newer items
  assert.match(llm.system, /after that date/);
  assert.match(llm.system, /the 5 tools we shortlisted/); // asks for the list it doesn't have, while researching likely options
  assert.equal(llm.streamed[0].tools?.length, 1); // search is available this time
  assert.match(llm.system, /never say you cannot access/i); // told never to claim it lacks access: it looked and found nothing
});

test("no record on a plain memory question: no research, just an honest 'no record'", async () => {
  const { store, at } = await setup();
  const llm = new FakeAgentLlm({ route: () => decision({ route: "memory", time_phrase: "3 November" }) });
  const { events } = await ask(llm, new FakeSearch([]), store, at, "What did I ask you on 3 November?");
  assert.match(textOf(events), /^I have no record of a conversation from Tue 3 Nov\.\n\nTell me what you'd like to know/);
  assert.equal(llm.streamed.length, 0); // no research, and no second model call either
});

test("memory_research: extracts claims once, searches, compares in code, and reports CHANGED with the delta", async () => {
  const { store, at } = await setup();
  const { conv, assistantId } = await seedNeon(store, at);
  const hit: SearchHit = { url: "https://neon.com/pricing", title: "Neon pricing", publishDate: "2026-11-09", excerpts: ["Launch plan: $25 per month, billed monthly."] };
  const search = new FakeSearch([hit]);
  const llm = new FakeAgentLlm({
    route: () => decision({ route: "memory_research", time_phrase: "3 November", topic: "Postgres hosting", entities: ["Neon"] }),
    claims: () => ({ claims: [{ message_id: assistantId, quote: "Neon Launch is $19/month", entity: "Neon", attribute: "Launch plan price", value_text: "$19", amount: 19, unit: "USD/month", billing: "monthly", perishability: "volatile" }] }),
    compare: () => ({ current: [{ claim_id: `${assistantId}:0`, found: true, value_text: "$25", amount: 25, unit: "USD/month", billing: "monthly", url: hit.url, quote: "Launch plan: $25 per month" }] }),
  });

  const first = await ask(llm, search, store, at, "Has Neon changed pricing since I asked on 3 November?");
  assert.equal(llm.count("claims"), 1);
  assert.equal(search.calls, 1);
  assert.match(llm.system, /Neon \/ Launch plan price: CHANGED/);
  assert.match(llm.system, /change: \+6 \(\+31\.58%\)/);
  assert.match(llm.system, /exact uppercase label \(CHANGED, UNCHANGED, COULD NOT VERIFY, NO BASELINE\)/); // the page badges exactly these
  assert.match(llm.system, /after a web search|from a web search/);
  assert.match(llm.system, /https:\/\/neon\.com\/pricing/);
  assert.equal(llm.streamed[0].tools, undefined); // the answer call cannot search; the facts are already in
  const logs = first.events.filter((e) => e.type === "search_done");
  assert.equal(logs.length, 1);

  // Claims were cached on the old conversation: asking again does not pay for extraction again.
  assert.equal((await store.get(conv.id))?.claims?.length, 1);
  await ask(llm, search, store, at, "And now?", first.convId);
  assert.equal(llm.count("claims"), 1);
});

test("memory_research: a fabricated quote from the model never becomes a baseline", async () => {
  const { store, at } = await setup();
  const { assistantId } = await seedNeon(store, at);
  const llm = new FakeAgentLlm({
    route: () => decision({ route: "memory_research", time_phrase: "3 November", topic: "Postgres hosting", entities: ["Neon"] }),
    claims: () => ({ claims: [{ message_id: assistantId, quote: "Neon Launch is $15/month", entity: "Neon", attribute: "price", value_text: "$15", amount: 15, perishability: "volatile" }] }),
  });
  await ask(llm, new FakeSearch([]), store, at, "Has Neon changed since 3 November?");
  assert.match(llm.system, /NO BASELINE/);
  assert.doesNotMatch(llm.system, /CHANGED/);
  assert.equal(llm.streamed[0].tools?.length, 1); // may research fresh, but cannot claim a change
});

test("memory_research: when search fails the verdict is COULD NOT VERIFY, not a guess", async () => {
  const { store, at } = await setup();
  const { assistantId } = await seedNeon(store, at);
  const llm = new FakeAgentLlm({
    route: () => decision({ route: "memory_research", time_phrase: "3 November", topic: "Postgres hosting", entities: ["Neon"] }),
    claims: () => ({ claims: [{ message_id: assistantId, quote: "Neon Launch is $19/month", entity: "Neon", attribute: "price", value_text: "$19", amount: 19, unit: "USD/month", perishability: "volatile" }] }),
  });
  const { events } = await ask(llm, new FakeSearch([], true), store, at, "Has Neon changed since 3 November?");
  assert.match(llm.system, /COULD NOT VERIFY/);
  assert.equal(llm.count("compare"), 0); // nothing to read, so no model call spent
  const log = events.find((e) => e.type === "search_done");
  assert.match((log as any).log.error, /search down/);
});

test("entities the user named but we have no stored value for are reported as NO BASELINE", async () => {
  const { store, at } = await setup();
  const { assistantId } = await seedNeon(store, at);
  const hit: SearchHit = { url: "https://neon.com/pricing", title: "t", publishDate: null, excerpts: ["Launch plan: $19 per month, billed monthly."] };
  const llm = new FakeAgentLlm({
    route: () => decision({ route: "memory_research", time_phrase: "3 November", topic: "Postgres hosting", entities: ["Neon", "Supabase"] }),
    claims: () => ({ claims: [{ message_id: assistantId, quote: "Neon Launch is $19/month", entity: "Neon", attribute: "price", value_text: "$19", amount: 19, unit: "USD/month", billing: "monthly", perishability: "volatile" }] }),
    compare: () => ({ current: [{ claim_id: `${assistantId}:0`, found: true, value_text: "$19", amount: 19, unit: "USD/month", billing: "monthly", url: hit.url, quote: "Launch plan: $19 per month" }] }),
  });
  await ask(llm, new FakeSearch([hit]), store, at, "Any change for Neon and Supabase since 3 November?");
  assert.match(llm.system, /Neon \/ price: UNCHANGED/);
  assert.match(llm.system, /Supabase \/ \(anything\): NO BASELINE/);
});

test("'did we ever talk about X' with several matching chats: reports all of them with times, does not ask which", async () => {
  const { store, at } = await setup();
  // Two chats with the SAME first message (as in real use), both later mentioning Uganda.
  for (const [day, extra] of [["2026-11-12T06:00:00Z", "what is the capital of uganda"], ["2026-11-12T06:30:00Z", "tell me about uganda coffee"]] as const) {
    at(day);
    const first = await store.append(undefined, { role: "user", text: "whats the gold price today", tz: TZ });
    await store.append(first.conversation.id, { role: "user", text: extra, tz: TZ });
  }
  const llm = new FakeAgentLlm({ route: () => decision({ route: "memory", topic: "uganda" }) });
  await ask(llm, new FakeSearch([]), store, at, "did we ever talk about uganda");
  assert.match(llm.system, /matches 2 earlier conversations/);
  assert.match(llm.system, /do not ask which one/i);
  assert.match(llm.system, /direct answer/); // style rules: answer first, second person, merge duplicates
  assert.match(llm.system, /what is the capital of uganda/);
  assert.match(llm.system, /tell me about uganda coffee/);
  assert.doesNotMatch(llm.system, /Which one do you mean/);
});

test("several matches but a then-versus-now check: asks, and the options can be told apart", async () => {
  const { store, at } = await setup();
  for (const [day, extra] of [["2026-11-12T06:00:00Z", "neon pricing please"], ["2026-11-12T06:30:00Z", "neon pricing again"]] as const) {
    at(day);
    const first = await store.append(undefined, { role: "user", text: "hello there", tz: TZ });
    await store.append(first.conversation.id, { role: "user", text: extra, tz: TZ });
  }
  const llm = new FakeAgentLlm({ route: () => decision({ route: "memory_research", topic: "neon pricing" }) });
  await ask(llm, new FakeSearch([]), store, at, "has neon pricing changed since I asked?");
  assert.match(llm.system, /a comparison needs one/);
  assert.match(llm.system, /you said: "neon pricing please"/); // snippet distinguishes identical titles
  assert.match(llm.system, /you said: "neon pricing again"/);
  assert.equal(llm.count("claims"), 0); // nothing was spent extracting before the user chose
});

test("two candidate Tuesdays that both match: asks a concrete question", async () => {
  const { store, at } = await setup();
  for (const day of ["2026-11-03T06:00:00Z", "2026-11-10T06:00:00Z"]) {
    at(day);
    await store.append(undefined, { role: "user", text: "Postgres hosting question", tz: TZ });
  }
  const llm = new FakeAgentLlm({ route: () => decision({ route: "memory", time_phrase: "last Tuesday", topic: "Postgres hosting" }) });
  await ask(llm, new FakeSearch([]), store, at, "What did I ask last Tuesday about Postgres hosting?");
  assert.match(llm.system, /Which one do you mean: Tue 10 Nov.*or Tue 3 Nov/);
});

test("correction ladder: first 'wrong' excludes and retries, second asks a concrete question", async () => {
  const { store, at } = await setup();
  for (const [day, title] of [["2026-11-03T06:00:00Z", "Postgres hosting one"], ["2026-11-10T06:00:00Z", "Postgres hosting two"], ["2026-11-05T06:00:00Z", "Cooking pasta"]] as const) {
    at(day);
    await store.append(undefined, { role: "user", text: title, tz: TZ });
  }
  let n = 0;
  const llm = new FakeAgentLlm({
    route: () => (n++ === 0 ? decision({ route: "memory", topic: "Postgres hosting" }) : decision({ rejects_previous: true })),
  });
  const a = await ask(llm, new FakeSearch([]), store, at, "What did I ask about Postgres hosting?");
  // Two chats match a topic-only question: both are reported, and both are remembered as "recalled".
  assert.match(llm.system, /matches 2 earlier conversations/);
  const recalled = a.events.find((e) => e.type === "recall");
  assert.equal(recalled && recalled.type === "recall" && recalled.meta.ids.length, 2);

  // Make the conversation under discussion explicit by recording what the first answer recalled.
  const all = await store.getAll();
  const wrongOne = all.find((c) => c.title === "Postgres hosting two")!;
  at(NOW.toISOString());
  await store.append(a.convId, { role: "assistant", text: "Taking that as Tue 10 Nov", tz: TZ, recall: { ids: [wrongOne.id], topic: "Postgres hosting", route: "memory" } });

  await ask(llm, new FakeSearch([]), store, at, "No, that's not the one", a.convId);
  assert.deepEqual((await store.get(a.convId))?.rejected, [wrongOne.id]);
  assert.match(llm.system, /Postgres hosting one/); // retried without the rejected conversation
  assert.doesNotMatch(llm.system, /Postgres hosting two/);

  // Second miss: stop guessing, list real options.
  // (the test harness doesn't save agent replies, so record what the retry recalled by hand)
  at(NOW.toISOString());
  const firstOne = all.find((c) => c.title === "Postgres hosting one")!;
  await store.append(a.convId, { role: "assistant", text: "Taking that as Tue 3 Nov", tz: TZ, recall: { ids: [firstOne.id], topic: "Postgres hosting", route: "memory" } });
  await ask(llm, new FakeSearch([]), store, at, "Still wrong", a.convId);
  assert.match(llm.system, /Do not guess again/);
  assert.match(llm.system, /Cooking pasta/);
  assert.doesNotMatch(llm.system, /Postgres hosting (one|two)/);
});

test("router output that fails validation falls back to the tool-enabled research route", async () => {
  const { store, at } = await setup();
  const llm = new FakeAgentLlm({ route: () => ({ route: "banana" }) });
  await ask(llm, new FakeSearch([]), store, at, "anything");
  assert.equal(llm.streamed[0].tools?.length, 1);
});

const facts = (...f: { key: string; value: string; quote: string }[]) => ({ profile_updates: f });

test("personalisation: a fact the user states is saved, announced, and used for this very reply", async () => {
  const { store, at } = await setup();
  const llm = new FakeAgentLlm({ route: () => decision(facts({ key: "team_size", value: "20 people", quote: "we're a 20-person sales team" })) });
  const { events } = await ask(llm, new FakeSearch([]), store, at, "Hi, we're a 20-person sales team, which CRM should we pick?");
  const saved = events.find((e) => e.type === "profile");
  assert.deepEqual(saved && saved.type === "profile" && saved.saved.map((s) => [s.key, s.value]), [["team_size", "20 people"]]);
  assert.match(llm.system, /What the user has told you about themselves/);
  assert.match(llm.system, /- Team size: 20 people/);
  assert.equal(llm.count("route"), 1); // personalisation costs no extra model call
});

test("personalisation: only the user's own words count: invented quotes and sensitive values are dropped", async () => {
  const { store, at } = await setup();
  const llm = new FakeAgentLlm({
    route: () =>
      decision(facts(
        { key: "role", value: "CEO", quote: "I am the CEO" }, // not in the message
        { key: "api_key", value: "abc", quote: "my key is abc" }, // sensitive key (and not said)
        { key: "phone", value: "call me on 9876543210", quote: "call me on 9876543210" }, // long number
        { key: "location", value: "Lisbon", quote: "I'm based in Lisbon" }, // fine
      )),
  });
  const { events } = await ask(llm, new FakeSearch([]), store, at, "I'm based in Lisbon and call me on 9876543210");
  const saved = events.find((e) => e.type === "profile");
  assert.deepEqual(saved && saved.type === "profile" && saved.saved.map((s) => s.key), ["location"]);
  assert.doesNotMatch(llm.system, /CEO|9876543210/);
});

test("personalisation: a newer statement replaces the older fact and reports what it replaced", async () => {
  const { store, at } = await setup();
  const llm = new FakeAgentLlm({ route: () => decision(facts({ key: "currency", value: "INR", quote: "show prices in INR" })) });
  await ask(llm, new FakeSearch([]), store, at, "show prices in INR");
  const llm2 = new FakeAgentLlm({ route: () => decision(facts({ key: "currency", value: "USD", quote: "actually USD is better" })) });
  const { events } = await ask(llm2, new FakeSearch([]), store, at, "actually USD is better");
  const saved = events.find((e) => e.type === "profile");
  assert.deepEqual(saved && saved.type === "profile" && saved.saved.map((s) => [s.value, s.previous]), [["USD", "INR"]]);
  assert.match(llm2.system, /- Currency: USD/);
  assert.doesNotMatch(llm2.system, /INR/);
  assert.equal((await profiles.get(store)!.list()).length, 1);
});

test("personalisation: what is known carries into a brand-new chat; with nothing known there is no profile section", async () => {
  const { store, at } = await setup();
  const first = new FakeAgentLlm({ route: () => decision(facts({ key: "name", value: "Alex", quote: "I'm Alex" })) });
  await ask(first, new FakeSearch([]), store, at, "I'm Alex");
  const second = new FakeAgentLlm({ route: () => decision({}) });
  await ask(second, new FakeSearch([]), store, at, "what is 2+2?"); // no conversationId: a new chat
  assert.match(second.system, /- Name: Alex/);

  const clean = await setup();
  const third = new FakeAgentLlm({ route: () => decision({}) });
  await ask(third, new FakeSearch([]), clean.store, clean.at, "hello");
  assert.doesNotMatch(third.system, /told you about themselves/);
});

// keep the type import used
export type _Unused = Conversation;
