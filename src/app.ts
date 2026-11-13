import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { friendlyMessage } from "./adapters/errors.ts";
import type { Llm } from "./adapters/llm.ts";
import type { Search } from "./adapters/search.ts";
import { runAgent } from "./agent/pipeline.ts";
import { cleanValue } from "./agent/personalize.ts";
import type { ProfileStore } from "./memory/profile.ts";
import { isValidId, type JsonStore, type RecallMeta, type SearchLog } from "./memory/store.ts";
import { safeTimeZone } from "./memory/dates.ts";

export interface AppDeps {
  store: JsonStore;
  llm: Llm;
  search: Search;
  profile: ProfileStore;
  publicDir: string;
  now?: () => Date;
}

const MAX_BODY = 100_000;
const MAX_TEXT = 8_000;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createApp({ store, llm, search, profile, publicDir, now = () => new Date() }: AppDeps): http.Server {
  async function chat(req: http.IncomingMessage, res: http.ServerResponse) {
    let input: { conversationId?: unknown; text?: unknown; tz?: unknown };
    try {
      input = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: "Body must be JSON under 100 KB." });
    }
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text) return sendJson(res, 400, { error: "text is required." });
    if (text.length > MAX_TEXT) return sendJson(res, 400, { error: `text is over ${MAX_TEXT} characters.` });
    if (input.conversationId !== undefined && !isValidId(input.conversationId)) {
      return sendJson(res, 400, { error: "Invalid conversationId." });
    }

    const tz = safeTimeZone(input.tz);
    let saved;
    try {
      saved = await store.append(input.conversationId as string | undefined, { role: "user", text, tz });
    } catch (err: any) {
      const notFound = err?.message === "Conversation not found";
      return sendJson(res, notFound ? 404 : 500, { error: err?.message ?? "Could not save message." });
    }
    const conv = saved.conversation;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("meta", { conversationId: conv.id, userMessage: saved.message });

    // If the browser goes away mid-stream, stop paying for the model call.
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
    });

    const started = Date.now();
    let reply = "";
    const searches: SearchLog[] = [];
    let recall: RecallMeta | undefined;
    try {
      let firstTokenMs: number | undefined;
      for await (const ev of runAgent({ llm, search, store, profile }, { conv, tz, now, signal: abort.signal })) {
        if (ev.type === "token") {
          firstTokenMs ??= Date.now() - started;
          reply += ev.text;
          send("token", { text: ev.text });
        } else if (ev.type === "searching") {
          send("searching", { queries: ev.queries });
        } else if (ev.type === "status") {
          send("status", { text: ev.text });
        } else if (ev.type === "profile") {
          send("profile", { saved: ev.saved }); // so the page can say what was remembered, with an Undo
        } else if (ev.type === "recall") {
          recall = ev.meta; // remembered on the reply so "that's wrong" knows what to exclude
        } else {
          searches.push(ev.log); // our own log: this is what "searched" means
        }
      }
      if (!reply.trim()) throw new Error("The model returned an empty reply.");
      const done = await store.append(conv.id, { role: "assistant", text: reply, tz, searches, recall });
      console.log(`[chat] ${conv.id.slice(0, 8)} first-token ${firstTokenMs}ms total ${Date.now() - started}ms searches ${searches.length}`);
      send("done", { assistantMessage: done.message });
    } catch (err: any) {
      if (!abort.signal.aborted) {
        console.error(`[chat] ${conv.id.slice(0, 8)} failed after ${Date.now() - started}ms: ${err?.name}: ${err?.message}`);
        send("error", { message: friendlyMessage(err) });
      }
    }
    res.end();
  }

  async function serveStatic(urlPath: string, res: http.ServerResponse) {
    const rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath.slice(1));
    const file = path.resolve(publicDir, rel);
    // Refuse anything that resolves outside public/ (../ tricks).
    if (!file.startsWith(path.resolve(publicDir) + path.sep)) return sendJson(res, 404, { error: "Not found" });
    try {
      const data = await readFile(file);
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
      res.end(data);
    } catch {
      sendJson(res, 404, { error: "Not found" });
    }
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const { pathname } = url;
      if (req.method === "POST" && pathname === "/api/chat") return await chat(req, res);
      if (req.method === "GET" && pathname === "/api/conversations") return sendJson(res, 200, await store.list());
      const m = pathname.match(/^\/api\/conversations\/([^/]+)$/);
      if (req.method === "GET" && m) {
        const conv = await store.get(m[1]);
        return conv ? sendJson(res, 200, conv) : sendJson(res, 404, { error: "Conversation not found" });
      }
      // What Recall knows about the user: visible, editable, deletable.
      if (pathname === "/api/profile") {
        if (req.method === "GET") return sendJson(res, 200, await profile.list());
        if (req.method === "DELETE") return await profile.clear(), sendJson(res, 200, { ok: true });
      }
      const pf = pathname.match(/^\/api\/profile\/([^/]+)$/);
      if (pf && req.method === "DELETE") {
        return (await profile.remove(pf[1])) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: "Not found" });
      }
      if (pf && req.method === "PUT") {
        let value: string | null = null;
        try {
          value = cleanValue(JSON.parse(await readBody(req)).value);
        } catch {
          /* handled below */
        }
        if (!value) return sendJson(res, 400, { error: "value must be 1-120 characters and must not look like a secret or an ID number." });
        const fact = await profile.update(pf[1], value);
        return fact ? sendJson(res, 200, fact) : sendJson(res, 404, { error: "Not found" });
      }
      if (req.method === "GET") return await serveStatic(pathname, res);
      sendJson(res, 405, { error: "Method not allowed" });
    } catch (err: any) {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: "Internal error" });
      else res.end();
    }
  });
}
