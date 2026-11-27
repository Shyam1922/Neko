import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurn, type TurnEvent } from "../src/agent/research.ts";
import { toContents, type Llm, type LlmEvent, type StreamRequest } from "../src/adapters/llm.ts";
import type { Search, SearchHit, SearchInput } from "../src/adapters/search.ts";

// A model that plays back one scripted list of events per call, and records what it was sent.
class ScriptedLlm implements Llm {
  requests: StreamRequest[] = [];
  constructor(private script: LlmEvent[][]) {}
  async generateJson(): Promise<unknown> {
    throw new Error("not used in these tests");
  }
  async *stream(req: StreamRequest) {
    this.requests.push({ ...req, history: [...req.history] });
    for (const ev of this.script[this.requests.length - 1] ?? []) yield ev;
  }
}

const text = (t: string): LlmEvent => ({ type: "text", text: t });
const call = (args: Record<string, unknown>, name = "web_search"): LlmEvent => ({ type: "tool_call", call: { name, args } });
const goodCall = call({ objective: "HubSpot price", search_queries: ["hubspot sales hub price"] });

const hit: SearchHit = { url: "https://example.com/pricing", title: "Pricing", publishDate: "2026-09-09", excerpts: ["Pro is $90/seat"] };
class FakeSearch implements Search {
  calls: SearchInput[] = [];
  constructor(private fail?: Error) {}
  async search(input: SearchInput) {
    this.calls.push(input);
    if (this.fail) throw this.fail;
    return [hit];
  }
}

async function run(llm: Llm, search: Search, maxSearches?: number) {
  const events: TurnEvent[] = [];
  for await (const ev of runTurn({
    llm, search, system: "sys", history: [{ role: "user", text: "q" }], sessionId: "sess-1", maxSearches,
    now: () => new Date("2026-11-12T08:00:00Z"),
  })) events.push(ev);
  return events;
}
const reply = (events: TurnEvent[]) => events.flatMap((e) => (e.type === "token" ? [e.text] : [])).join("");

test("a plain answer makes one model call and no searches", async () => {
  const llm = new ScriptedLlm([[text("Paris.")]]);
  const search = new FakeSearch();
  const events = await run(llm, search);
  assert.equal(reply(events), "Paris.");
  assert.equal(llm.requests.length, 1);
  assert.equal(search.calls.length, 0);
  assert.equal(events.some((e) => e.type === "search_done"), false);
});

test("a tool call runs the search, feeds results back, and logs it", async () => {
  const llm = new ScriptedLlm([[goodCall], [text("Pro is $90/seat.")]]);
  const search = new FakeSearch();
  const events = await run(llm, search);
  assert.equal(reply(events), "Pro is $90/seat.");
  assert.deepEqual(search.calls[0], { objective: "HubSpot price", queries: ["hubspot sales hub price"], sessionId: "sess-1" });

  const done = events.find((e) => e.type === "search_done");
  assert.ok(done && done.type === "search_done");
  assert.deepEqual(done.log.urls, ["https://example.com/pricing"]);
  assert.equal(done.log.retrievedAt, "2026-11-12T08:00:00.000Z");
  assert.equal(done.log.error, undefined);

  // The second model call saw the tool call and its result, including source URL and date.
  const second = llm.requests[1].history;
  assert.deepEqual(second.map((t) => t.role), ["user", "tool_call", "tool_result"]);
  const result = JSON.stringify((second[2] as any).result);
  assert.match(result, /example\.com\/pricing/);
  assert.match(result, /2026-09-09/);
  assert.match(result, /untrusted/);
});

test("the search cap is enforced in code: tools are withdrawn after the limit", async () => {
  const llm = new ScriptedLlm([[goodCall], [goodCall], [text("Done.")]]);
  const search = new FakeSearch();
  const events = await run(llm, search, 2);
  assert.equal(search.calls.length, 2);
  assert.equal(llm.requests[0].tools?.length, 1);
  assert.equal(llm.requests[1].tools?.length, 1);
  assert.equal(llm.requests[2].tools, undefined); // cap reached: model must answer now
  assert.equal(reply(events), "Done.");
});

test("a call beyond the cap in the same round is refused, not executed", async () => {
  const llm = new ScriptedLlm([[goodCall, goodCall], [text("ok")]]);
  const search = new FakeSearch();
  await run(llm, search, 1);
  assert.equal(search.calls.length, 1);
  const results = llm.requests[1].history.filter((t) => t.role === "tool_result") as any[];
  assert.match(JSON.stringify(results[1].result), /limit reached/);
});

test("a failed search is logged with its error and the model is told to say it could not verify", async () => {
  const llm = new ScriptedLlm([[goodCall], [text("I could not verify that.")]]);
  const events = await run(llm, new FakeSearch(new Error("server down")));
  const done = events.find((e) => e.type === "search_done");
  assert.ok(done && done.type === "search_done");
  assert.match(done.log.error!, /server down/);
  assert.deepEqual(done.log.urls, []);
  const result = JSON.stringify((llm.requests[1].history[2] as any).result);
  assert.match(result, /could not verify/);
  assert.equal(reply(events), "I could not verify that.");
});

test("bad tool arguments and unknown tools become tool errors, not crashes", async () => {
  const llm = new ScriptedLlm([[call({ objective: "x" }), call({}, "delete_everything")], [text("fine")]]);
  const search = new FakeSearch();
  await run(llm, search);
  assert.equal(search.calls.length, 0);
  const results = llm.requests[1].history.filter((t) => t.role === "tool_result") as any[];
  assert.match(JSON.stringify(results[0].result), /search_queries/); // names the exact fields to use
  assert.match(JSON.stringify(results[1].result), /Unknown tool/);
});

test("a malformed call ('queries' instead of 'search_queries') doesn't use up the search budget", async () => {
  // Seen with a real model: two slips like this used to spend both searches without one real search.
  const slip = call({ objective: "Vercel Pro price", queries: ["vercel pro pricing"] });
  const llm = new ScriptedLlm([[slip], [slip], [goodCall], [goodCall], [text("done")]]);
  const search = new FakeSearch();
  await run(llm, search, 2);
  assert.equal(search.calls.length, 2); // both real searches still ran after two slips
});

test("a model that never stops asking for tools ends in an error", async () => {
  const llm = new ScriptedLlm([[goodCall], [goodCall], [goodCall], [goodCall], [goodCall]]);
  await assert.rejects(run(llm, new FakeSearch(), 1), /never answered/);
});

test("text before a tool call is kept in history; parallel calls merge into one model turn", () => {
  const contents = toContents([
    { role: "user", text: "q" },
    { role: "model", text: "Let me check." },
    { role: "tool_call", call: { name: "web_search", args: { a: 1 } } },
    { role: "tool_call", call: { name: "web_search", args: { a: 2 } } },
    { role: "tool_result", name: "web_search", result: 1 },
    { role: "tool_result", name: "web_search", result: 2 },
  ]);
  assert.deepEqual(contents.map((c) => [c.role, c.parts!.length]), [["user", 1], ["model", 3], ["user", 2]]);
});
