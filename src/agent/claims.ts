// Turning an old conversation into checkable claims. The model READS the old answers and
// proposes claims; code then verifies each one: the quoted words must really appear in
// the cited message, and "searched vs model knowledge" comes from our own search log.
// A claim that fails verification is dropped, so a baseline is never invented.

import type { Llm } from "../adapters/llm.ts";
import type { Claim, Conversation } from "../memory/store.ts";

const SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          message_id: { type: "string" },
          quote: { type: "string", description: "Exact words copied from that message that state the fact." },
          entity: { type: "string", description: "The product, company or thing, e.g. 'HubSpot Sales Hub'." },
          attribute: { type: "string", description: "What is stated, e.g. 'price per seat', 'free plan limit', 'latest release'." },
          value_text: { type: "string" },
          amount: { type: "number", description: "Numeric value if the fact is a number, else omit." },
          unit: { type: "string", description: "e.g. 'USD/seat/month'. Omit if none." },
          plan: { type: "string", description: "Plan or tier if stated." },
          seats: { type: "string" },
          billing: { type: "string", description: "'annual' or 'monthly' if stated." },
          perishability: { type: "string", enum: ["volatile", "stable"], description: "volatile = prices, plans, features, versions, anything that can change." },
        },
        required: ["message_id", "quote", "entity", "attribute", "value_text", "perishability"],
      },
    },
  },
  required: ["claims"],
};

const SYSTEM = [
  "Extract factual claims that the ASSISTANT made in an earlier conversation, so they can be re-checked later.",
  "Only extract specific facts about named things (prices, plans, limits, versions, features). Skip opinions and advice.",
  "Every claim must quote the assistant's exact words from the message you cite. Do not paraphrase the quote.",
  "Include plan, seats and billing period whenever the message says them. Output only JSON.",
].join("\n");

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
/** True if `quote` appears in `text` (ignoring case and whitespace). */
export const quoteAppears = (quote: string, text: string) => quote.trim().length >= 4 && norm(text).includes(norm(quote));

const MAX_CHARS = 14_000;

export function verifyClaims(raw: unknown, conv: Conversation): Claim[] {
  const list = (raw as { claims?: unknown })?.claims;
  if (!Array.isArray(list)) return [];
  const out: Claim[] = [];
  for (const c of list as Record<string, unknown>[]) {
    const msg = conv.messages.find((m) => m.id === c.message_id && m.role === "assistant");
    const quote = typeof c.quote === "string" ? c.quote : "";
    const entity = typeof c.entity === "string" ? c.entity.trim() : "";
    const attribute = typeof c.attribute === "string" ? c.attribute.trim() : "";
    const valueText = typeof c.value_text === "string" ? c.value_text.trim() : "";
    if (!msg || !entity || !attribute || !valueText || !quoteAppears(quote, msg.text)) continue; // unverifiable: dropped
    const amount = typeof c.amount === "number" && Number.isFinite(c.amount) ? c.amount : undefined;
    const q = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().toLowerCase() : undefined);
    // Provenance is a fact from our log: did a search actually succeed for this message?
    const searched = msg.searches.some((s) => !s.error && s.urls.length > 0);
    out.push({
      id: `${msg.id}:${out.length}`,
      messageId: msg.id,
      entity,
      attribute,
      valueText,
      ...(amount !== undefined ? { amount } : {}),
      ...(typeof c.unit === "string" && c.unit.trim() ? { unit: c.unit.trim() } : {}),
      qualifiers: { plan: q(c.plan), seats: q(c.seats), billing: q(c.billing) },
      quote: quote.trim(),
      assertedAt: msg.at,
      provenance: searched ? "searched" : "model_knowledge",
      perishability: c.perishability === "stable" ? "stable" : "volatile",
      sources: searched ? msg.searches.flatMap((s) => s.urls) : [],
    });
  }
  return out;
}

export async function extractClaims(llm: Llm, conv: Conversation, signal?: AbortSignal): Promise<Claim[]> {
  const transcript = conv.messages
    .map((m) => `[message_id=${m.id}] ${m.role === "user" ? "USER" : "ASSISTANT"}: ${m.text}`)
    .join("\n\n")
    .slice(0, MAX_CHARS);
  const raw = await llm.generateJson({ system: SYSTEM, prompt: transcript, schema: SCHEMA, signal });
  return verifyClaims(raw, conv);
}
