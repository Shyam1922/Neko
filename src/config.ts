export class ConfigError extends Error {}

export interface Config {
  geminiApiKey: string;
  model: string;
  port: number;
  dataDir: string; // embedded Postgres (PGlite) lives in <dataDir>/pglite when databaseUrl is not set
  databaseUrl?: string; // a real Postgres server: postgres://user:pass@host:5432/db
  modelTimeoutMs: number; // how long to wait for the model to answer before showing an error
}

export const DEFAULT_MODEL_TIMEOUT_SECONDS = 45;

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
  // Stronger models can take much longer than the default fast one, so this is adjustable.
  const seconds = Number(env.MODEL_TIMEOUT_SECONDS?.trim() || DEFAULT_MODEL_TIMEOUT_SECONDS);
  if (!Number.isFinite(seconds) || seconds < 5 || seconds > 600) {
    throw new ConfigError(`MODEL_TIMEOUT_SECONDS must be a number from 5 to 600, got "${env.MODEL_TIMEOUT_SECONDS}".`);
  }
  return {
    geminiApiKey,
    model: env.GEMINI_MODEL?.trim() || "gemini-3.5-flash-lite",
    port,
    dataDir: env.DATA_DIR?.trim() || "data",
    databaseUrl: env.DATABASE_URL?.trim() || undefined,
    modelTimeoutMs: Math.round(seconds * 1000),
  };
}

export function searchConfig(env: NodeJS.ProcessEnv = process.env): SearchConfig {
  return {
    url: env.SEARCH_MCP_URL?.trim() || "https://search.parallel.ai/mcp",
    apiKey: env.PARALLEL_API_KEY?.trim() || undefined,
  };
}
