import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createApp, USER_COOKIE } from "../src/app.ts";
import { ConversationStore } from "../src/memory/store.ts";
import { ProfileStore } from "../src/memory/profile.ts";
import { newUser, testDb } from "./db-helper.ts";
import { NO_LIMITS, type Limits } from "../src/limits.ts";
import type { Llm, LlmEvent, StreamRequest } from "../src/adapters/llm.ts";
import type { Search } from "../src/adapters/search.ts";

class FakeLlm implements Llm {
  last?: StreamRequest;
  constructor(private pieces: string[] = ["Hello ", "there."], private fail?: Error) {}
  async generateJson() {
    return { route: "chat", time_phrase: "", topic: "", entities: [], rejects_previous: false }; // the router's answer
  }
  async *stream(req: StreamRequest) {
    this.last = req;
    for (const p of this.pieces) yield { type: "text", text: p } as LlmEvent;
    if (this.fail) throw this.fail;
  }
}

const noSearch: Search = { search: async () => [] };

// Starts the app with a fresh user. `fetch` (and `post`) send that user's cookie, like a browser would;
// `anon` is plain fetch, for a visitor with no cookie.
async function start(llm: Llm, limits?: Limits, search: Search = noSearch) {
  const db = await testDb();
  const user = await newUser();
  const now = () => new Date("2026-11-12T08:00:00Z");
  const store = new ConversationStore(db, user, now);
  const profile = new ProfileStore(db, user, now);
  const server = createApp({ db, llm, search, publicDir: path.resolve("public"), now, limits });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fetch = (url: string, init: RequestInit = {}) =>
    globalThis.fetch(url, { ...init, headers: { ...(init.headers as any), cookie: `${USER_COOKIE}=${user}` } });
  const post = (_base: string, body: unknown) => fetch(`${base}/api/chat`, { method: "POST", body: JSON.stringify(body) });
  return { base, db, user, store, profile, fetch, post, close: () => { server.closeAllConnections(); server.close(); } };
}

function events(body: string) {
  return body
    .split("\n\n")
    .filter(Boolean)
    .map((b) => ({ event: /^event: (.*)$/m.exec(b)![1], data: JSON.parse(/^data: (.*)$/m.exec(b)![1]) }));
}


test("chat streams tokens and persists both messages", async () => {
  const llm = new FakeLlm();
  const { base, store, close, fetch, post } = await start(llm);
  const res = await post(base, { text: "hi", tz: "Asia/Kolkata" });
  const evs = events(await res.text());
  assert.deepEqual(evs.map((e) => e.event), ["meta", "step", "step", "token", "token", "done"]);
  assert.deepEqual(evs.filter((e) => e.event === "step").map((e) => e.data.label), ["Understanding the question", "Writing the answer"]);
  const conv = await store.get(evs[0].data.conversationId);
  assert.deepEqual(conv?.messages.map((m) => [m.role, m.text]), [["user", "hi"], ["assistant", "Hello there."]]);
  // How long the answer took is stored on the reply and sent with the "done" event, so history shows it too.
  assert.equal(typeof conv?.messages[1].ms, "number");
  assert.equal(conv?.messages[0].ms, undefined); // only replies are timed
  assert.equal(evs.at(-1)!.data.assistantMessage.ms, conv?.messages[1].ms);
  assert.match(llm.last!.system, /Thursday, 12 November 2026/);
  close();
});

test("model failure is sent as an error event and no assistant message is saved", async () => {
  const { base, store, close, fetch, post } = await start(new FakeLlm([], new Error("boom")));
  const evs = events(await (await post(base, { text: "hi" })).text());
  assert.equal(evs.at(-1)?.event, "error");
  assert.equal(evs.at(-1)?.data.message, "boom");
  const conv = await store.get(evs[0].data.conversationId);
  assert.equal(conv?.messages.length, 1);
  close();
});

test("rejects empty text, bad ids and unknown conversations", async () => {
  const { base, close, fetch, post } = await start(new FakeLlm());
  assert.equal((await post(base, { text: "  " })).status, 400);
  assert.equal((await post(base, { text: "hi", conversationId: "../x" })).status, 400);
  assert.equal((await post(base, { text: "hi", conversationId: "nope" })).status, 404);
  close();
});

test("profile endpoints: list, edit with validation, delete one, clear all", async () => {
  const { base, store, profile, close, fetch } = await start(new FakeLlm());
  const said = await store.append(undefined, { role: "user", text: "a 20-person team" });
  const src = { conversationId: said.conversation.id, messageId: said.message.id };
  const saved = await profile.upsert({ key: "team_size", value: "20 people", quote: "a 20-person team" }, src);
  const id = saved!.fact.id;
  assert.equal((await (await fetch(`${base}/api/profile`)).json()).length, 1);

  const put = (body: unknown) => fetch(`${base}/api/profile/${id}`, { method: "PUT", body: JSON.stringify(body) });
  assert.equal((await (await put({ value: "25 people" })).json()).value, "25 people");
  assert.equal((await put({ value: "" })).status, 400);
  assert.equal((await put({ value: "my password is hunter2" })).status, 400); // looks like a secret
  assert.equal((await fetch(`${base}/api/profile/nope`, { method: "PUT", body: JSON.stringify({ value: "x" }) })).status, 404);

  assert.equal((await fetch(`${base}/api/profile/${id}`, { method: "DELETE" })).status, 200);
  assert.equal((await fetch(`${base}/api/profile/${id}`, { method: "DELETE" })).status, 404);
  await profile.upsert({ key: "name", value: "Alex", quote: "I'm Alex" }, src);
  assert.equal((await fetch(`${base}/api/profile`, { method: "DELETE" })).status, 200);
  assert.deepEqual(await (await fetch(`${base}/api/profile`)).json(), []);
  close();
});

test("conversation endpoints and static files work; path traversal is blocked", async () => {
  const { base, close, fetch, post } = await start(new FakeLlm());
  const evs = events(await (await post(base, { text: "hi" })).text());
  const id = evs[0].data.conversationId;
  assert.equal((await (await fetch(`${base}/api/conversations`)).json()).length, 1);
  assert.equal((await (await fetch(`${base}/api/conversations/${id}`)).json()).messages.length, 2);
  assert.equal((await fetch(`${base}/api/conversations/nope`)).status, 404);
  assert.match(await (await fetch(`${base}/`)).text(), /<title>Neko<\/title>/);
  assert.equal((await fetch(`${base}/..%2Fpackage.json`)).status, 404);
  close();
});

const cookieOf = (res: Response) => /neko_uid=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];

test("a first message creates an anonymous user and sets an HttpOnly cookie; later requests reuse it", async () => {
  const { base, close } = await start(new FakeLlm());
  // A visitor with no cookie sees an empty history, and no user is created just for looking.
  const look = await globalThis.fetch(`${base}/api/conversations`);
  assert.deepEqual(await look.json(), []);
  assert.equal(look.headers.get("set-cookie"), null);

  const res = await globalThis.fetch(`${base}/api/chat`, { method: "POST", body: JSON.stringify({ text: "hi" }) });
  const uid = cookieOf(res);
  assert.ok(uid);
  assert.match(res.headers.get("set-cookie")!, /HttpOnly/);
  assert.match(res.headers.get("set-cookie")!, /SameSite=Lax/);
  const convId = events(await res.text())[0].data.conversationId;

  const mine = await globalThis.fetch(`${base}/api/conversations`, { headers: { cookie: `neko_uid=${uid}` } });
  assert.deepEqual((await mine.json()).map((c: any) => c.id), [convId]);
  assert.equal(mine.headers.get("set-cookie"), null); // known user: no new cookie
  close();
});

test("an unknown or forged cookie gets a new user instead of being adopted", async () => {
  const { base, close } = await start(new FakeLlm());
  const forged = "00000000-0000-0000-0000-000000000000";
  const res = await globalThis.fetch(`${base}/api/chat`, { method: "POST", body: JSON.stringify({ text: "hi" }), headers: { cookie: `neko_uid=${forged}` } });
  const uid = cookieOf(res);
  await res.text();
  assert.ok(uid && uid !== forged);
  close();
});

test("one user cannot read, continue, rename or delete another user's chat over HTTP", async () => {
  const alice = await start(new FakeLlm());
  const evs = events(await (await alice.post(alice.base, { text: "alice's plan" })).text());
  const id = evs[0].data.conversationId;
  alice.close();

  const bob = await start(new FakeLlm()); // a different user on the same database
  assert.deepEqual(await (await bob.fetch(`${bob.base}/api/conversations`)).json(), []);
  assert.equal((await bob.fetch(`${bob.base}/api/conversations/${id}`)).status, 404);
  assert.equal((await bob.post(bob.base, { text: "hi", conversationId: id })).status, 404);
  assert.equal((await bob.fetch(`${bob.base}/api/conversations/${id}`, { method: "PATCH", body: JSON.stringify({ title: "x" }) })).status, 404);
  assert.equal((await bob.fetch(`${bob.base}/api/conversations/${id}`, { method: "DELETE" })).status, 404);
  assert.equal((await alice.store.get(id))?.messages.length, 2); // untouched
  bob.close();
});

test("rename and delete a conversation", async () => {
  const { base, store, close, fetch, post } = await start(new FakeLlm());
  const id = events(await (await post(base, { text: "hi" })).text())[0].data.conversationId;
  const patch = (body: unknown) => fetch(`${base}/api/conversations/${id}`, { method: "PATCH", body: JSON.stringify(body) });

  const ok = await patch({ title: "  My   chat  " });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).title, "My chat");
  assert.equal((await store.get(id))?.title, "My chat");
  assert.equal((await patch({ title: "   " })).status, 400);
  assert.equal((await patch({ title: "x".repeat(121) })).status, 400);
  assert.equal((await patch({})).status, 400);

  assert.equal((await fetch(`${base}/api/conversations/${id}`, { method: "DELETE" })).status, 200);
  assert.equal((await fetch(`${base}/api/conversations/${id}`)).status, 404);
  assert.equal((await fetch(`${base}/api/conversations/${id}`, { method: "DELETE" })).status, 404);
  assert.deepEqual(await (await fetch(`${base}/api/conversations`)).json(), []);
  close();
});

// Captures console.log lines written while fn runs.
async function captureLogs(fn: () => Promise<void>) {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines.flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
}

test("each turn writes one JSON log line with latency, model calls and searches, and never the raw user id", async () => {
  const { base, user, close, post } = await start(new FakeLlm());
  const logs = await captureLogs(async () => void (await (await post(base, { text: "hi" })).text()));
  const turn = logs.find((l) => l.event === "turn");
  assert.ok(turn);
  assert.equal(turn.outcome, "ok");
  assert.equal(turn.route, "chat");
  assert.equal(turn.modelCalls, 2); // router + answer
  assert.equal(turn.searches, 0);
  assert.equal(typeof turn.ms, "number");
  assert.equal(turn.outChars, "Hello there.".length);
  assert.ok(!JSON.stringify(logs).includes(user)); // the user id is the login cookie: only a hash is logged
  close();
});

test("a failed turn is logged as an error", async () => {
  const { base, close, post } = await start(new FakeLlm([], new Error("boom")));
  const logs = await captureLogs(async () => void (await (await post(base, { text: "hi" })).text()));
  const turn = logs.find((l) => l.event === "turn");
  assert.equal(turn.outcome, "error");
  assert.match(turn.error, /boom/);
  close();
});

test("over the hourly limit, chat answers 429 with a readable reason and saves nothing", async () => {
  const { base, store, close, post } = await start(new FakeLlm(), { ...NO_LIMITS, turnsPerHour: 2 });
  for (let i = 0; i < 2; i++) {
    const ok = await post(base, { text: `q${i}` });
    assert.equal(ok.status, 200);
    await ok.text(); // let the turn finish
  }
  const res = await post(base, { text: "one more" });
  assert.equal(res.status, 429);
  assert.match((await res.json()).error, /limit/);
  const all = await store.getAll();
  assert.ok(all.every((c) => c.messages.every((m) => m.text !== "one more")));
  close();
});

test("too many new users from one IP are refused", async () => {
  const { base, close } = await start(new FakeLlm(), { ...NO_LIMITS, newUsersPerIpPerHour: 2 });
  const anon = () => globalThis.fetch(`${base}/api/chat`, { method: "POST", body: JSON.stringify({ text: "hi" }) });
  for (let i = 0; i < 2; i++) {
    const ok = await anon();
    assert.equal(ok.status, 200);
    await ok.text();
  }
  const res = await anon();
  assert.equal(res.status, 429);
  assert.match((await res.json()).error, /new visitors/);
  close();
});

test("healthz reports the database is reachable", async () => {
  const { base, db, close } = await start(new FakeLlm());
  const res = await globalThis.fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, db: db.kind });
  close();
});

// A model that asks for one search, then answers citing the first result by number.
class SearchingLlm implements Llm {
  calls = 0;
  async generateJson() {
    return { route: "research", time_phrase: "", topic: "", entities: [], rejects_previous: false };
  }
  async *stream(): AsyncGenerator<LlmEvent> {
    if (this.calls++ === 0) yield { type: "tool_call", call: { name: "web_search", args: { objective: "Neon price", search_queries: ["neon launch price"] } } };
    else yield { type: "text", text: "Launch has no monthly fee [1]." };
  }
}

test("a researched turn streams its steps and its sources before the answer, and logs time to first progress", async () => {
  const search: Search = { search: async () => [{ url: "https://neon.com/pricing", title: "Pricing", publishDate: null, excerpts: ["No monthly fee"] }] };
  const lines: string[] = [];
  const log = console.log;
  console.log = (line: string) => lines.push(String(line));
  try {
    const { base, close, post } = await start(new SearchingLlm(), undefined, search);
    const evs = events(await (await post(base, { text: "What does Neon Launch cost?" })).text());
    close();
    assert.deepEqual(evs.map((e) => e.event), ["meta", "step", "step", "search_done", "step", "token", "done"]);
    assert.deepEqual(evs.filter((e) => e.event === "step").map((e) => [e.data.label, e.data.kind]), [
      ["Understanding the question", undefined],
      ["Searching: neon launch price", "search"],
      ["Writing the answer", undefined],
    ]);
    assert.deepEqual(evs[3].data.log.urls, ["https://neon.com/pricing"]); // sources arrive before the first token
    assert.deepEqual(evs.at(-1)!.data.assistantMessage.searches[0].urls, ["https://neon.com/pricing"]);
  } finally {
    console.log = log;
  }
  const turn = JSON.parse(lines.find((l) => l.includes('"event":"turn"'))!);
  assert.equal(typeof turn.firstProgressMs, "number");
  assert.ok(turn.firstProgressMs <= turn.firstTokenMs);
});
