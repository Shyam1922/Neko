// One-off: copies conversations and profile facts from the old JSON files (data/*.json and
// data/profile/facts.json) into the database, for one user.
//
//   npm run import:json                 imports into the most recently active user (your browser,
//                                       once you have sent one message in the new version)
//   npm run import:json -- <user-id>    imports into that user
//
// Stop the server first when using the embedded database: only one process may open it at a time.
// Safe to re-run: conversations and facts that already exist are skipped.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { openDb } from "../src/db/db.ts";
import { createUser } from "../src/memory/users.ts";
import type { Conversation } from "../src/memory/store.ts";
import type { ProfileFact } from "../src/memory/profile.ts";

const dataDir = path.resolve(process.env.DATA_DIR?.trim() || "data");
const databaseUrl = process.env.DATABASE_URL?.trim() || undefined;
const db = await openDb(databaseUrl ? { databaseUrl } : { dataDir: path.join(dataDir, "pglite") });

let userId = process.argv[2];
if (!userId) {
  const { rows } = await db.query<{ id: string }>("SELECT id FROM users ORDER BY last_seen_at DESC LIMIT 1");
  userId = rows[0]?.id ?? (await createUser(db));
  console.log(rows[0] ? `Importing into the most recently active user ${userId}` : `No users yet: created ${userId}`);
} else if (!(await db.query("SELECT 1 FROM users WHERE id = $1", [userId])).rows.length) {
  throw new Error(`No user with id ${userId}`);
}

const files = (await readdir(dataDir).catch(() => [] as string[])).filter((f) => f.endsWith(".json"));
let convs = 0;
let msgs = 0;
for (const f of files) {
  const c = JSON.parse(await readFile(path.join(dataDir, f), "utf8")) as Conversation;
  if ((await db.query("SELECT 1 FROM conversations WHERE id = $1", [c.id])).rows.length) continue;
  await db.tx(async (q) => {
    await q.query(
      "INSERT INTO conversations (id, user_id, title, started_at, last_at, claims, rejected) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)",
      [c.id, userId, c.title, c.startedAt, c.lastAt, c.claims ? JSON.stringify(c.claims) : null, JSON.stringify(c.rejected ?? [])],
    );
    for (const m of c.messages) {
      await q.query(
        `INSERT INTO messages (id, conversation_id, user_id, role, text, at, tz, searches, recall, ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)`,
        [m.id, c.id, userId, m.role, m.text, m.at, m.tz, JSON.stringify(m.searches ?? []), m.recall ? JSON.stringify(m.recall) : null, m.ms ?? null],
      );
    }
  });
  convs++;
  msgs += c.messages.length;
}

let facts = 0;
const factsFile = path.join(dataDir, "profile", "facts.json");
const old: ProfileFact[] = JSON.parse(await readFile(factsFile, "utf8").catch(() => "[]"));
for (const f of old) {
  // Keep the link to the source message only if that message was imported.
  const linked = f.messageId && (await db.query("SELECT 1 FROM messages WHERE id = $1 AND user_id = $2", [f.messageId, userId])).rows.length;
  const { rows } = await db.query(
    `INSERT INTO profile_facts (id, user_id, key, value, quote, conversation_id, message_id, stated_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING RETURNING id`,
    [f.id, userId, f.key, f.value, f.quote, linked ? f.conversationId : null, linked ? f.messageId : null, f.statedAt, f.updatedAt],
  );
  facts += rows.length;
}

console.log(`Imported ${convs} conversations (${msgs} messages) and ${facts} profile facts from ${dataDir}.`);
await db.close();
