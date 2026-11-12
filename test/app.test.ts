import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.ts";
import { JsonStore } from "../src/memory/store.ts";
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

async function start(llm: Llm) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "recall-app-"));
  const store = new JsonStore(dir, () => new Date("2026-11-12T08:00:00Z"));
  const now = () => new Date("2026-11-12T08:00:00Z");
  const server = createApp({ store, llm, search: noSearch, publicDir: path.resolve("public"), now });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, store, close: () => { server.closeAllConnections(); server.close(); } };
}

function events(body: string) {
  return body
    .split("\n\n")
    .filter(Boolean)
    .map((b) => ({ event: /^event: (.*)$/m.exec(b)![1], data: JSON.parse(/^data: (.*)$/m.exec(b)![1]) }));
}

const post = (base: string, body: unknown) =>
  fetch(`${base}/api/chat`, { method: "POST", body: JSON.stringify(body) });

test("chat streams tokens and persists both messages", async () => {
  const llm = new FakeLlm();
  const { base, store, close } = await start(llm);
  const res = await post(base, { text: "hi", tz: "Asia/Kolkata" });
  const evs = events(await res.text());
  assert.deepEqual(evs.map((e) => e.event), ["meta", "token", "token", "done"]);
  const conv = await store.get(evs[0].data.conversationId);
  assert.deepEqual(conv?.messages.map((m) => [m.role, m.text]), [["user", "hi"], ["assistant", "Hello there."]]);
  assert.match(llm.last!.system, /Thursday, 12 November 2026/);
  close();
});

test("model failure is sent as an error event and no assistant message is saved", async () => {
  const { base, store, close } = await start(new FakeLlm([], new Error("boom")));
  const evs = events(await (await post(base, { text: "hi" })).text());
  assert.equal(evs.at(-1)?.event, "error");
  assert.equal(evs.at(-1)?.data.message, "boom");
  const conv = await store.get(evs[0].data.conversationId);
  assert.equal(conv?.messages.length, 1);
  close();
});

test("rejects empty text, bad ids and unknown conversations", async () => {
  const { base, close } = await start(new FakeLlm());
  assert.equal((await post(base, { text: "  " })).status, 400);
  assert.equal((await post(base, { text: "hi", conversationId: "../x" })).status, 400);
  assert.equal((await post(base, { text: "hi", conversationId: "nope" })).status, 404);
  close();
});

test("conversation endpoints and static files work; path traversal is blocked", async () => {
  const { base, close } = await start(new FakeLlm());
  const evs = events(await (await post(base, { text: "hi" })).text());
  const id = evs[0].data.conversationId;
  assert.equal((await (await fetch(`${base}/api/conversations`)).json()).length, 1);
  assert.equal((await (await fetch(`${base}/api/conversations/${id}`)).json()).messages.length, 2);
  assert.equal((await fetch(`${base}/api/conversations/nope`)).status, 404);
  assert.match(await (await fetch(`${base}/`)).text(), /<title>Recall<\/title>/);
  assert.equal((await fetch(`${base}/..%2Fpackage.json`)).status, 404);
  close();
});
