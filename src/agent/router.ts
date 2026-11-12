// The router: ONE structured model call that decides what kind of turn this is and pulls
// out the time phrase and topic as the user wrote them. It never resolves dates itself;
// code does that (memory/dates.ts).

import type { Llm } from "../adapters/llm.ts";
import type { Message } from "../memory/store.ts";

export type Route = "chat" | "memory" | "memory_research" | "research";

export interface RouteDecision {
  route: Route;
  timePhrase?: string; // "last Tuesday"
  topic?: string; // "Postgres hosting"
  entities: string[]; // products/companies the user named
  rejectsPrevious: boolean; // "no, that's not the one I meant"
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
  },
  required: ["route", "time_phrase", "topic", "entities", "rejects_previous"],
};

const SYSTEM = [
  "You classify the user's latest message for a research assistant that can remember earlier conversations and search the web.",
  "Routes:",
  "- chat: casual talk or a timeless question answerable without lookup or memory.",
  "- research: needs current web information, and does not refer to an earlier conversation.",
  "- memory: asks what was said or asked in an earlier conversation, with no need for fresh information.",
  "- memory_research: refers to an earlier conversation AND wants to know what changed, or whether it is still correct today.",
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

const fallback = (): RouteDecision => ({ route: "research", entities: [], rejectsPrevious: false });
