// Usage numbers from the database, for the README and the resume: how many people actually used Neko.
//
//   npm run stats                      the local embedded database (stop the server first)
//   DATABASE_URL=postgres://... npm run stats    a deployed database (Render shows its external URL)
//
// Counts only people who sent at least one message: visitors who only looked never get a user row.

import path from "node:path";
import { openDb } from "../src/db/db.ts";

const databaseUrl = process.env.DATABASE_URL?.trim() || undefined;
const dataDir = path.resolve(process.env.DATA_DIR?.trim() || "data", "pglite");
const db = await openDb(databaseUrl ? { databaseUrl } : { dataDir });

const one = async (sql: string) => (await db.query(sql)).rows[0];

const people = await one(`
  SELECT count(DISTINCT user_id)::int AS total,
         count(DISTINCT user_id) FILTER (WHERE at > now() - interval '7 days')::int AS last7,
         count(*)::int AS turns
    FROM messages WHERE role = 'user'`);
const returning = await one(`
  SELECT count(*)::int AS n FROM (
    SELECT user_id FROM messages WHERE role = 'user'
     GROUP BY user_id HAVING count(DISTINCT (at AT TIME ZONE 'UTC')::date) >= 2) r`);
const convs = await one("SELECT count(*)::int AS n FROM conversations");
const replies = await one(`
  SELECT count(*)::int AS n,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY ms)::int AS p50,
         percentile_cont(0.9) WITHIN GROUP (ORDER BY ms)::int AS p90,
         count(*) FILTER (WHERE jsonb_array_length(searches) > 0)::int AS searched
    FROM messages WHERE role = 'assistant' AND ms IS NOT NULL`);
const facts = await one("SELECT count(*)::int AS n, count(DISTINCT user_id)::int AS users FROM profile_facts");
const daily = await db.query(`
  SELECT (at AT TIME ZONE 'UTC')::date::text AS day, count(DISTINCT user_id)::int AS people, count(*)::int AS turns
    FROM messages WHERE role = 'user' AND at > now() - interval '14 days'
   GROUP BY 1 ORDER BY 1`);

console.log(`People who sent a message:   ${people.total} (${people.last7} in the last 7 days, ${returning.n} came back on another day)`);
console.log(`Conversations / messages:     ${convs.n} / ${people.turns} sent`);
console.log(`Answers:                      ${replies.n}, ${replies.searched} used web search`);
console.log(`Answer time:                  median ${((replies.p50 ?? 0) / 1000).toFixed(1)}s, p90 ${((replies.p90 ?? 0) / 1000).toFixed(1)}s`);
console.log(`Profile facts remembered:     ${facts.n}, for ${facts.users} people`);
if (daily.rows.length) {
  console.log("\nLast 14 days (UTC):");
  for (const r of daily.rows) console.log(`  ${r.day}  ${String(r.people).padStart(3)} people  ${String(r.turns).padStart(4)} messages`);
}
await db.close();
