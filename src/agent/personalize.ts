// Personalisation, in code. The router PROPOSES facts the user stated about themselves; this module
// decides which ones are kept. Nothing is inferred: a fact must be a verbatim quote from the user's own
// message, have a sane key and a short value, and must not look like a secret or an identifier.

import type { ProfileFact } from "../memory/profile.ts";
import { quoteAppears } from "./claims.ts";

export interface Candidate {
  key: string;
  value: string;
  quote: string;
}

const KEY_RE = /^[a-z][a-z0-9_]{1,29}$/;
const MAX_VALUE = 120;
const MAX_PER_MESSAGE = 5;

// Words that mean "this is sensitive, don't keep it" in a key or value.
const SENSITIVE = /password|passcode|passphrase|api[ _-]?key|secret|token|\bssn\b|social security|credit|debit|card number|\bcvv\b|\biban\b|account number|\bpin\b|passport|aadhaar|health|diagnos|medical/i;

/** A value we are willing to store: short, one line, and not a secret, an email or a long identifier. */
export function cleanValue(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const value = v.replace(/\s+/g, " ").trim();
  if (!value || value.length > MAX_VALUE) return null;
  if (SENSITIVE.test(value) || /@/.test(value) || /(AIza|sk-)[A-Za-z0-9_-]{10,}/.test(value)) return null;
  if (/\d{8,}/.test(value.replace(/[\s,.-]/g, ""))) return null; // phone, card or ID numbers
  return value;
}

/** Keeps only the proposed facts that are safe and really are the user's own words. */
export function acceptCandidates(proposed: Candidate[], userText: string): Candidate[] {
  const out: Candidate[] = [];
  for (const c of proposed) {
    const key = c.key.trim().toLowerCase();
    const value = cleanValue(c.value);
    if (!KEY_RE.test(key) || SENSITIVE.test(key) || !value) continue;
    if (!quoteAppears(c.quote, userText)) continue; // not something the user actually said
    if (out.some((o) => o.key === key)) continue;
    out.push({ key, value, quote: c.quote.trim() });
    if (out.length >= MAX_PER_MESSAGE) break;
  }
  return out;
}

export const labelOf = (key: string) => key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** The "what you know about the user" section of the system prompt ("" when nothing is known). */
export function profileBlock(facts: ProfileFact[]): string {
  if (facts.length === 0) return "";
  return [
    "What the user has told you about themselves (they said these in their own words and can see and edit them):",
    ...facts.map((f) => `- ${labelOf(f.key)}: ${f.value}`),
    "Use these naturally when relevant: tailor prices and recommendations to their team size, budget, role and region; use their currency for prices when a source gives it (never convert from memory; if a source only gives another currency, show that and say so); keep to their preferred answer length and format.",
    "Do not recite this list or mention that you keep a profile. Use their name sparingly, for example when greeting or wrapping up, not in every reply. Never assume anything about them that is not listed.",
  ].join("\n");
}
