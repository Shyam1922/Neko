import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { friendlyMessage } from "./adapters/errors.ts";
import type { JsonRequest, Llm, StreamRequest } from "./adapters/llm.ts";
import type { Search } from "./adapters/search.ts";
import { runAgent } from "./agent/pipeline.ts";
import { cleanValue } from "./agent/personalize.ts";
import type { Db } from "./db/db.ts";
import { ProfileStore } from "./memory/profile.ts";
import { ConversationStore, isValidId, MAX_TITLE, type RecallMeta, type SearchLog } from "./memory/store.ts";
import { createUser, touchUser } from "./memory/users.ts";
import { safeTimeZone } from "./memory/dates.ts";
import { clientIp, NO_LIMITS, SlidingWindow, turnLimitReason, type Limits } from "./limits.ts";
import { logEvent, userTag } from "./log.ts";
import type { SemanticIndex } from "./memory/semantic.ts";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Mailer } from "./adapters/email.ts";
import { extractClaims } from "./agent/claims.ts";
import { runRecheck } from "./agent/recheck.ts";
import { confirmEmail, getAccount, isEmail, removeEmail, setEmailNotify, setMemory, startEmail, TOKEN_TTL_MS, unsubscribe } from "./memory/account.ts";
import { MAX_WATCHES, WatchStore } from "./memory/watches.ts";

export interface AppDeps {
  db: Db;
  llm: Llm;
  search: Search;
  publicDir: string;
  now?: () => Date;
  limits?: Limits; // off unless given: local use and tests are unlimited
  semantic?: SemanticIndex; // embeddings for recall; without it, keywords only
  mailer?: Mailer; // optional: without it, the app never offers email
  publicUrl?: string; // for links in emails
  cronSecret?: string; // without it, POST /api/cron/recheck is off
  recheckBatch?: number;
}

const HOUR = 3600_000;

/** Compares secrets in constant time (hashing first makes the lengths equal). */
function sameSecret(a: string, b: string): boolean {
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(a), h(b));
}

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A small page in Neko's style for the links in emails. Every argument is plain text or our own markup. */
function sendPage(res: http.ServerResponse, status: number, title: string, body: string) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)} · Neko</title><link rel="stylesheet" href="/style.css">
<script>try{var t=localStorage.getItem("neko-theme");document.documentElement.dataset.theme=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches)?"dark":"light"}catch(e){}</script></head>
<body class="page"><main class="page-card"><h1>${escHtml(title)}</h1>${body}</main></body></html>`);
}

const formPage = (action: string, token: string, intro: string, button: string) =>
  `<p>${escHtml(intro)}</p><form method="post" action="${action}"><input type="hidden" name="t" value="${escHtml(token)}"><button type="submit" class="page-btn">${escHtml(button)}</button></form>`;

// Wraps the model so one turn can report how many calls it made.
function countingLlm(llm: Llm) {
  const counter = { calls: 0 };
  const wrapped: Llm = {
    generateJson: (req: JsonRequest) => (counter.calls++, llm.generateJson(req)),
    stream: (req: StreamRequest) => (counter.calls++, llm.stream(req)),
  };
  return { llm: wrapped, counter };
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

export function createApp({ db, llm, search, publicDir, now = () => new Date(), limits = NO_LIMITS, semantic, mailer, publicUrl = "http://localhost:3000", cronSecret, recheckBatch = 5 }: AppDeps): http.Server {
  const newUsersPerIp = new SlidingWindow(limits.newUsersPerIpPerHour, 3600_000);
  const watchAdds = new SlidingWindow(20, HOUR); // per user: each new watch costs a model call to read the answer
  const emailStarts = new SlidingWindow(5, HOUR); // per user: don't let anyone use Neko to spam an inbox
  const cronCalls = new SlidingWindow(12, HOUR); // even with the secret, a bounded number of runs

  // The user behind this request, or null for a visitor who has never sent a message. Only `create`
  // (sending a message) makes a new user, so page loads and bots do not fill the users table.
  async function currentUser(req: http.IncomingMessage, res: http.ServerResponse, create: boolean): Promise<string | null | "limited"> {
    const id = cookieUserId(req);
    if (id && (await touchUser(db, id))) return id;
    if (!create) return null;
    if (!newUsersPerIp.take(clientIp(req, limits.trustProxy))) return "limited";
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
    const userId = await currentUser(req, res, true);
    if (userId === "limited" || !userId) {
      logEvent("limited", { reason: "new_users_per_ip" });
      return sendJson(res, 429, { error: "Too many new visitors from your network in the last hour. Please try again later." });
    }
    const why = await turnLimitReason(db, userId, now(), limits);
    if (why) {
      logEvent("limited", { user: userTag(userId), reason: why });
      return sendJson(res, 429, { error: why });
    }
    const { store, profile } = storesFor(userId);
    const { memoryOn } = await getAccount(db, userId);
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
    let routeName: string | undefined;
    let routeMs: number | undefined;
    let recallMode: string | undefined;
    let firstTokenMs: number | undefined;
    let firstProgressMs: number | undefined; // time to the first visible step: what the user waits through blind
    let writing = false;
    // Progress the page shows as a step list. Each new step finishes the one before it.
    const step = (label: string, kind?: "search") => {
      firstProgressMs ??= Date.now() - started;
      send("step", kind ? { label, kind } : { label });
    };
    const counted = countingLlm(llm);
    // One log line per turn, whatever happened: latency, model calls, searches, outcome.
    const turnLog = (outcome: "ok" | "error" | "aborted", extra: Record<string, unknown> = {}) =>
      logEvent("turn", {
        user: userTag(userId),
        conv: conv.id.slice(0, 8),
        route: routeName,
        outcome,
        ms: Date.now() - started,
        routeMs,
        recallMode,
        firstProgressMs,
        firstTokenMs,
        modelCalls: counted.counter.calls,
        searches: searches.length,
        searchErrors: searches.filter((s) => s.error).length,
        inChars: text.length,
        outChars: reply.length,
        ...extra,
      });
    try {
      step("Understanding the question");
      for await (const ev of runAgent({ llm: counted.llm, search, store, profile, semantic }, { conv, tz, now, signal: abort.signal, useProfile: memoryOn })) {
        if (ev.type === "route") {
          routeName = ev.route;
          routeMs = ev.ms;
        } else if (ev.type === "recall_mode") {
          recallMode = ev.mode;
          if (ev.reason) logEvent("embed_error", { user: userTag(userId), error: ev.reason });
        } else if (ev.type === "token") {
          firstTokenMs ??= Date.now() - started;
          if (!writing) step("Writing the answer");
          writing = true;
          reply += ev.text;
          send("token", { text: ev.text });
        } else if (ev.type === "searching") {
          step(`Searching: ${ev.queries.join(" · ")}`, "search");
        } else if (ev.type === "step") {
          step(ev.label);
        } else if (ev.type === "profile") {
          send("profile", { saved: ev.saved }); // so the page can say what was remembered, with an Undo
        } else if (ev.type === "recall") {
          recall = ev.meta; // remembered on the reply so "that's wrong" knows what to exclude
        } else {
          searches.push(ev.log); // our own log: this is what "searched" means, and what citations are numbered from
          send("search_done", { log: ev.log }); // the page shows the sources before the answer is written
        }
      }
      if (!reply.trim()) throw new Error("The model returned an empty reply.");
      const ms = Date.now() - started; // the whole turn: routing, searching and writing
      const done = await store.append(conv.id, { role: "assistant", text: reply, tz, searches, recall, ms });
      turnLog("ok");
      send("done", { assistantMessage: done.message });
      void semantic?.kick(); // embed this turn's two messages in the background, after the reply is out
    } catch (err: any) {
      if (abort.signal.aborted) {
        turnLog("aborted");
      } else {
        turnLog("error", { error: `${err?.name}: ${String(err?.message).slice(0, 300)}` });
        send("error", { message: friendlyMessage(err) });
      }
    }
    res.end();
  }

  // "Watch this" on an answer: store the facts Neko already extracts for then-vs-now, from that answer only.
  async function addWatch(req: http.IncomingMessage, res: http.ServerResponse, userId: string | null, store: ConversationStore | null, watches: WatchStore | null) {
    let body: any = {};
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: "Body must be JSON." });
    }
    if (!isValidId(body.conversationId) || !isValidId(body.messageId)) return sendJson(res, 400, { error: "conversationId and messageId are required." });
    if (!userId || !store || !watches) return sendJson(res, 404, { error: "Conversation not found" });
    const conv = await store.get(body.conversationId);
    const msg = conv?.messages.find((m) => m.id === body.messageId && m.role === "assistant");
    if (!conv || !msg) return sendJson(res, 404, { error: "Answer not found" });
    if (!watchAdds.take(userId)) return sendJson(res, 429, { error: "Too many watches added in the last hour. Please try again later." });
    const ofMsg = (cs: typeof conv.claims) => (cs ?? []).filter((c) => c.messageId === msg.id && c.perishability === "volatile");
    let claims = ofMsg(conv.claims);
    if (!claims.length) {
      try {
        const all = await extractClaims(llm, conv); // quotes verified by code; unverifiable claims are dropped
        await store.patch(conv.id, { claims: all });
        claims = ofMsg(all);
      } catch (err) {
        return sendJson(res, 502, { error: friendlyMessage(err) });
      }
    }
    if (!claims.length) return sendJson(res, 422, { error: "I couldn't find a price, plan or other fact that can change in this answer, so there's nothing to watch." });
    const made = await watches.create({ conversationId: conv.id, messageId: msg.id, claims });
    if (!made.ok) {
      return made.reason === "exists"
        ? sendJson(res, 409, { error: "You're already watching this answer." })
        : sendJson(res, 409, { error: `You can watch up to ${MAX_WATCHES} things. Delete one to add another.` });
    }
    logEvent("watch_added", { user: userTag(userId), claims: made.watch.claims.length });
    return sendJson(res, 201, made.watch);
  }

  // The daily re-check, called by a scheduled job with the shared secret.
  async function cron(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
    if (!cronSecret) return sendJson(res, 404, { error: "Re-checks are not enabled on this server (CRON_SECRET is not set)." });
    const auth = String(req.headers.authorization ?? "");
    const given = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!given || !sameSecret(given, cronSecret)) {
      logEvent("cron_denied", { ip: clientIp(req, limits.trustProxy) });
      return sendJson(res, 401, { error: "Unauthorized" });
    }
    if (!cronCalls.take("cron")) return sendJson(res, 429, { error: "Too many re-check runs in the last hour." });
    const summary = await runRecheck({ db, llm, search, now, limits, batch: recheckBatch, mailer, publicUrl });
    logEvent("cron_recheck", { ...summary });
    return sendJson(res, 200, summary);
  }

  // Links in emails open a page with a button, never act on GET: mail scanners open links to check them,
  // and would otherwise use up a sign-in link or unsubscribe someone.
  async function emailLink(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const isConfirm = url.pathname === "/api/email/confirm";
    if (url.pathname !== "/api/email/confirm" && url.pathname !== "/api/email/unsubscribe") return sendJson(res, 404, { error: "Not found" });
    let token = url.searchParams.get("t") ?? "";
    if (req.method === "POST") {
      const form = new URLSearchParams(await readBody(req).catch(() => ""));
      token = form.get("t") ?? token;
    } else if (req.method !== "GET") {
      return sendJson(res, 405, { error: "Method not allowed" });
    }
    if (isConfirm) {
      if (req.method === "GET") return sendPage(res, 200, "Confirm your email", formPage("/api/email/confirm", token, "Get an email from Neko when something you watch changes.", "Confirm my email"));
      const r = await confirmEmail(db, token, cookieUserId(req) ?? null, now());
      if (!r.ok) {
        const why = {
          invalid: "This link isn't valid. Ask for a new one from Neko.",
          used: "This link has already been used. Ask for a new one if you need it.",
          expired: "This link has expired. Ask for a new one from Neko.",
          other_browser: "Open this link in the browser where you asked for it, so your email goes to the right Neko account.",
        }[r.reason];
        return sendPage(res, 400, "That didn't work", `<p>${escHtml(why)}</p><p><a href="/">Back to Neko</a></p>`);
      }
      setUserCookie(req, res, r.userId);
      logEvent("email_confirmed", { user: userTag(r.userId), signedIn: r.signedIn });
      const msg = r.signedIn
        ? "You're signed in. This browser now shows the chats, profile and watches of the account that uses this email."
        : "Done. Neko will email you when something you watch changes. Every email has a link to stop them.";
      return sendPage(res, 200, r.signedIn ? "Signed in" : "Email confirmed", `<p>${escHtml(msg)}</p><p><a href="/">Back to Neko</a></p>`);
    }
    if (req.method === "GET") return sendPage(res, 200, "Stop change emails?", formPage("/api/email/unsubscribe", token, "Neko will stop emailing you about changes. Your watches keep working in the app.", "Stop emails"));
    const ok = await unsubscribe(db, token);
    return sendPage(res, ok ? 200 : 400, ok ? "Unsubscribed" : "That didn't work", `<p>${ok ? "You won't get change emails any more. You can turn them back on in Your profile." : "This link isn't valid."}</p><p><a href="/">Back to Neko</a></p>`);
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
      if (pathname === "/api/cron/recheck") return await cron(req, res);
      if (pathname.startsWith("/api/email/") && (pathname.endsWith("/confirm") || pathname.endsWith("/unsubscribe"))) return await emailLink(req, res, url);
      // For the platform's health check: the process is up and the database answers.
      if (pathname === "/healthz") {
        await db.query("SELECT 1");
        return sendJson(res, 200, { ok: true, db: db.kind });
      }
      if (!pathname.startsWith("/api/")) {
        return req.method === "GET" ? await serveStatic(pathname, res) : sendJson(res, 405, { error: "Method not allowed" });
      }

      // Everything below belongs to one user. A visitor with no user yet simply has nothing.
      const userId = (await currentUser(req, res, false)) as string | null; // create=false never limits
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
        if (req.method === "DELETE") {
          await profile?.clear();
          if (userId) await removeEmail(db, userId); // "Forget everything" includes the email address
          return sendJson(res, 200, { ok: true });
        }
      }

      // Settings: the memory switch, and the optional email.
      if (pathname === "/api/me") {
        if (req.method === "GET") {
          const acct = userId ? await getAccount(db, userId) : { memoryOn: true, email: null, emailNotify: false };
          return sendJson(res, 200, { ...acct, emailAvailable: Boolean(mailer), maxWatches: MAX_WATCHES });
        }
        if (req.method === "PUT") {
          let body: any = {};
          try {
            body = JSON.parse(await readBody(req));
          } catch {
            return sendJson(res, 400, { error: "Body must be JSON." });
          }
          const me = await currentUser(req, res, true);
          if (me === "limited" || !me) return sendJson(res, 429, { error: "Too many new visitors from your network in the last hour." });
          if (typeof body.memoryOn === "boolean") await setMemory(db, me, body.memoryOn);
          if (typeof body.emailNotify === "boolean") await setEmailNotify(db, me, body.emailNotify);
          return sendJson(res, 200, { ...(await getAccount(db, me)), emailAvailable: Boolean(mailer), maxWatches: MAX_WATCHES });
        }
      }
      if (pathname === "/api/email/start" && req.method === "POST") {
        if (!mailer) return notFound("Email is not set up on this server.");
        let email: unknown;
        try {
          email = JSON.parse(await readBody(req)).email;
        } catch {
          /* handled below */
        }
        if (!isEmail(email)) return sendJson(res, 400, { error: "That doesn't look like an email address." });
        const me = await currentUser(req, res, true);
        if (me === "limited" || !me) return sendJson(res, 429, { error: "Too many new visitors from your network in the last hour." });
        if (!emailStarts.take(me)) return sendJson(res, 429, { error: "Too many sign-in emails in the last hour. Please try again later." });
        const token = await startEmail(db, me, email, now());
        const link = `${publicUrl}/api/email/confirm?t=${encodeURIComponent(token)}`;
        try {
          await mailer.send({
            to: email.trim(),
            subject: "Confirm your email for Neko",
            text: `Open this link to get an email from Neko when something you watch changes:\n\n${link}\n\nIt works once, for ${TOKEN_TTL_MS / 60_000} minutes, in the browser where you asked for it.\nIf you didn't ask for this, ignore this email; nothing changes.`,
          });
        } catch (err: any) {
          logEvent("email_error", { user: userTag(me), error: String(err?.message ?? err).slice(0, 300) });
          return sendJson(res, 502, { error: "The email couldn't be sent. Please try again later." });
        }
        return sendJson(res, 200, { ok: true });
      }
      if (pathname === "/api/email" && req.method === "DELETE") {
        if (userId) await removeEmail(db, userId);
        return sendJson(res, 200, { ok: true });
      }

      // Watches: facts from an answer, re-checked on a schedule.
      const watches = userId ? new WatchStore(db, userId, now) : null;
      if (pathname === "/api/watches") {
        if (req.method === "GET") return sendJson(res, 200, watches ? await watches.list() : []);
        if (req.method === "POST") return await addWatch(req, res, userId, store, watches);
      }
      const w = pathname.match(/^\/api\/watches\/([^/]+)$/);
      if (w && !watches) return notFound("Watch not found");
      if (w && req.method === "GET") {
        const found = isValidId(w[1]) ? await watches!.get(w[1]) : null;
        return found ? sendJson(res, 200, found) : notFound("Watch not found");
      }
      if (w && req.method === "PATCH") {
        let body: any = {};
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return sendJson(res, 400, { error: "Body must be JSON." });
        }
        if (!isValidId(w[1])) return notFound("Watch not found");
        if (body.status === "active" || body.status === "paused") {
          if (!(await watches!.setStatus(w[1], body.status))) return notFound("Watch not found");
        }
        if (body.seen === true) await watches!.markSeen(w[1]);
        const found = await watches!.get(w[1]);
        return found ? sendJson(res, 200, found) : notFound("Watch not found");
      }
      if (w && req.method === "DELETE") {
        return isValidId(w[1]) && (await watches!.remove(w[1])) ? sendJson(res, 200, { ok: true }) : notFound("Watch not found");
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
      logEvent("http_error", { method: req.method, path: req.url?.split("?")[0], error: `${err?.name}: ${String(err?.message).slice(0, 300)}` });
      if (!res.headersSent) sendJson(res, 500, { error: "Internal error" });
      else res.end();
    }
  });
}
