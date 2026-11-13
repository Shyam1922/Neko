import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError, loadConfig, searchConfig } from "./config.ts";
import { GeminiLlm } from "./adapters/llm.ts";
import { CachedSearch, ParallelSearch } from "./adapters/search.ts";
import { JsonStore } from "./memory/store.ts";
import { ProfileStore } from "./memory/profile.ts";
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
const dataDir = path.resolve(root, config.dataDir);
const store = new JsonStore(dataDir);
const profile = new ProfileStore(dataDir);
const llm = new GeminiLlm(config.geminiApiKey, config.model);
const search = new CachedSearch(new ParallelSearch(searchConfig()));
const app = createApp({ store, llm, search, profile, publicDir: path.join(root, "public") });

app.listen(config.port, () => {
  // Last 4 characters only: enough to confirm which key the server loaded.
  console.log(`Recall on http://localhost:${config.port}  model=${config.model}  key=...${config.geminiApiKey.slice(-4)}`);
});
