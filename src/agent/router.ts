// The router: ONE structured model call that decides what kind of turn this is and pulls
// out the time phrase and topic as the user wrote them. It never resolves dates itself;
// code does that (memory/dates.ts).

import type { Llm } from "../adapters/llm.ts";
import type { Message } from "../memory/store.ts";
import type { Candidate } from "./personalize.ts";

export type Route = "chat" | "memory" | "memory_research" | "research";

export interface RouteDecision {
  route: Route;
  timePhrase?: string; // "last Tuesday"
  topic?: string; // "Postgres hosting"
  entities: string[]; // products/companies the user named
  rejectsPrevious: boolean; // "no, that's not the one I meant"
  profileUpdates: Candidate[]; // facts the user stated about themselves (verified by code before saving)
}

const ROUTES: Route[] = ["chat", "memory", "memory_research", "research"];

const SCHEMA = {
  type: "object",
  properties: {
    route: { type: "string", enum: ROUTES },
    time_phrase: { type: "string", description: "Time reference to an earlier conversation exactly as written, e.g. 'last Tuesday', '3 November'. Empty if none." },
    topic: { type: "string", description: "2-5 words naming what the earlier conversation was about. Empty if none." },
    entities: { type: "array", items: { type: "string" }, description: "Products or companies the user names or means (resolve 'those five tools' from context). Empty if none." },
    rejects_previous: { type: "boolean", description: "True if the user says the conversation you recalled was the wrong one." },
    profile_updates: {
      type: "array",
      description: "Facts the user states about THEMSELVES in the latest message only. Empty if none.",
      items: {
        type: "object",
        properties: {
          key: { type: "string", description: "snake_case label: name, role, company, team_size, budget, location, currency, answer_length, answer_format, or another short snake_case label." },
          value: { type: "string", description: "The fact, short, e.g. 'Alex', '20 people', 'INR', 'short answers'." },
          quote: { type: "string", description: "The user's exact words from the latest message that state it." },
        },
        required: ["key", "value", "quote"],
      },
    },
  },
  required: ["route", "time_phrase", "topic", "entities", "rejects_previous", "profile_updates"],
};

const SYSTEM = [
  "You classify the user's latest message for a research assistant that can remember earlier conversations and search the web.",
  "Routes:",
  "- chat: casual talk or a timeless question answerable without lookup or memory.",
  "- research: needs current web information, and does not refer to an earlier conversation.",
  "- memory: asks what was said or asked in an earlier conversation, with no need for fresh information.",
  "- memory_research: refers to an earlier conversation AND wants to know what changed, or whether it is still correct today.",
  "profile_updates: only facts the user plainly states about themselves in the LATEST message, such as 'I'm Alex', 'we're a 20-person sales team', 'my budget is $500 a month', 'I'm based in Lisbon', 'I prefer short answers', 'I like bullet points'. Never infer, never guess, never use facts about other people, hypotheticals or earlier messages. Never include passwords, keys, card or ID numbers, emails, phone numbers or health details.",
  "Do not resolve dates; copy the user's own time words. If the user only says 'last time' or 'when I last asked' with no actual day, leave time_phrase empty. Output only JSON.",
].join("\n");

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

export function validateDecision(raw: unknown): RouteDecision | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || !ROUTES.includes(r.route as Route)) return null;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : undefined);
  return {
    route: r.route as Route,
    timePhrase: str(r.time_phrase),
    topic: str(r.topic),
    entities: Array.isArray(r.entities) ? r.entities.filter((e): e is string => typeof e === "string" && e.trim() !== "").map((e) => e.trim().slice(0, 80)).slice(0, 8) : [],
    rejectsPrevious: r.rejects_previous === true,
    profileUpdates: Array.isArray(r.profile_updates)
      ? (r.profile_updates as Record<string, unknown>[])
          .filter((p) => p && typeof p.key === "string" && typeof p.value === "string" && typeof p.quote === "string")
          .map((p) => ({ key: p.key as string, value: p.value as string, quote: p.quote as string }))
          .slice(0, 10)
      : [],
  };
}

// If the model's JSON is unusable we fall back to "research": the tool-enabled path, which
// behaves like a normal search chatbot. Rate-limit and timeout errors are NOT swallowed here.
export async function route(llm: Llm, recent: Message[], now: Date, tz: string, signal?: AbortSignal): Promise<RouteDecision> {
  const convo = recent.slice(-5).map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${clip(m.text, 300)}`).join("\n");
  const today = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(now);
  try {
    const raw = await llm.generateJson({ system: SYSTEM, prompt: `Today is ${today}.\n\nRecent messages (the last is the one to classify):\n${convo}`, schema: SCHEMA, signal });
    return validateDecision(raw) ?? fallback();
  } catch (err) {
    if (err instanceof SyntaxError) return fallback();
    throw err;
  }
}

const fallback = (): RouteDecision => ({ route: "research", entities: [], rejectsPrevious: false, profileUpdates: [] });
