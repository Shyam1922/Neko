// Sends one tiny prompt straight to the model and prints timings and the raw error.
// Use it to tell "my key/model/network is the problem" apart from "the app is the problem".
import { loadConfig } from "../src/config.ts";
import { GeminiLlm } from "../src/adapters/llm.ts";

const cfg = loadConfig();
const llm = new GeminiLlm(cfg.geminiApiKey, cfg.model);
console.log(`model=${cfg.model} key=...${cfg.geminiApiKey.slice(-4)}`);

const t0 = Date.now();
let first: number | undefined;
let out = "";
try {
  for await (const ev of llm.stream({ system: "Reply in one short sentence.", history: [{ role: "user", text: "Say hello." }] })) {
    if (ev.type !== "text") continue;
    first ??= Date.now() - t0;
    out += ev.text;
  }
  console.log(`first token: ${first}ms, total: ${Date.now() - t0}ms\nreply: ${out.trim()}`);
} catch (err: any) {
  console.error(`FAILED after ${Date.now() - t0}ms: ${err?.name}: ${err?.message}`);
  process.exit(1);
}
