import type { Limits } from "./limits.ts";

export class ConfigError extends Error {}

export interface Config {
  geminiApiKey: string;
  model: string;
  port: number;
  dataDir: string; // embedded Postgres (PGlite) lives in <dataDir>/pglite when databaseUrl is not set
  databaseUrl?: string; // a real Postgres server: postgres://user:pass@host:5432/db
  modelTimeoutMs: number; // how long to wait for the model to answer before showing an error
  limits: Limits;
  embedModel: string | null; // null = embeddings off: recall by keywords only
}

// On by default, so a deploy that forgets to set them is still protected. 0 turns a limit off.
export const DEFAULT_LIMITS = { turnsPerHour: 30, turnsPerDay: 500, newUsersPerIpPerHour: 10 };

function count(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new ConfigError(`${name} must be a whole number (0 turns the limit off), got "${raw}".`);
  return n;
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
    embedModel: /^(off|none|0|false)$/i.test(env.EMBED_MODEL?.trim() ?? "") ? null : env.EMBED_MODEL?.trim() || "gemini-embedding-001",
    limits: {
      turnsPerHour: count(env, "TURNS_PER_HOUR", DEFAULT_LIMITS.turnsPerHour),
      turnsPerDay: count(env, "TURNS_PER_DAY", DEFAULT_LIMITS.turnsPerDay),
      newUsersPerIpPerHour: count(env, "NEW_USERS_PER_IP_PER_HOUR", DEFAULT_LIMITS.newUsersPerIpPerHour),
      trustProxy: /^(1|true|yes)$/i.test(env.TRUST_PROXY?.trim() ?? ""),
    },
  };
}

export function searchConfig(env: NodeJS.ProcessEnv = process.env): SearchConfig {
  return {
    url: env.SEARCH_MCP_URL?.trim() || "https://search.parallel.ai/mcp",
    apiKey: env.PARALLEL_API_KEY?.trim() || undefined,
  };
}
