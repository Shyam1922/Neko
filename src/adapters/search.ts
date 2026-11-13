import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { SearchConfig } from "../config.ts";
import { withTimeout } from "./timeout.ts";

export interface SearchHit {
  url: string;
  title: string;
  publishDate: string | null;
  excerpts: string[];
}

export interface SearchInput {
  objective: string;
  queries: string[];
  sessionId: string; // the free tier rate-limits per session, so reuse the conversation id
}

export interface Search {
  search(input: SearchInput): Promise<SearchHit[]>;
}

export async function connectSearch(cfg: SearchConfig): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
    requestInit: cfg.apiKey ? { headers: { Authorization: `Bearer ${cfg.apiKey}` } } : undefined,
  });
  const client = new Client({ name: "neko", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

const SEARCH_TIMEOUT_MS = 25_000;

/** The server returns its results as a JSON string inside the first text block. */
export function parseSearchResponse(text: string): SearchHit[] {
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Search returned something that isn't JSON: ${text.slice(0, 120)}`);
  }
  const results: any[] = Array.isArray(body?.results) ? body.results : [];
  return results
    .filter((r) => typeof r?.url === "string")
    .map((r) => ({
      url: r.url,
      title: String(r.title ?? "").replace(/\s+/g, " ").trim(),
      publishDate: typeof r.publish_date === "string" ? r.publish_date : null,
      excerpts: Array.isArray(r.excerpts) ? r.excerpts.map(String) : [],
    }));
}

// Hosted keyless Parallel Search MCP server. Connects on first use and reconnects
// after a failure, so a dropped connection never wedges the app.
export class ParallelSearch implements Search {
  private client: Promise<Client> | null = null;
  constructor(private cfg: SearchConfig) {}

  async search({ objective, queries, sessionId }: SearchInput): Promise<SearchHit[]> {
    try {
      this.client ??= connectSearch(this.cfg);
      const client = await withTimeout(this.client, SEARCH_TIMEOUT_MS, "the search server to connect");
      const res = await withTimeout(
        client.callTool({ name: "web_search", arguments: { objective, search_queries: queries, session_id: sessionId } }),
        SEARCH_TIMEOUT_MS,
        "search results",
      );
      const text = (res.content as { type: string; text?: string }[] | undefined)?.find((c) => c.type === "text")?.text ?? "";
      if (res.isError) throw new Error(text.slice(0, 300) || "Search server reported an error.");
      return parseSearchResponse(text);
    } catch (err) {
      this.client = null; // next call reconnects
      throw err;
    }
  }
}

// Same question twice in a few minutes costs nothing the second time.
export class CachedSearch implements Search {
  private cache = new Map<string, { at: number; hits: SearchHit[] }>();
  constructor(private inner: Search, private ttlMs = 10 * 60_000, private now: () => number = Date.now) {}

  async search(input: SearchInput): Promise<SearchHit[]> {
    const key = input.queries.map((q) => q.toLowerCase().trim()).sort().join("|");
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.hits;
    const hits = await this.inner.search(input);
    if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { at: this.now(), hits });
    return hits;
  }
}
