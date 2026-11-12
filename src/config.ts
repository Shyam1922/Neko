export class ConfigError extends Error {}

export interface Config {
  geminiApiKey: string;
  model: string;
  port: number;
  dataDir: string;
}

export interface SearchConfig {
  url: string;
  apiKey?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const geminiApiKey = env.GEMINI_API_KEY?.trim();
  if (!geminiApiKey) {
    throw new ConfigError(
      "GEMINI_API_KEY is missing.\n" +
        "  1. Get a free key at https://aistudio.google.com/apikey\n" +
        "  2. Copy .env.example to .env and paste the key after GEMINI_API_KEY=\n" +
        "  3. Restart the server (it only reads .env at startup).",
    );
  }
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`PORT must be 0-65535, got "${env.PORT}".`);
  }
  return {
    geminiApiKey,
    model: env.GEMINI_MODEL?.trim() || "gemini-3.5-flash-lite",
    port,
    dataDir: env.DATA_DIR?.trim() || "data",
  };
}

export function searchConfig(env: NodeJS.ProcessEnv = process.env): SearchConfig {
  return {
    url: env.SEARCH_MCP_URL?.trim() || "https://search.parallel.ai/mcp",
    apiKey: env.PARALLEL_API_KEY?.trim() || undefined,
  };
}
