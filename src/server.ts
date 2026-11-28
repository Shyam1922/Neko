import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, loadConfig, searchConfig } from "./config.ts";
import { GeminiLlm } from "./adapters/llm.ts";
import { CachedSearch, ParallelSearch } from "./adapters/search.ts";
import { openDb } from "./db/db.ts";
import { GeminiEmbedder } from "./adapters/embed.ts";
import { SemanticIndex } from "./memory/semantic.ts";
import { createApp } from "./app.ts";
import { ConsoleMailer, ResendMailer } from "./adapters/email.ts";

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`\nConfig problem: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const db = await openDb(
  config.databaseUrl ? { databaseUrl: config.databaseUrl } : { dataDir: path.resolve(root, config.dataDir, "pglite") },
);
const llm = new GeminiLlm(config.geminiApiKey, config.model, config.modelTimeoutMs);
const search = new CachedSearch(new ParallelSearch(searchConfig()));
const semantic = config.embedModel ? new SemanticIndex(db, new GeminiEmbedder(config.geminiApiKey, config.embedModel)) : undefined;
const mailer = config.email ? new ResendMailer(config.email.apiKey, config.email.from) : config.emailLog ? new ConsoleMailer() : undefined;
const app = createApp({
  db, llm, search, publicDir: path.join(root, "public"), limits: config.limits, semantic,
  mailer, publicUrl: config.publicUrl, cronSecret: config.cronSecret, recheckBatch: config.recheckBatch,
});

app.listen(config.port, () => {
  // Last 4 characters only: enough to confirm which key the server loaded.
  const l = config.limits;
  console.log(`Neko on http://localhost:${config.port}  model=${config.model}  db=${db.kind}  key=...${config.geminiApiKey.slice(-4)}`);
  console.log(`Recall: ${semantic ? `keywords + embeddings (${semantic.model})` : "keywords only (EMBED_MODEL=off)"}`);
  console.log(`Watch: re-checks ${config.cronSecret ? "via POST /api/cron/recheck" : "via npm run recheck only (CRON_SECRET not set)"}; email ${config.email ? "on" : config.emailLog ? "printed to this log (EMAIL_LOG, local only)" : "off"}`);
  void semantic?.kick(); // embed anything stored before embeddings existed, or missed while the model was down
  console.log(`Limits: ${l.turnsPerHour || "no"} turns/hour per user, ${l.turnsPerDay || "no"} turns/day in total, ${l.newUsersPerIpPerHour || "no"} new users/hour per IP${l.trustProxy ? " (client IP from X-Forwarded-For)" : ""}`);
});

// Platforms stop containers with SIGTERM: finish by closing the database cleanly (PGlite flushes to disk).
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    app.close();
    db.close().finally(() => process.exit(0));
  });
}
