// What Neko knows about the user: facts they stated themselves ("I prefer short answers").
// Stored in the profile_facts table, apart from conversations, so the user can see, edit and delete
// every fact. One fact per key per user: a newer statement replaces the older one.

import { randomUUID } from "node:crypto";
import type { Db } from "../db/db.ts";

export interface ProfileFact {
  id: string;
  key: string; // snake_case label: "name", "team_size", "currency", ...
  value: string;
  quote: string; // the user's exact words that stated it
  conversationId: string | null; // null once the chat it was said in is deleted
  messageId: string | null;
  statedAt: string;
  updatedAt: string;
}

export const MAX_FACTS = 40;

const COLS = "id, key, value, quote, conversation_id, message_id, stated_at, updated_at";

function toFact(r: any): ProfileFact {
  return {
    id: r.id,
    key: r.key,
    value: r.value,
    quote: r.quote,
    conversationId: r.conversation_id,
    messageId: r.message_id,
    statedAt: new Date(r.stated_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

/** One user's profile. Every query is filtered by userId. */
export class ProfileStore {
  constructor(private db: Db, readonly userId: string, private now: () => Date = () => new Date()) {}

  async list(): Promise<ProfileFact[]> {
    const { rows } = await this.db.query(`SELECT ${COLS} FROM profile_facts WHERE user_id = $1 ORDER BY seq`, [this.userId]);
    return rows.map(toFact);
  }

  /** Saves a fact, replacing any earlier one with the same key. Returns null if the profile is full. */
  upsert(
    c: { key: string; value: string; quote: string },
    source: { conversationId: string; messageId: string },
  ): Promise<{ fact: ProfileFact; previous?: string } | null> {
    return this.db.tx(async (q) => {
      const at = this.now().toISOString();
      // Lock this user's row so two quick messages cannot both pass the MAX_FACTS check.
      await q.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [this.userId]);
      const old = await q.query(`SELECT ${COLS} FROM profile_facts WHERE user_id = $1 AND key = $2`, [this.userId, c.key]);
      if (old.rows.length) {
        const { rows } = await q.query(
          `UPDATE profile_facts SET value = $2, quote = $3, conversation_id = $4, message_id = $5, updated_at = $6
            WHERE id = $1 RETURNING ${COLS}`,
          [old.rows[0].id, c.value, c.quote, source.conversationId, source.messageId, at],
        );
        return { fact: toFact(rows[0]), previous: old.rows[0].value as string };
      }
      const count = await q.query<{ n: number }>("SELECT count(*)::int AS n FROM profile_facts WHERE user_id = $1", [this.userId]);
      if (Number(count.rows[0].n) >= MAX_FACTS) return null;
      const { rows } = await q.query(
        `INSERT INTO profile_facts (id, user_id, key, value, quote, conversation_id, message_id, stated_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING ${COLS}`,
        [randomUUID(), this.userId, c.key, c.value, c.quote, source.conversationId, source.messageId, at],
      );
      return { fact: toFact(rows[0]) };
    });
  }

  /** The user edits a value by hand in the panel. */
  async update(id: string, value: string): Promise<ProfileFact | null> {
    const { rows } = await this.db.query(
      `UPDATE profile_facts SET value = $3, updated_at = $4 WHERE id = $1 AND user_id = $2 RETURNING ${COLS}`,
      [id, this.userId, value, this.now().toISOString()],
    );
    return rows.length ? toFact(rows[0]) : null;
  }

  async remove(id: string): Promise<boolean> {
    const { rows } = await this.db.query("DELETE FROM profile_facts WHERE id = $1 AND user_id = $2 RETURNING id", [id, this.userId]);
    return rows.length > 0;
  }

  async clear(): Promise<void> {
    await this.db.query("DELETE FROM profile_facts WHERE user_id = $1", [this.userId]);
  }
}
