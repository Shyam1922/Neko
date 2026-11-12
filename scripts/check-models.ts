// Lists the models your key can call for text generation.
import { GoogleGenAI } from "@google/genai";
import { loadConfig } from "../src/config.ts";

const cfg = loadConfig();
const ai = new GoogleGenAI({ apiKey: cfg.geminiApiKey });
const pager = await ai.models.list();
for await (const m of pager) {
  if (m.supportedActions?.includes("generateContent")) console.log(m.name);
}
console.log(`\nCurrently configured: ${cfg.model}`);
