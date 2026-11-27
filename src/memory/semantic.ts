// Finding conversations by meaning. Embeddings only FIND candidates: they say "this chat is about
// laptops" when the user wrote "notebook". Everything that must be exact (which day, the quotes, the
// verdicts) stays in code that never looks at a vector.
//
// Messages are embedded in the background after each turn, so a reply is never slowed down by it. If the
// embedding model fails, nothing breaks: recall simply works from keywords alone until the next attempt.

import type { Db } from "../db/db.ts";
import type { Embedder } from "../adapters/embed.ts";
import { logEvent } from "../log.ts";

const BATCH = 50;
const MAX_PER_RUN = 1_000; // a backlog is worked through over several runs, never in one burst of calls

/** pgvector's text form: "[0.1,0.2,...]". Sent as a parameter and cast with ::vector. */
const toVector = (v: number[]) => `[${v.join(",")}]`;

export class SemanticIndex {
  private running: Promise<void> | null = null;
  private again = false;

  constructor(private db: Db, private embedder: Embedder) {}

  get model() {
    return this.embedder.model;
  }

  /**
   * Embeds every message that has no vector yet, for all users. Runs one at a time per process: a call while
   * a run is going asks for one more run afterwards instead of starting a second. Never throws.
   */
  kick(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        try {
          await this.indexPending();
        } catch (err: any) {
          logEvent("embed_error", { error: `${err?.name}: ${String(err?.message).slice(0, 300)}` });
          break; // the next turn's kick tries again
        }
      } while (this.again);
    })().finally(() => (this.running = null));
    return this.running;
  }

  /** Embeds messages that have no vector yet. Returns how many were embedded. */
  async indexPending(limit = MAX_PER_RUN): Promise<number> {
    let done = 0;
    while (done < limit) {
      const { rows } = await this.db.query<{ id: string; conversation_id: string; user_id: string; text: string }>(
        `SELECT m.id, m.conversation_id, m.user_id, m.text
           FROM messages m LEFT JOIN message_embeddings e ON e.message_id = m.id
          WHERE e.message_id IS NULL
          ORDER BY m.seq
          LIMIT $1`,
        [Math.min(BATCH, limit - done)],
      );
      if (!rows.length) break;
      const vectors = await this.embedder.embed(rows.map((r) => r.text), "document");
      await this.db.tx(async (q) => {
        for (const [i, r] of rows.entries()) {
          // ON CONFLICT: another instance may have embedded it meanwhile. A message deleted meanwhile fails the
          // foreign key, so insert only if it still exists.
          await q.query(
            `INSERT INTO message_embeddings (message_id, conversation_id, user_id, model, embedding)
             SELECT $1, $2, $3, $4, $5::vector WHERE EXISTS (SELECT 1 FROM messages WHERE id = $1)
             ON CONFLICT (message_id) DO NOTHING`,
            [r.id, r.conversation_id, r.user_id, this.embedder.model, toVector(vectors[i])],
          );
        }
      });
      done += rows.length;
    }
    if (done) logEvent("embedded", { messages: done, model: this.embedder.model });
    return done;
  }

  /**
   * How close each of this user's conversations comes to the query: the cosine similarity of its closest
   * message (1 = same meaning). Only this user's rows are searched, exactly, by pgvector's <=> distance.
   */
  async similar(userId: string, query: string): Promise<Map<string, number>> {
    const [v] = await this.embedder.embed([query], "query");
    const { rows } = await this.db.query<{ conversation_id: string; sim: number }>(
      `SELECT conversation_id, max(1 - (embedding <=> $2::vector)) AS sim
         FROM message_embeddings
        WHERE user_id = $1
        GROUP BY conversation_id`,
      [userId, toVector(v)],
    );
    return new Map(rows.map((r) => [r.conversation_id, Number(r.sim)]));
  }
}
