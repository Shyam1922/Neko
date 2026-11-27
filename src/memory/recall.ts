// Memory retrieval: "find the conversation the user means". Pure code over stored
// conversations: no model, no network. The model only ever sees what this returns.
//
// Order of work: resolve the time phrase to candidate days -> keep conversations that
// have a user message on those days -> score by topic -> pick a winner, report a tie,
// or say plainly that there is no record. Nothing is ever invented.
//
// Topic scoring is hybrid: keyword overlap, or closeness in meaning from embeddings when the caller
// supplies it (`semantic`), whichever is stronger. The date filter always comes first and is never
// overridden by a vector: "Tuesday's chat about laptops" must be on Tuesday.

import { dayOf, resolveTimePhrase, type DayCandidate } from "./dates.ts";
import type { Conversation } from "./store.ts";

export interface RecallQuery {
  phrase?: string; // "last Tuesday", "3 November"
  topic?: string; // "Postgres hosting"
  now: Date;
  tz: string;
  excluded?: string[]; // conversation ids the user already rejected (correction ladder)
  onAmbiguousDays?: "ask" | "recent"; // two candidate days both match: ask, or take the newer
  semantic?: Map<string, number>; // conversation id -> cosine similarity of its closest message to the topic
}

export interface Hit {
  conversationId: string;
  title: string;
  day: string; // YYYY-MM-DD the conversation matched on
  label: string; // "Tue 3 Nov"
  score: number; // topic match 0..1 (0 when no topic was given): the stronger of keywords and meaning
  via?: "keywords" | "meaning"; // which signal gave the score, for the logs and the evals
  snippet?: string; // what the user said that matched the topic, so options can be told apart
}

export type RecallResult =
  | { kind: "match"; hit: Hit; reading: string }
  | { kind: "several"; hits: Hit[] } // a topic question with no date that several chats answer: report all of them
  | { kind: "tie"; options: Hit[]; question: string }
  | { kind: "none"; reason: "unparsed_phrase" | "no_record"; message: string; nearMatches: Hit[] };

const STOPWORDS = new Set(
  "the and for with that this what when where which who how did does was were are you your yours about have has had any since from into over than then them they their can could would should will just tell told asked ask last next our out its not but all".split(" ")
    // Words about the conversation itself, not its subject. The router sometimes fills the topic with them
    // ("previous questions"), which would demand a topic match that no chat can meet.
    .concat("conversation chat question previous earlier before discus discussed discussion talk talked said say remind thing stuff".split(" ")),
);
const STRONG = 0.5; // a conversation must score this much on the topic to count as a match
// When several chats match a topic, list only those within this much of the best. A clear winner isn't padded
// with weak half-matches; chats that match equally well are all still listed. Chosen from the eval set.
export const NEAR_BEST = 0.3;

// Cosine similarity from gemini-embedding-001 (768 dims, query vs document) is mapped onto the same 0..1
// scale as keyword overlap. Measured on real chats: the same topic in other words scores 0.65-0.68,
// unrelated topics 0.49-0.60. So 0.55 maps to 0, 0.70 to 1, and STRONG (0.5) falls at a cosine of 0.625.
export const SEMANTIC_FLOOR = 0.55;
export const SEMANTIC_FULL = 0.7;
export const semanticScore = (cos: number) => Math.min(1, Math.max(0, (cos - SEMANTIC_FLOOR) / (SEMANTIC_FULL - SEMANTIC_FLOOR)));

function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    const stem = w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w; // crude plural stem, same on both sides
    if (w.length < 3 || STOPWORDS.has(w) || STOPWORDS.has(stem)) continue; // "questions" is a stop word too
    out.add(stem);
  }
  return out;
}

function topicScore(topic: Set<string>, conv: Conversation): number {
  if (topic.size === 0) return 0;
  const body = tokens(conv.title + " " + conv.messages.map((m) => m.text).join(" "));
  let hits = 0;
  for (const t of topic) if (body.has(t)) hits++;
  return hits / topic.size;
}

/** "Fri 13 Nov 01:42": the day and time, in the timezone of the person asking. */
export function whenLabel(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })
    .format(new Date(iso))
    .replace(",", "");
}

function snippetFor(topic: Set<string>, conv: Conversation): string | undefined {
  const m = conv.messages.find((x) => x.role === "user" && [...tokens(x.text)].some((t) => topic.has(t)));
  return m ? (m.text.length > 70 ? m.text.slice(0, 70) + "…" : m.text) : undefined;
}

export function recall(query: RecallQuery, conversations: Conversation[]): RecallResult {
  const excluded = new Set(query.excluded ?? []);
  const pool = conversations.filter((c) => !excluded.has(c.id));
  const topic = tokens(query.topic ?? "");
  const hasTopic = topic.size > 0;

  const hit = (c: Conversation, day: string, label: string): Hit => {
    const words = topicScore(topic, c);
    const meaning = hasTopic && query.semantic?.has(c.id) ? semanticScore(query.semantic.get(c.id)!) : 0;
    return {
      conversationId: c.id,
      title: c.title,
      day,
      label,
      score: Math.max(words, meaning),
      ...(hasTopic ? { via: meaning > words ? ("meaning" as const) : ("keywords" as const), snippet: snippetFor(topic, c) } : {}),
    };
  };

  // Strong topic matches anywhere in time: used for "near match" suggestions and topic-only recall.
  const topicMatches = (skip: Set<string>): Hit[] =>
    hasTopic
      ? pool
          .filter((c) => !skip.has(c.id))
          .map((c) => ({ h: hit(c, dayOf(c.startedAt, query.tz), whenLabel(c.startedAt, query.tz)), at: c.startedAt }))
          .filter(({ h }) => h.score >= STRONG)
          .sort((a, b) => b.h.score - a.h.score || b.at.localeCompare(a.at)) // best score first, newest first within a score
          .map(({ h }) => h)
          .filter((h, _, all) => h.score >= all[0].score - NEAR_BEST)
      : [];

  let candidates: DayCandidate[] = [];
  let unparsed = false; // a phrase like "when I last asked" that names no day
  if (query.phrase) {
    candidates = resolveTimePhrase(query.phrase, query.now, query.tz);
    if (candidates.length === 0) {
      if (!hasTopic) {
        return { kind: "none", reason: "unparsed_phrase", message: `I couldn't work out which day "${query.phrase}" means.`, nearMatches: [] };
      }
      unparsed = true;
    }
  }

  // No usable day: topic only. "When I last asked" means the newest match. A plain "did we ever talk about X"
  // is a question about history, not a request to pick one chat, so every match is reported (up to 3).
  if (candidates.length === 0) {
    const matches = topicMatches(new Set());
    if (matches.length === 0) return noRecord({ ...query, phrase: undefined }, []);
    return unparsed || matches.length === 1 ? matched(matches[0]) : { kind: "several", hits: matches.slice(0, 3) };
  }

  // One entry per candidate day: the conversations with a user message that day.
  const perDay = candidates.map((cand) => {
    const found: Hit[] = [];
    for (const c of pool) {
      const onDay = c.messages.some((m) => m.role === "user" && dayOf(m.at, m.tz) >= cand.from && dayOf(m.at, m.tz) <= cand.to);
      if (!onDay) continue;
      const h = hit(c, cand.from, cand.label);
      if (!hasTopic || h.score >= STRONG) found.push(h);
    }
    return found.sort((a, b) => b.score - a.score);
  });

  const used = new Set(perDay.flat().map((h) => h.conversationId));
  const nearMatches = topicMatches(used);
  const daysWithHits = perDay.filter((d) => d.length > 0);

  if (daysWithHits.length === 0) return noRecord(query, nearMatches);

  if (daysWithHits.length > 1 && query.onAmbiguousDays !== "recent") {
    // Matches on more than one candidate day: ask, offering each day's best.
    return tie(daysWithHits.map((d) => d[0]));
  }
  const day = daysWithHits[0]; // candidates are ranked newest first
  const top = day.filter((h) => h.score === day[0].score);
  return top.length === 1 ? matched(day[0]) : tie(top.slice(0, 3));

  function matched(h: Hit): RecallResult {
    return { kind: "match", hit: h, reading: `Taking that as ${h.label}, the "${h.title}" chat.` };
  }
  function tie(options: Hit[]): RecallResult {
    // Title plus what the user actually said, so two chats with the same first message can be told apart.
    const list = options.map((o) => `${o.label}: "${o.title}"${o.snippet && o.snippet !== o.title ? ` (you said: "${o.snippet}")` : ""}`).join(" or ");
    return { kind: "tie", options, question: `Which one do you mean: ${list}?` };
  }
}

function noRecord(query: RecallQuery, nearMatches: Hit[]): RecallResult {
  // Name the day code resolved ("from Tue 10 Nov"), not the user's raw words ("Last Tuesday").
  const day = query.phrase ? resolveTimePhrase(query.phrase, query.now, query.tz)[0] : undefined;
  const when = day ? ` from ${day.label}` : "";
  const what = query.topic ? ` about ${query.topic}` : "";
  const near = nearMatches[0];
  return {
    kind: "none",
    reason: "no_record",
    message:
      `I have no record of a conversation${what}${when}.` +
      (near ? ` The closest is "${near.title}" on ${near.day}; is that the one?` : ""),
    nearMatches,
  };
}
