// Re-check watched facts now, the same way the daily cron call does.
//
//   npm run recheck                                 due watches only
//   npm run recheck -- --all                        every active watch, due or not
//   npm run recheck -- --fixture eval/fixtures/x.json   fixed search results instead of live search (testing)
//   npm run recheck -- --print-email                print change emails here instead of sending them
//
// With the embedded database (no DATABASE_URL), stop the dev server first: PGlite allows one process at a time.

import path from "node:path";
import { readFile } from "node:fs/promises";
import { ConfigError, loadConfig, searchConfig } from "../src/config.ts";
import { GeminiLlm } from "../src/adapters/llm.ts";
import { CachedSearch, ParallelSearch, type Search, type SearchHit } from "../src/adapters/search.ts";
import { MemoryMailer, ResendMailer, type Mailer } from "../src/adapters/email.ts";
import { openDb } from "../src/db/db.ts";
import { runRecheck } from "../src/agent/recheck.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`Config problem: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

let search: Search = new CachedSearch(new ParallelSearch(searchConfig()));
const fixture = value("--fixture");
if (fixture) {
  // Every search returns these pages, so a test can make a watched value "change" on purpose.
  const data = JSON.parse(await readFile(fixture, "utf8")) as { hits: SearchHit[] };
  search = { search: async () => data.hits };
  console.log(`Using fixed search results from ${fixture} (${data.hits.length} pages)`);
}

const printed = new MemoryMailer();
const mailer: Mailer | undefined = flag("--print-email") ? printed : config.email ? new ResendMailer(config.email.apiKey, config.email.from) : undefined;

const db = await openDb(config.databaseUrl ? { databaseUrl: config.databaseUrl } : { dataDir: path.resolve(config.dataDir, "pglite") });
try {
  const summary = await runRecheck(
    { db, llm: new GeminiLlm(config.geminiApiKey, config.model, config.modelTimeoutMs), search, now: () => new Date(), limits: config.limits, batch: Number(value("--batch") ?? config.recheckBatch), mailer, publicUrl: config.publicUrl },
    { dueNow: flag("--all") },
  );
  console.log(`Due ${summary.due} · checked ${summary.checked} · changed ${summary.changed} · emailed ${summary.emailed} · errors ${summary.errors}${summary.quotaLeft !== null ? ` · quota left today ${summary.quotaLeft}` : ""}`);
  for (const e of printed.sent) console.log(`\n--- email to ${e.to}\nSubject: ${e.subject}\n${e.text}`);
} finally {
  await db.close();
}
