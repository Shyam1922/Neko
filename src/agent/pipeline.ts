// One user turn, end to end:
//
//   route (1 model call) -> memory lookup (code) -> [claims + search + compare] -> answer (1 model call)
//
// Code is the librarian: it finds the conversation, quotes it verbatim, runs the searches and
// decides the verdicts. The model only classifies, reads, and writes the final reply.

import type { Llm, Turn } from "../adapters/llm.ts";
import type { Search, SearchHit } from "../adapters/search.ts";
import { dayOf, resolveTimePhrase } from "../memory/dates.ts";
import type { SemanticIndex } from "../memory/semantic.ts";
import { withTimeout } from "../adapters/timeout.ts";
import { recall } from "../memory/recall.ts";
import type { ProfileStore } from "../memory/profile.ts";
import type { Conversation, ConversationStore, RecallMeta, SearchLog } from "../memory/store.ts";
import { extractClaims } from "./claims.ts";
import { compareClaim, noBaseline, resolveCurrent, type CurrentValue, type DiffItem } from "./compare.ts";
import { acceptCandidates } from "./personalize.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { runTurn, type TurnEvent } from "./research.ts";
import { route, type Route, type RouteDecision } from "./router.ts";

export interface AgentDeps {
  llm: Llm;
  search: Search;
  store: ConversationStore;
  profile: ProfileStore;
  semantic?: SemanticIndex; // without it, recall matches topics by keywords only
}

const SEMANTIC_TIMEOUT_MS = 8_000;

export interface AgentInput {
  conv: Conversation; // already contains the user's new message as its last entry
  tz: string;
  now: () => Date;
  signal?: AbortSignal;
}

export type SavedFact = { id: string; key: string; value: string; previous?: string };

export type AgentEvent =
  | TurnEvent
  | { type: "status"; text: string }
  | { type: "route"; route: string; ms: number } // which path the router chose and how long it took, for the turn log
  | { type: "recall_mode"; mode: "hybrid" | "keywords"; reason?: string } // how topics were matched, for the turn log
  | { type: "recall"; meta: RecallMeta }
  | { type: "profile"; saved: SavedFact[] }; // facts about the user remembered from this message

const HISTORY_LIMIT = 30;
const MAX_ENTITIES = 5;
const MAX_CLAIMS = 10;
const MSG_CHARS = 1500;

const unique = <T>(xs: T[]) => [...new Set(xs)];
const sameEntity = (a: string, b: string) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.includes(y) || y.includes(x);
};

function stamp(at: string, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(at));
}

/** The earlier conversation, quoted by code straight from storage. The model never paraphrases the user for us. */
export function transcript(past: Conversation, maxChars = 9000): string {
  const lines = past.messages.map((m) => {
    const when = stamp(m.at, m.tz);
    const text = m.text.length > MSG_CHARS ? m.text.slice(0, MSG_CHARS) + " […]" : m.text;
    if (m.role === "user") return `[${when}] The user said: "${text}"`;
    const searched = m.searches.some((s) => !s.error && s.urls.length > 0);
    // "you" in this prompt means the user, so the assistant's own earlier replies are labelled "I replied".
    return `[${when}] I (the assistant) replied (${searched ? "after a web search" : "from my own knowledge, no search"}): "${text}"`;
  });
  return lines.join("\n").slice(0, maxChars);
}

export function formatDiff(items: DiffItem[], tz: string, omitted = 0): string {
  const label: Record<DiffItem["verdict"], string> = { changed: "CHANGED", unchanged: "UNCHANGED", couldnt_verify: "COULD NOT VERIFY", no_baseline: "NO BASELINE" };
  const q = (x: { plan?: string; seats?: string; billing?: string }) => Object.entries(x).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(", ");
  const lines = items.map((i) => {
    const out = [`- ${i.entity} / ${i.attribute}: ${label[i.verdict]}`];
    if (i.baseline) {
      const how = i.baseline.provenance === "searched" ? "from a web search" : "from my own knowledge, not a search";
      out.push(`  earlier (${dayOf(i.baseline.assertedAt, tz)}, ${how}): ${i.baseline.valueText}${q(i.baseline.qualifiers) ? ` [${q(i.baseline.qualifiers)}]` : ""}`);
    }
    if (i.current) out.push(`  now: ${i.current.valueText} (source ${i.current.url}, published ${i.current.publishDate ?? "date unknown"}) quote: "${i.current.quote}"`);
    if (i.delta) out.push(`  change: ${i.delta.abs > 0 ? "+" : ""}${i.delta.abs}${i.delta.pct !== undefined ? ` (${i.delta.pct > 0 ? "+" : ""}${i.delta.pct}%)` : ""}`);
    if (i.reason) out.push(`  note: ${i.reason}`);
    return out.join("\n");
  });
  if (omitted > 0) lines.push(`- (${omitted} further earlier claims were not re-checked this time.)`);
  return lines.join("\n");
}

const DIFF_RULES = [
  "You are reporting a then-versus-now check. Findings below were computed by code from the earlier conversation and today's sources.",
  "Start with the bottom line. Use the verdicts exactly as given; never upgrade a 'could not verify' into a guess.",
  "Write each item's verdict as its exact uppercase label (CHANGED, UNCHANGED, COULD NOT VERIFY, NO BASELINE) straight after the item name, e.g. \"- Storage rate: UNCHANGED\". The page turns those labels into badges, so use those capitalised words nowhere else.",
  "Say when the earlier values were stated, and say plainly when an earlier value came from your own knowledge rather than a search.",
  "Cite the source URL for every current value. Add no facts that are not in the findings.",
].join("\n");

const MEMORY_RULES = [
  "Answer from the record of the earlier conversation below, and only from it.",
  "Quote the user's own words exactly as written there. If what they ask about is not in the record, say it is not in the record.",
].join("\n");

async function* diffFlow(deps: AgentDeps, input: AgentInput, past: Conversation, decision: RouteDecision): AsyncGenerator<AgentEvent, { context: string; allowSearch: boolean }> {
  const { llm, search, store } = deps;
  const { signal, tz } = input;

  let claims = past.claims;
  if (!claims) {
    yield { type: "status", text: "Reading the earlier answers…" };
    claims = await extractClaims(llm, past, signal);
    await store.patch(past.id, { claims });
  }

  const volatile = claims.filter((c) => c.perishability === "volatile");
  const entities = unique(volatile.map((c) => c.entity)).slice(0, MAX_ENTITIES);
  const covered = volatile.filter((c) => entities.includes(c.entity));
  const rechecked = covered.slice(0, MAX_CLAIMS);

  const items: DiffItem[] = [];
  for (const e of decision.entities) if (!claims.some((c) => sameEntity(c.entity, e))) items.push(noBaseline(e));

  if (rechecked.length === 0) {
    const none = "The earlier conversation has no stored prices, plans or other checkable values, so there is NO BASELINE to compare against. Say that plainly. You may research the current state, but do not claim anything changed.";
    return { context: `${none}\n${formatDiff(items, tz)}`, allowSearch: true };
  }

  const jobs = entities.map((entity) => {
    const attrs = unique(rechecked.filter((c) => c.entity === entity).map((c) => c.attribute)).slice(0, 2);
    return {
      entity,
      objective: `Current ${attrs.join(" and ")} for ${entity}, with plan and billing period, from official sources.`,
      queries: attrs.map((a) => `${entity} ${a}`.slice(0, 120)),
    };
  });
  yield { type: "status", text: "Checking what changed…" };
  yield { type: "searching", queries: jobs.flatMap((j) => j.queries) };
  const retrievedAt = input.now().toISOString();
  const settled = await Promise.allSettled(jobs.map((j) => search.search({ objective: j.objective, queries: j.queries, sessionId: input.conv.id })));

  const hitsByEntity = new Map<string, SearchHit[]>();
  const logs: SearchLog[] = [];
  settled.forEach((r, i) => {
    const log: SearchLog = { query: jobs[i].queries.join(" | "), urls: [], retrievedAt };
    if (r.status === "fulfilled") {
      hitsByEntity.set(jobs[i].entity, r.value);
      log.urls = r.value.map((h) => h.url);
    } else {
      log.error = String(r.reason?.message ?? r.reason).slice(0, 300);
    }
    logs.push(log);
  });
  for (const log of logs) yield { type: "search_done", log };

  // If every search failed there is nothing to read; skip the model call and report "could not verify".
  const anyHits = [...hitsByEntity.values()].some((h) => h.length > 0);
  let current = new Map<string, CurrentValue | null>();
  if (anyHits) {
    yield { type: "status", text: "Comparing then and now…" };
    current = await resolveCurrent(llm, rechecked, hitsByEntity, signal);
  }
  items.push(...rechecked.map((c) => compareClaim(c, current.get(c.id) ?? null)));

  const omitted = covered.length - rechecked.length;
  return { context: `${DIFF_RULES}\n\nFindings:\n${formatDiff(items, tz, omitted)}`, allowSearch: false };
}

const turnsOf = (conv: Conversation): Turn[] =>
  conv.messages.slice(-HISTORY_LIMIT).map((m) => ({ role: m.role === "user" ? ("user" as const) : ("model" as const), text: m.text }));

export async function* runAgent(deps: AgentDeps, input: AgentInput): AsyncGenerator<AgentEvent> {
  const { llm, search, store } = deps;
  const { conv, tz, now, signal } = input;

  const routeStart = Date.now();
  const decision = await route(llm, conv.messages, now(), tz, signal);
  yield { type: "route", route: decision.route, ms: Date.now() - routeStart };

  // Personalisation: save what the user said about themselves (verified quotes only), then use it for this very reply.
  const userMsg = conv.messages[conv.messages.length - 1];
  const saved: SavedFact[] = [];
  if (userMsg?.role === "user") {
    for (const c of acceptCandidates(decision.profileUpdates, userMsg.text)) {
      const r = await deps.profile.upsert(c, { conversationId: conv.id, messageId: userMsg.id });
      if (r) saved.push({ id: r.fact.id, key: r.fact.key, value: r.fact.value, previous: r.previous });
    }
  }
  if (saved.length) yield { type: "profile", saved };
  const aboutUser = await deps.profile.list();
  let kind: Route = decision.route;
  let phrase = decision.timePhrase;
  let topic = decision.topic ?? (decision.entities.join(" ") || undefined);
  let excluded = conv.rejected ?? [];
  let context = ""; // extra facts appended to the system prompt for the final answer
  // "chat" keeps the tool too: offering it costs no model call, and the router can misjudge
  // a question about current facts as casual talk. The model simply won't call it for small talk.
  let allowSearch = kind === "research" || kind === "chat";

  // Correction ladder: "that's wrong" excludes the conversation we recalled and retries;
  // after a second miss we stop guessing and ask a concrete question.
  let askWhich = false;
  if (decision.rejectsPrevious) {
    const last = [...conv.messages].reverse().find((m) => m.role === "assistant" && m.recall?.ids.length);
    if (last?.recall) {
      excluded = unique([...excluded, ...last.recall.ids]);
      await store.patch(conv.id, { rejected: excluded });
      phrase = last.recall.phrase;
      topic = last.recall.topic;
      kind = last.recall.route as Route;
      askWhich = excluded.length >= 2;
    }
  }

  const needsMemory = kind === "memory" || kind === "memory_research";
  if (needsMemory) {
    yield { type: "status", text: "Checking my memory of earlier conversations…" };
    const pool = (await store.getAll()).filter((c) => c.id !== conv.id); // the current chat is not "earlier"

    if (askWhich) {
      const options = pool.filter((c) => !excluded.includes(c.id)).sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, 4);
      const list = options.length ? options.map((c) => `- ${dayOf(c.startedAt, tz)}: "${c.title}"`).join("\n") : "(there are no other earlier conversations)";
      context = `The user has said twice that the conversation you recalled was the wrong one. Do not guess again. Ask which one they mean, listing exactly these real conversations and nothing else:\n${list}`;
    } else {
      // Meaning-based scores for the topic, when an index is available. Any failure (quota, timeout) falls back
      // to keywords alone: a slower or dumber recall, never a broken turn.
      let semantic: Map<string, number> | undefined;
      if (topic && deps.semantic) {
        try {
          semantic = await withTimeout(deps.semantic.similar(store.userId, topic), SEMANTIC_TIMEOUT_MS, "the embedding model");
          yield { type: "recall_mode", mode: "hybrid" };
        } catch (err: any) {
          yield { type: "recall_mode", mode: "keywords", reason: String(err?.message ?? err).slice(0, 200) };
        }
      }
      const result = recall({ phrase, topic, now: now(), tz, excluded, semantic }, pool);
      if (result.kind === "several") {
        yield { type: "recall", meta: { ids: result.hits.map((h) => h.conversationId), phrase, topic, route: kind } };
        if (kind === "memory_research") {
          // A then-versus-now check needs ONE baseline, so here we do have to ask.
          const list = result.hits.map((h) => `${h.label}: "${h.title}"${h.snippet && h.snippet !== h.title ? ` (you said: "${h.snippet}")` : ""}`).join(" or ");
          context = `Several earlier conversations match, and a comparison needs one. Do not guess. Ask exactly this: Which one do you mean: ${list}?`;
        } else {
          const records = result.hits
            .map((h) => `Conversation "${h.title}" (${h.label}):\n${transcript(pool.find((c) => c.id === h.conversationId)!, 3000)}`)
            .join("\n\n");
          context =
            `The user's question matches ${result.hits.length} earlier conversations. Answer from these records only, and do not ask which one.\n` +
            `Style: open with a direct answer to their question ("Yes, ..." or "No, ..."), speaking to them as "you" and to yourself as "I". ` +
            `Give when each happened and what you were asked, quoting their words exactly; if the thing they asked about appears in your own reply (for example the answer you gave), say so in the first person ("I answered Kampala").` +
            `If several conversations say the same thing, say so once instead of repeating it ("you asked this twice, at ... and ..."). ` +
            `Never mention "records" or "conversations matched". Keep it short.\n\n${records}`;
        }
      } else if (result.kind === "tie") {
        context = `The user's reference matches several earlier conversations. Do not guess. Ask exactly this: ${result.question}`;
      } else if (result.kind === "none") {
        // Earlier SEPARATE conversations had nothing. The current chat is also the user's history, so give it
        // to the model with exact times, quoted by code, and let it answer from there if the answer is in it.
        const earlier = conv.messages.slice(0, -1); // everything before the message being answered
        const here = earlier.length ? `\n\nEarlier in this same chat:\n${transcript({ ...conv, messages: earlier })}` : "";
        const nothingHere = earlier.length === 0;

        if (nothingHere) {
          // "No record" is a fact code established, so code says it. A small model will otherwise improvise a reason
          // ("I do not have access to past chats"), which is false: we looked and found nothing.
          yield { type: "token", text: `${result.message}\n\n` };
          if (kind === "memory") {
            yield { type: "token", text: "Tell me what you'd like to know and I'll look it up fresh." };
            return; // nothing left for the model to add: no second model call
          }
        }
        const shown = nothingHere
          ? `The user has ALREADY been shown this first paragraph, written by code: "${result.message}" Do not repeat it, rephrase it, or give any reason for it. Continue directly after it. `
          : `Looking through earlier separate conversations found nothing: ${result.message}${here}\n\n` +
            `If what the user asks about is in this same chat above, answer from it, naming the exact messages and times. ` +
            `Otherwise say plainly that you have no record (never say you cannot access past conversations; you looked and found none). Never invent what was said. `;

        if (kind === "memory_research") {
          // "Has anything changed since X?" can often be answered from the web alone, without our own old answer:
          // the date is known, so look for what changed after it. There is no baseline to diff against, and we say so.
          const day = phrase ? resolveTimePhrase(phrase, now(), tz)[0] : undefined;
          const since = day ? `The user means ${day.label} (${day.from}). ` : "";
          context =
            `${shown}\n` +
            `You cannot say what you told them before or what changed relative to it, but the question can often be answered from the web alone, so do that. ${since}` +
            `You MUST call web_search before answering: look for what changed or shipped since that date (price changes, new plans, major releases). ` +
            `If the user refers to a list or answer you do not have (for example "the 5 tools we shortlisted"), say in one sentence that you do not have it and ask them to name the items, AND still research: from your own knowledge pick the 5 most commonly shortlisted options for their situation, say which ones you assumed, and search them. ` +
            `Only report a change you can cite with a source dated after that date. If you find none, say "I found no change announced after ${day?.from ?? "that date"} in the sources I checked" and name what you checked; never state flatly that nothing has changed. ` +
            `If you do not even know what they asked about, say so in one sentence and invite them to repeat the question instead of searching.`;
          allowSearch = true;
        } else {
          context = `${shown}You may offer to research the topic fresh now.`;
        }
      } else {
        const past = pool.find((c) => c.id === result.hit.conversationId)!;
        yield { type: "recall", meta: { ids: [past.id], phrase, topic, route: kind } };
        const record = `${result.reading}\n\nRecord of that conversation:\n${transcript(past)}`;
        if (kind === "memory") {
          context = `${MEMORY_RULES}\n\n${record}`;
        } else {
          const diff = yield* diffFlow(deps, input, past, decision);
          context = `${record}\n\n${diff.context}`;
          allowSearch = diff.allowSearch;
        }
      }
    }
  }

  yield* runTurn({
    llm,
    search,
    system: [buildSystemPrompt(now(), tz, aboutUser), context].filter(Boolean).join("\n\n"),
    history: turnsOf(conv),
    sessionId: conv.id,
    signal,
    maxSearches: allowSearch ? 2 : 0,
    now,
  });
}
