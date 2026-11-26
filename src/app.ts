import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { friendlyMessage } from "./adapters/errors.ts";
import type { Llm } from "./adapters/llm.ts";
import type { Search } from "./adapters/search.ts";
import { runAgent } from "./agent/pipeline.ts";
import { cleanValue } from "./agent/personalize.ts";
import type { Db } from "./db/db.ts";
import { ProfileStore } from "./memory/profile.ts";
import { ConversationStore, isValidId, MAX_TITLE, type RecallMeta, type SearchLog } from "./memory/store.ts";
import { createUser, touchUser } from "./memory/users.ts";
import { safeTimeZone } from "./memory/dates.ts";

export interface AppDeps {
  db: Db;
  llm: Llm;
  search: Search;
  publicDir: string;
  now?: () => Date;
}

// Each visitor is an anonymous user identified by a random id in this cookie. HttpOnly, so page scripts
// cannot read it; the id is 122 random bits, so it cannot be guessed.
export const USER_COOKIE = "neko_uid";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // a year, in seconds

function cookieUserId(req: http.IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === USER_COOKIE) {
      const id = decodeURIComponent(v.join("="));
      return isValidId(id) ? id : undefined;
    }
  }
}

function setUserCookie(req: http.IncomingMessage, res: http.ServerResponse, id: string) {
  const https = req.headers["x-forwarded-proto"] === "https" || (req.socket as any).encrypted;
  res.setHeader(
    "Set-Cookie",
    `${USER_COOKIE}=${id}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax${https ? "; Secure" : ""}`,
  );
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

export function createApp({ db, llm, search, publicDir, now = () => new Date() }: AppDeps): http.Server {
  // The user behind this request, or null for a visitor who has never sent a message. Only `create`
  // (sending a message) makes a new user, so page loads and bots do not fill the users table.
  async function currentUser(req: http.IncomingMessage, res: http.ServerResponse, create: boolean): Promise<string | null> {
    const id = cookieUserId(req);
    if (id && (await touchUser(db, id))) return id;
    if (!create) return null;
    const fresh = await createUser(db); // unknown or missing cookie: never adopt a client-chosen id
    setUserCookie(req, res, fresh);
    return fresh;
  }
  const storesFor = (userId: string) => ({
    store: new ConversationStore(db, userId, now),
    profile: new ProfileStore(db, userId, now),
  });

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
    const { store, profile } = storesFor((await currentUser(req, res, true))!);
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
      const ms = Date.now() - started; // the whole turn: routing, searching and writing
      const done = await store.append(conv.id, { role: "assistant", text: reply, tz, searches, recall, ms });
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
      if (!pathname.startsWith("/api/")) {
        return req.method === "GET" ? await serveStatic(pathname, res) : sendJson(res, 405, { error: "Method not allowed" });
      }

      // Everything below belongs to one user. A visitor with no user yet simply has nothing.
      const userId = await currentUser(req, res, false);
      const { store, profile } = userId ? storesFor(userId) : { store: null, profile: null };
      const notFound = (what = "Not found") => sendJson(res, 404, { error: what });

      if (req.method === "GET" && pathname === "/api/conversations") return sendJson(res, 200, store ? await store.list() : []);
      const m = pathname.match(/^\/api\/conversations\/([^/]+)$/);
      if (m && req.method === "GET") {
        const conv = await store?.get(m[1]);
        return conv ? sendJson(res, 200, conv) : notFound("Conversation not found");
      }
      if (m && req.method === "PATCH") {
        let title = "";
        try {
          const t = JSON.parse(await readBody(req)).title;
          if (typeof t === "string") title = t.replace(/\s+/g, " ").trim();
        } catch {
          /* handled below */
        }
        if (!title || title.length > MAX_TITLE) return sendJson(res, 400, { error: `title must be 1-${MAX_TITLE} characters.` });
        return (await store?.rename(m[1], title)) ? sendJson(res, 200, { ok: true, title }) : notFound("Conversation not found");
      }
      if (m && req.method === "DELETE") {
        return (await store?.remove(m[1])) ? sendJson(res, 200, { ok: true }) : notFound("Conversation not found");
      }

      // What Neko knows about the user: visible, editable, deletable.
      if (pathname === "/api/profile") {
        if (req.method === "GET") return sendJson(res, 200, profile ? await profile.list() : []);
        if (req.method === "DELETE") return await profile?.clear(), sendJson(res, 200, { ok: true });
      }
      const pf = pathname.match(/^\/api\/profile\/([^/]+)$/);
      if (pf && !profile) return notFound();
      if (pf && req.method === "DELETE") {
        return (await profile!.remove(pf[1])) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: "Not found" });
      }
      if (pf && req.method === "PUT") {
        let value: string | null = null;
        try {
          value = cleanValue(JSON.parse(await readBody(req)).value);
        } catch {
          /* handled below */
        }
        if (!value) return sendJson(res, 400, { error: "value must be 1-120 characters and must not look like a secret or an ID number." });
        const fact = await profile!.update(pf[1], value);
        return fact ? sendJson(res, 200, fact) : notFound();
      }
      sendJson(res, req.method === "GET" ? 404 : 405, { error: req.method === "GET" ? "Not found" : "Method not allowed" });
    } catch (err: any) {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: "Internal error" });
      else res.end();
    }
  });
}
