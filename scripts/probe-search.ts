// Connects to the search MCP server, prints its tools and schemas, then runs one pricing query.
// Run this before wiring search into the agent: it tells us the real argument names,
// latency, and whether results contain concrete prices.
import { searchConfig } from "../src/config.ts";
import { connectSearch } from "../src/adapters/search.ts";

const query = process.argv[2] ?? "HubSpot Sales Hub Professional price per seat 2026";
const cfg = searchConfig();
console.log(`server: ${cfg.url} (${cfg.apiKey ? "with API key" : "keyless"})`);

let t = Date.now();
const client = await connectSearch(cfg);
console.log(`connected in ${Date.now() - t}ms\n`);

const { tools } = await client.listTools();
for (const tool of tools) {
  console.log(`tool: ${tool.name}\n${tool.description ?? ""}\nschema: ${JSON.stringify(tool.inputSchema)}\n`);
}

const search = tools.find((x) => x.name === "web_search");
if (!search) {
  console.log("No web_search tool found; stopping.");
  await client.close();
  process.exit(1);
}

// Fill each required argument from its schema type so we don't need to guess names.
const props = (search.inputSchema.properties ?? {}) as Record<string, { type?: string; items?: { type?: string } }>;
const args: Record<string, unknown> = {};
for (const key of search.inputSchema.required ?? []) {
  const p = props[key];
  args[key] = p?.type === "array" ? [query] : query;
}
console.log(`calling web_search with ${JSON.stringify(args)}`);
t = Date.now();
const result = await client.callTool({ name: "web_search", arguments: args });
console.log(`returned in ${Date.now() - t}ms\n`);
console.log(JSON.stringify(result, null, 2).slice(0, 4000));
await client.close();
