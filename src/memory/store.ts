import { randomUUID } from "node:crypto";
import type { Db, Queryable } from "../db/db.ts";
import { safeTimeZone } from "./dates.ts";

export interface SearchLog {
  query: string;
  urls: string[];
  retrievedAt: string;
  error?: string; // set when the search failed; such a turn did NOT verify anything
}

// What the agent used from memory to write an answer, so a later "that's wrong" knows
// which conversation to exclude and which question to retry.
export interface RecallMeta {
  ids: string[];
  phrase?: string;
  topic?: string;
  route: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string; // UTC ISO, set by the server, never by the client
  tz: string; // timezone the user was in when it was sent
  searches: SearchLog[];
  recall?: RecallMeta;
  ms?: number; // for an assistant reply: how long it took, request to finished answer
}

// A fact an earlier answer asserted. Always tied to a message and a verbatim quote.
export interface Claim {
  id: string;
  messageId: string;
  entity: string; // "HubSpot Sales Hub"
  attribute: string; // "price per seat"
  valueText: string; // "$90"
  amount?: number; // 90
  unit?: string; // "USD/seat/month"
  qualifiers: { plan?: string; seats?: string; billing?: string };
  quote: string; // exact words from the message (verified by code)
  assertedAt: string;
  provenance: "searched" | "model_knowledge"; // from our search log, never from the model
  perishability: "volatile" | "stable";
  sources: string[];
}

export interface Conversation {
  id: string;
  startedAt: string;
  lastAt: string;
  title: string;
  messages: Message[];
  claims?: Claim[]; // extracted on demand, once
  rejected?: string[]; // past conversations the user said were the wrong ones
}

export type ConversationSummary = Omit<Conversation, "messages"> & { messageCount: number };

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
export const isValidId = (id: unknown): id is string => typeof id === "string" && ID_RE.test(id);

export const MAX_TITLE = 120;

const iso = (d: Date | string) => new Date(d).toISOString();
const titleFrom = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 60);

function toMessage(r: any): Message {
  return {
    id: r.id,
    role: r.role,
    text: r.text,
    at: iso(r.at),
    tz: r.tz,
    searches: r.searches ?? [],
    ...(r.recall ? { recall: r.recall } : {}),
    ...(r.ms !== null && r.ms !== undefined ? { ms: Number(r.ms) } : {}),
  };
}

function toConversation(r: any, messages: Message[]): Conversation {
  return {
    id: r.id,
    startedAt: iso(r.started_at),
    lastAt: iso(r.last_at),
    title: r.title,
    messages,
    ...(r.claims ? { claims: r.claims } : {}),
    ...(r.rejected?.length ? { rejected: r.rejected } : {}),
  };
}

const CONV_COLS = "id, title, started_at, last_at, claims, rejected";
const MSG_COLS = "id, conversation_id, role, text, at, tz, searches, recall, ms";

/**
 * One user's conversations in Postgres. Every query is filtered by userId, so a store can never read
 * or change another user's chats, even if it is handed their conversation id.
 */
export class ConversationStore {
  constructor(private db: Db, readonly userId: string, private now: () => Date = () => new Date()) {}

  async get(id: string): Promise<Conversation | null> {
    if (!isValidId(id)) return null;
    const { rows } = await this.db.query(`SELECT ${CONV_COLS} FROM conversations WHERE id = $1 AND user_id = $2`, [id, this.userId]);
    if (!rows.length) return null;
    const msgs = await this.db.query(`SELECT ${MSG_COLS} FROM messages WHERE conversation_id = $1 ORDER BY seq`, [id]);
    return toConversation(rows[0], msgs.rows.map(toMessage));
  }

  async list(): Promise<ConversationSummary[]> {
    const { rows } = await this.db.query(
      `SELECT ${CONV_COLS.split(", ").map((c) => "c." + c).join(", ")}, count(m.id)::int AS message_count
         FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id
        WHERE c.user_id = $1
        GROUP BY c.id
        ORDER BY c.last_at DESC, c.started_at DESC`,
      [this.userId],
    );
    return rows.map((r) => {
      const { messages, ...rest } = toConversation(r, []);
      return { ...rest, messageCount: Number(r.message_count) };
    });
  }

  // Updates derived fields (claims, rejected) without touching messages.
  async patch(id: string, fields: Partial<Pick<Conversation, "claims" | "rejected">>): Promise<void> {
    const { rows } = await this.db.query(
      `UPDATE conversations
          SET claims = CASE WHEN $3 THEN $4::jsonb ELSE claims END,
              rejected = CASE WHEN $5 THEN $6::jsonb ELSE rejected END
        WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, this.userId, "claims" in fields, JSON.stringify(fields.claims ?? null), "rejected" in fields, JSON.stringify(fields.rejected ?? [])],
    );
    if (!rows.length) throw new Error("Conversation not found");
  }

  // Every one of this user's conversations in full, in two queries; one person's history is small enough to scan.
  async getAll(): Promise<Conversation[]> {
    const convs = await this.db.query(`SELECT ${CONV_COLS} FROM conversations WHERE user_id = $1 ORDER BY last_at DESC, started_at DESC`, [this.userId]);
    const msgs = await this.db.query(`SELECT ${MSG_COLS} FROM messages WHERE user_id = $1 ORDER BY seq`, [this.userId]);
    const byConv = new Map<string, Message[]>();
    for (const r of msgs.rows) {
      const list = byConv.get(r.conversation_id) ?? [];
      list.push(toMessage(r));
      byConv.set(r.conversation_id, list);
    }
    return convs.rows.map((r) => toConversation(r, byConv.get(r.id) ?? []));
  }

  /** Renames a conversation. Returns false if this user has no such conversation. */
  async rename(id: string, title: string): Promise<boolean> {
    if (!isValidId(id)) return false;
    const { rows } = await this.db.query("UPDATE conversations SET title = $3 WHERE id = $1 AND user_id = $2 RETURNING id", [id, this.userId, title]);
    return rows.length > 0;
  }

  /** Deletes a conversation and its messages. Returns false if this user has no such conversation. */
  async remove(id: string): Promise<boolean> {
    if (!isValidId(id)) return false;
    const { rows } = await this.db.query("DELETE FROM conversations WHERE id = $1 AND user_id = $2 RETURNING id", [id, this.userId]);
    return rows.length > 0;
  }

  // Appends a message, creating the conversation when conversationId is undefined.
  // One transaction: the message and the conversation's lastAt change together or not at all. The row lock
  // makes concurrent appends to one chat wait their turn instead of interleaving. NO KEY UPDATE, because only
  // last_at changes: it still serialises appends, but doesn't block foreign-key checks from other inserts.
  async append(
    conversationId: string | undefined,
    m: { role: Message["role"]; text: string; tz?: string; searches?: SearchLog[]; recall?: RecallMeta; ms?: number },
  ): Promise<{ conversation: Conversation; message: Message }> {
    if (conversationId !== undefined && !isValidId(conversationId)) throw new Error("Invalid conversation id");
    const at = this.now().toISOString();
    const message: Message = {
      id: randomUUID(),
      role: m.role,
      text: m.text,
      at,
      tz: safeTimeZone(m.tz),
      searches: m.searches ?? [],
      ...(m.recall ? { recall: m.recall } : {}),
      ...(m.ms !== undefined ? { ms: Math.round(m.ms) } : {}),
    };
    const convId = await this.db.tx(async (q: Queryable) => {
      let id = conversationId;
      if (id) {
        const found = await q.query("SELECT id FROM conversations WHERE id = $1 AND user_id = $2 FOR NO KEY UPDATE", [id, this.userId]);
        if (!found.rows.length) throw new Error("Conversation not found");
        await q.query("UPDATE conversations SET last_at = $2 WHERE id = $1", [id, at]);
      } else {
        id = randomUUID();
        await q.query(
          "INSERT INTO conversations (id, user_id, title, started_at, last_at) VALUES ($1, $2, $3, $4, $4)",
          [id, this.userId, titleFrom(m.text), at],
        );
      }
      await q.query(
        `INSERT INTO messages (id, conversation_id, user_id, role, text, at, tz, searches, recall, ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)`,
        [message.id, id, this.userId, message.role, message.text, at, message.tz, JSON.stringify(message.searches), message.recall ? JSON.stringify(message.recall) : null, message.ms ?? null],
      );
      return id;
    });
    return { conversation: (await this.get(convId))!, message };
  }
}
