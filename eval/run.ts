// The eval harness: runs Neko's real code (router, recall, personalisation, claims, compare) with a real
// model against fixed fixtures, and prints a scorecard. Scoring rules live in eval/score.ts.
//
//   npm run eval                                   the configured model, all suites
//   npm run eval -- --model gemini-3.5-flash       another model
//   npm run eval -- --suites router,recall         some suites only (router, recall, profile, diff)
//
// Results (every case, every model call's timing) are written to eval/results/<model>.json.
// Web search is never called: then-vs-now scenarios bring their own fixed search results.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GeminiLlm, type JsonRequest, type Llm, type StreamRequest } from "../src/adapters/llm.ts";
import { GeminiEmbedder } from "../src/adapters/embed.ts";
import type { SearchHit } from "../src/adapters/search.ts";
import { openDb } from "../src/db/db.ts";
import { ConversationStore, type Conversation, type Message } from "../src/memory/store.ts";
import { SemanticIndex } from "../src/memory/semantic.ts";
import { createUser } from "../src/memory/users.ts";
import { recall } from "../src/memory/recall.ts";
import { route, type RouteDecision } from "../src/agent/router.ts";
import { acceptCandidates } from "../src/agent/personalize.ts";
import { extractClaims } from "../src/agent/claims.ts";
import { compareClaim, resolveCurrent, type DiffItem } from "../src/agent/compare.ts";
import { selectForRecheck } from "../src/agent/pipeline.ts";
import {
  accuracy, confusion, extraOffered, hallucinatedQuotes, median, percentile, profileCase, recallAnswer, recallAtK, recallOffered, sameEntity, verdictFor, type ProfileExpect,
} from "./score.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const load = async (name: string) => JSON.parse(await readFile(path.join(dir, "fixtures", name), "utf8"));

// ---- arguments ----------------------------------------------------------------------------------
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const apiKey = process.env.GEMINI_API_KEY?.trim();
if (!apiKey) throw new Error("GEMINI_API_KEY is missing (put it in .env).");
const model = arg("model") ?? process.env.GEMINI_MODEL?.trim() ?? "gemini-3.5-flash-lite";
const suites = new Set((arg("suites") ?? "router,recall,profile,diff").split(","));
const timeoutMs = Number(arg("timeout") ?? process.env.MODEL_TIMEOUT_SECONDS ?? 120) * 1000;
// Free keys allow only a few requests per minute per model. A chat waits at most 20s for a rate limit (a person
// is waiting); a batch eval should pace itself and wait as long as Google asks instead.
const rpm = Number(arg("rpm") ?? 12);
const MAX_RATE_LIMIT_WAITS = 6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- a model that records every call: kind, time, raw output -------------------------------------
type CallKind = "route" | "claims" | "compare" | "other";
interface Call { kind: CallKind; ms: number; raw?: unknown; error?: string; waitedMs?: number }
class RecordingLlm implements Llm {
  calls: Call[] = [];
  private nextSlot = 0;
  constructor(private inner: Llm) {}
  async generateJson(req: JsonRequest) {
    const props = (req.schema as any).properties ?? {};
    const kind: CallKind = props.route ? "route" : props.claims ? "claims" : props.current ? "compare" : "other";
    let waitedMs = 0;
    for (let attempt = 0; ; attempt++) {
      const wait = Math.max(0, this.nextSlot - Date.now());
      if (wait) await sleep(wait);
      waitedMs += wait;
      this.nextSlot = Date.now() + 60_000 / rpm;
      const t = Date.now(); // latency = the call itself, never the pacing or the waiting
      try {
        const raw = await this.inner.generateJson(req);
        this.calls.push({ kind, ms: Date.now() - t, raw, ...(waitedMs ? { waitedMs } : {}) });
        return raw;
      } catch (err: any) {
        const info = err?.name === "RateLimitError" ? err.info : undefined;
        const perMinute = info && !/PerDay/.test(`${info.limit ?? ""}`);
        if (perMinute && attempt < MAX_RATE_LIMIT_WAITS) {
          const ms = ((info.retryDelaySec ?? 30) + 2) * 1000;
          progress(`[rate limit: waiting ${Math.round(ms / 1000)}s]`);
          await sleep(ms);
          waitedMs += ms;
          continue;
        }
        this.calls.push({ kind, ms: Date.now() - t, error: String(err?.message ?? err).slice(0, 300) });
        throw err;
      }
    }
  }
  stream(req: StreamRequest) {
    return this.inner.stream(req);
  }
  last(kind: CallKind) {
    return [...this.calls].reverse().find((c) => c.kind === kind);
  }
}

const llm = new RecordingLlm(new GeminiLlm(apiKey, model, timeoutMs));
const history = await load("history.json");
const NOW = new Date(history.now);
const TZ: string = history.tz;
const fakeMessage = (text: string): Message => ({ id: "eval-msg", role: "user", text, at: NOW.toISOString(), tz: TZ, searches: [] });

// One router call per distinct message, shared by the router, recall and profile suites.
const decisions = new Map<string, RouteDecision | { error: string }>();
async function decide(text: string) {
  if (!decisions.has(text)) {
    try {
      decisions.set(text, await route(llm, [fakeMessage(text)], NOW, TZ));
    } catch (err: any) {
      decisions.set(text, { error: String(err?.message ?? err).slice(0, 200) });
    }
  }
  return decisions.get(text)!;
}
const ok = (d: RouteDecision | { error: string }): d is RouteDecision => !("error" in d);
const progress = (s: string) => process.stderr.write(s);

const report: Record<string, unknown> = { model, ranAt: new Date().toISOString(), suites: [...suites] };
const card: [string, string][] = [];
const pct = (x: number) => (Number.isNaN(x) ? "n/a" : `${Math.round(x * 100)}%`);

// ---- router ---------------------------------------------------------------------------------------
const routerFx = await load("router.json");
const recallFx = await load("recall.json");
if (suites.has("router") || suites.has("recall")) {
  const cases = [...routerFx.cases, ...recallFx.cases.map((c: any) => ({ id: c.id, text: c.text, expected: "memory" }))];
  progress(`router: ${cases.length} messages `);
  const rows: any[] = [];
  for (const c of cases) {
    const d = await decide(c.text);
    // memory and memory_research both open the memory path; for a pure memory question either is acceptable.
    const got = ok(d) ? d.route : "error";
    const accepted = c.expected === "memory" ? ["memory", "memory_research"].includes(got) : got === c.expected;
    rows.push({ id: c.id, text: c.text, expected: c.expected, got, correct: accepted, timePhrase: ok(d) ? d.timePhrase : undefined, topic: ok(d) ? d.topic : undefined });
    progress(".");
  }
  progress("\n");
  const pairs = rows.map((r) => ({ expected: r.expected, got: r.correct ? r.expected : r.got }));
  const labels = ["chat", "research", "memory", "memory_research"];
  report.router = { accuracy: accuracy(pairs), confusion: { labels, matrix: confusion(pairs, labels) }, cases: rows };
  if (suites.has("router")) card.push(["Router accuracy", `${pct(accuracy(pairs))} (${pairs.filter((p) => p.expected === p.got).length}/${pairs.length})`]);
}

// ---- recall: keywords alone vs keywords + embeddings ------------------------------------------------
if (suites.has("recall")) {
  const db = await openDb(); // in memory, thrown away afterwards
  const user = await createUser(db);
  const keyOfId = new Map<string, string>();
  for (const conv of history.conversations) {
    let minute = 0;
    const store = new ConversationStore(db, user, () => new Date(new Date(conv.at).getTime() + 60_000 * minute++));
    let id: string | undefined;
    for (const m of conv.messages) {
      const saved = await store.append(id, { role: m.role, text: m.text, tz: TZ });
      id = saved.conversation.id;
    }
    keyOfId.set(id!, conv.key);
  }
  const keyOf = (id: string) => keyOfId.get(id) ?? id;
  const pool = await new ConversationStore(db, user).getAll();
  const embedder = new GeminiEmbedder(apiKey);
  const index = new SemanticIndex(db, embedder);
  progress("recall: embedding history ");
  const embedStart = Date.now();
  await index.indexPending();
  progress(`(${Date.now() - embedStart} ms) `);

  const rows: any[] = [];
  const embedMs: number[] = [];
  for (const c of recallFx.cases) {
    const d = await decide(c.text);
    const routed = ok(d) && (d.route === "memory" || d.route === "memory_research");
    const phrase = ok(d) ? d.timePhrase : undefined;
    const topic = ok(d) ? d.topic ?? (d.entities.join(" ") || undefined) : undefined;
    let semantic: Map<string, number> | undefined;
    if (topic) {
      const t = Date.now();
      semantic = await index.similar(user, topic);
      embedMs.push(Date.now() - t);
    }
    const run = (sem?: Map<string, number>) => {
      // A message the router didn't send to memory never reaches recall: end to end, that's a miss.
      if (!routed) return { first: "not-routed", offered: [] as string[], kind: "not-routed" };
      const r = recall({ phrase, topic, now: NOW, tz: TZ, semantic: sem }, pool);
      const hits = r.kind === "match" ? [r.hit] : r.kind === "several" ? r.hits : r.kind === "tie" ? r.options : r.nearMatches;
      const scored = hits.map((h) => ({ key: keyOf(h.conversationId), score: Math.round(h.score * 100) / 100, via: h.via }));
      // Raw cosine for every chat, so thresholds can be tuned from evidence.
      const cosines = sem ? Object.fromEntries([...sem].map(([id, v]) => [keyOf(id), Math.round(v * 1000) / 1000])) : undefined;
      return { first: recallAnswer(r, keyOf), offered: recallOffered(r, keyOf), kind: r.kind, scored, ...(cosines ? { cosines } : {}) };
    };
    rows.push({ id: c.id, split: c.split, text: c.text, expected: c.expected, needs: c.needs, phrase, topic, keywords: run(undefined), hybrid: run(semantic) });
    progress(".");
  }
  progress("\n");
  const score = (mode: "keywords" | "hybrid", split?: string) => {
    const cs = rows.filter((r) => !split || r.split === split).map((r) => ({ expected: r.expected, first: r[mode].first, offered: r[mode].offered }));
    return { n: cs.length, at1: recallAtK(cs, 1), at3: recallAtK(cs, 3), extra: extraOffered(cs) };
  };
  const all = { keywords: score("keywords"), hybrid: score("hybrid") };
  const bySplit = Object.fromEntries(["dev", "holdout"].map((sp) => [sp, { keywords: score("keywords", sp), hybrid: score("hybrid", sp) }]));
  report.recall = { ...all, bySplit, embedQueryMs: { median: median(embedMs), p90: percentile(embedMs, 90) }, cases: rows };
  const line = (x: { n: number; at1: number; at3: number; extra: number }) => `${pct(x.at1)}  (@3 ${pct(x.at3)}, ${x.extra} wrong chats also offered, n=${x.n})`;
  card.push(["Recall@1, keywords only", line(all.keywords)]);
  card.push(["Recall@1, hybrid", line(all.hybrid)]);
  card.push(["  hybrid on dev / holdout", `${pct(bySplit.dev.hybrid.at1)} / ${pct(bySplit.holdout.hybrid.at1)}`]);
  await db.close();
}

// ---- profile: right facts saved, nothing unsafe saved --------------------------------------------------
if (suites.has("profile")) {
  const fx = await load("profile.json");
  progress(`profile: ${fx.cases.length} messages `);
  const rows: any[] = [];
  let proposedUnsafe = 0;
  for (const c of fx.cases) {
    const d = await decide(c.text);
    const proposed = ok(d) ? d.profileUpdates : [];
    const saved = acceptCandidates(proposed, c.text);
    const expect: ProfileExpect = { save: c.save, forbid: c.forbid };
    // What the model proposed that would have been unsafe, before code filtered it.
    const unsafeProposals = proposed.filter((p) => (c.forbid ?? []).some((f: string) => p.value.toLowerCase().includes(f.toLowerCase())));
    proposedUnsafe += unsafeProposals.length;
    rows.push({ id: c.id, text: c.text, proposed, saved, unsafeProposals, ...profileCase(saved, expect) });
    progress(".");
  }
  progress("\n");
  const passed = rows.filter((r) => r.ok).length;
  const unsafeSaved = rows.reduce((n, r) => n + r.unsafe.length, 0);
  report.profile = { accuracy: passed / rows.length, unsafeSaved, proposedUnsafe, cases: rows };
  card.push(["Profile facts correct", `${pct(passed / rows.length)} (${passed}/${rows.length})`]);
  card.push(["Unsafe facts saved", `${unsafeSaved} (the model proposed ${proposedUnsafe} unsafe ones; code is the filter)`]);
}

// ---- then vs now: claims, current values, verdicts, grounding ---------------------------------------------
if (suites.has("diff")) {
  const fx = await load("diff.json");
  progress(`diff: ${fx.scenarios.length} scenarios `);
  const rows: any[] = [];
  const proposedBad: { scenario: string; stage: string; quote: string }[] = [];
  const passedBad: { scenario: string; stage: string; quote: string }[] = [];
  const verdictPairs: { expected: string; got: string }[] = [];
  for (const s of fx.scenarios) {
    const src = s.conversation ? history.conversations.find((c: any) => c.key === s.conversation) : s;
    const conv: Conversation = {
      id: `eval-${s.id}`,
      startedAt: src.at,
      lastAt: src.at,
      title: src.messages[0].text,
      messages: src.messages.map((m: any, i: number) => ({
        id: `${s.id}-m${i}`,
        role: m.role,
        text: m.text,
        at: new Date(new Date(src.at).getTime() + i * 60_000).toISOString(),
        tz: TZ,
        searches: m.searched ? [{ query: "earlier search", urls: ["https://example.com/earlier"], retrievedAt: src.at }] : [],
      })),
    };
    const fixtureHits = Object.entries(s.hits as Record<string, Omit<SearchHit, "publishDate">[]>);
    const hitsFor = (entity: string): SearchHit[] => fixtureHits.filter(([k]) => sameEntity(k, entity)).flatMap(([, hs]) => hs.map((h) => ({ ...h, publishDate: null })));
    let items: DiffItem[] = [];
    let error: string | undefined;
    try {
      const claims = await extractClaims(llm, conv);
      // Grounding, stage 1: every quote the model proposed for a claim, checked against its message.
      for (const c of ((llm.last("claims")?.raw as any)?.claims ?? []) as any[]) {
        const msg = conv.messages.find((m) => m.id === c.message_id);
        for (const h of hallucinatedQuotes([{ quote: String(c.quote ?? ""), source: msg?.text ?? "" }])) proposedBad.push({ scenario: s.id, stage: "claim", quote: h.quote });
      }
      for (const h of hallucinatedQuotes(claims.map((c) => ({ quote: c.quote, source: conv.messages.find((m) => m.id === c.messageId)!.text }))))
        passedBad.push({ scenario: s.id, stage: "claim", quote: h.quote });

      const sel = selectForRecheck(claims, s.named);
      items = [...sel.items];
      if (sel.rechecked.length) {
        const hitsByEntity = new Map(sel.entities.map((e) => [e, hitsFor(e)] as const));
        const current = await resolveCurrent(llm, sel.rechecked, hitsByEntity);
        // Grounding, stage 2: every current value the model said it FOUND, checked against that product's results.
        for (const r of ((llm.last("compare")?.raw as any)?.current ?? []) as any[]) {
          if (r.found !== true) continue;
          const claim = sel.rechecked.find((c) => c.id === r.claim_id);
          const source = claim ? hitsFor(claim.entity).flatMap((h) => h.excerpts).join("\n") : "";
          for (const h of hallucinatedQuotes([{ quote: String(r.quote ?? ""), source }])) proposedBad.push({ scenario: s.id, stage: "current", quote: h.quote });
        }
        items.push(...sel.rechecked.map((c) => compareClaim(c, current.get(c.id) ?? null)));
        for (const it of items) {
          if (!it.current) continue;
          const source = hitsFor(it.entity).flatMap((h) => h.excerpts).join("\n");
          for (const h of hallucinatedQuotes([{ quote: it.current.quote, source }])) passedBad.push({ scenario: s.id, stage: "current", quote: h.quote });
        }
      }
    } catch (err: any) {
      error = String(err?.message ?? err).slice(0, 200);
    }
    const expected = s.expect.map((e: any) => {
      const got = error ? "error" : verdictFor(items, e);
      verdictPairs.push({ expected: e.verdict, got });
      return { ...e, got, correct: got === e.verdict };
    });
    rows.push({ id: s.id, error, items: items.map((i) => ({ entity: i.entity, attribute: i.attribute, verdict: i.verdict, reason: i.reason, was: i.baseline?.valueText, now: i.current?.valueText })), expected });
    progress(".");
  }
  progress("\n");
  const labels = ["changed", "unchanged", "couldnt_verify", "no_baseline", "missing", "error"];
  report.diff = { verdictAccuracy: accuracy(verdictPairs), confusion: { labels, matrix: confusion(verdictPairs, labels) }, hallucinatedProposed: proposedBad, hallucinatedPassed: passedBad, scenarios: rows };
  card.push(["Verdict accuracy", `${pct(accuracy(verdictPairs))} (${verdictPairs.filter((p) => p.expected === p.got).length}/${verdictPairs.length})`]);
  card.push(["Invented quotes reaching the answer", `${passedBad.length} (the model proposed ${proposedBad.length} quotes not in their source; code dropped them)`]);
}

// ---- latency and the scorecard ----------------------------------------------------------------------------
const byKind = (k: CallKind) => llm.calls.filter((c) => c.kind === k && !c.error).map((c) => c.ms);
const latency = Object.fromEntries((["route", "claims", "compare"] as const).map((k) => [k, { n: byKind(k).length, median: median(byKind(k)), p90: percentile(byKind(k), 90) }]));
const errors = llm.calls.filter((c) => c.error);
report.latency = latency;
report.modelErrors = errors.map((e) => ({ kind: e.kind, error: e.error }));
const sec = (ms: number) => (Number.isNaN(ms) ? "n/a" : `${(ms / 1000).toFixed(1)}s`);
card.push(["Median latency per model call", (["route", "claims", "compare"] as const).filter((k) => latency[k].n).map((k) => `${k} ${sec(latency[k].median)} (p90 ${sec(latency[k].p90)})`).join(", ")]);
card.push(["Model calls / errors", `${llm.calls.length} / ${errors.length}`]);
// A run where the model mostly failed (overload, quota) scores the provider's availability, not the model's
// quality. Say so on the card and in the saved results, so nobody quotes its numbers as accuracy.
const errorRate = llm.calls.length ? errors.length / llm.calls.length : 0;
report.valid = errorRate <= 0.1;
if (!report.valid) card.unshift(["INVALID RUN", `${Math.round(errorRate * 100)}% of model calls failed: the scores below measure availability, not quality`]);

const outDir = path.join(dir, "results");
await mkdir(outDir, { recursive: true });
const outFile = path.join(outDir, `${model.replace(/[^a-z0-9.-]/gi, "_")}.json`);
await writeFile(outFile, JSON.stringify(report, null, 2));

const w = Math.max(...card.map(([k]) => k.length));
console.log(`\nNeko eval · ${model} · ${new Date().toISOString().slice(0, 10)}\n`);
for (const [k, v] of card) console.log(`  ${k.padEnd(w)}  ${v}`);
console.log(`\nEvery case and call: ${path.relative(process.cwd(), outFile)}`);
