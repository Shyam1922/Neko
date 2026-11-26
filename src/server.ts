import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, loadConfig, searchConfig } from "./config.ts";
import { GeminiLlm } from "./adapters/llm.ts";
import { CachedSearch, ParallelSearch } from "./adapters/search.ts";
import { openDb } from "./db/db.ts";
import { createApp } from "./app.ts";

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
const app = createApp({ db, llm, search, publicDir: path.join(root, "public") });

app.listen(config.port, () => {
  // Last 4 characters only: enough to confirm which key the server loaded.
  console.log(`Neko on http://localhost:${config.port}  model=${config.model}  db=${db.kind}  key=...${config.geminiApiKey.slice(-4)}`);
});

// Platforms stop containers with SIGTERM: finish by closing the database cleanly (PGlite flushes to disk).
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    app.close();
    db.close().finally(() => process.exit(0));
  });
}
