import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { newUser, testDb } from "./db-helper.ts";
import { ConversationStore, type Claim } from "../src/memory/store.ts";
import { MAX_WATCHES, WatchStore } from "../src/memory/watches.ts";
import { outcomeOf, runRecheck, type RecheckDeps } from "../src/agent/recheck.ts";
import { MemoryMailer } from "../src/adapters/email.ts";
import type { Llm, LlmEvent } from "../src/adapters/llm.ts";
import type { Search, SearchHit } from "../src/adapters/search.ts";
import { NO_LIMITS } from "../src/limits.ts";
import { confirmEmail, getAccount, hashToken, notifyTarget, startEmail, TOKEN_TTL_MS, unsubscribe } from "../src/memory/account.ts";
import { createApp, USER_COOKIE } from "../src/app.ts";
import type { DiffItem } from "../src/agent/compare.ts";

const T0 = new Date("2026-11-28T09:00:00Z");
const DAY = 86_400_000;
const at = (ms: number) => () => new Date(T0.getTime() + ms);

const claim = (over: Partial<Claim> = {}): Claim => ({
  id: "c1",
  messageId: "m",
  entity: "Neon Launch",
  attribute: "compute price",
  valueText: "$0.106 per CU-hour",
  amount: 0.106,
  unit: "USD/CU-hour",
  qualifiers: { plan: "launch" },
  quote: "$0.106 per CU-hour",
  assertedAt: T0.toISOString(),
  provenance: "searched",
  perishability: "volatile",
  sources: ["https://neon.com/pricing"],
  ...over,
});

// A search that returns one page saying today's price, and a model that reads that price off it.
const page = (price: string): SearchHit => ({ url: "https://neon.com/pricing", title: "Pricing", publishDate: null, excerpts: [`Launch plan compute: $${price} per CU-hour`] });
const fixedSearch = (price: string): Search & { calls: number } => {
  const s = { calls: 0, search: async () => (s.calls++, [page(price)]) };
  return s;
};
const reader = (price: string): Llm => ({
  async generateJson() {
    return { current: [{ claim_id: "c1", found: true, value_text: `$${price} per CU-hour`, amount: Number(price), unit: "USD/CU-hour", plan: "Launch", url: "https://neon.com/pricing", quote: `$${price} per CU-hour` }] };
  },
  async *stream(): AsyncGenerator<LlmEvent> {},
});

// A user with one researched answer, watched.
async function watched(claims = [claim()], now = () => T0) {
  const db = await testDb();
  const user = await newUser();
  const store = new ConversationStore(db, user, now);
  const q = await store.append(undefined, { role: "user", text: "What does Neon Launch cost?" });
  const a = await store.append(q.conversation.id, { role: "assistant", text: "Compute is $0.106 per CU-hour." });
  const watches = new WatchStore(db, user, now);
  const made = await watches.create({ conversationId: q.conversation.id, messageId: a.message.id, claims: claims.map((c) => ({ ...c, messageId: a.message.id })) });
  assert.ok(made.ok);
  return { db, user, store, watches, watch: made.watch, convId: q.conversation.id, msgId: a.message.id };
}

const deps = (db: RecheckDeps["db"], over: Partial<RecheckDeps>): RecheckDeps => ({
  db, llm: reader("0.106"), search: fixedSearch("0.106"), now: at(8 * DAY), limits: NO_LIMITS, batch: 50, publicUrl: "https://neko.test", ...over,
});

// ---- the rule -------------------------------------------------------------------------------------------

test("a watch counts as changed only on a real Changed verdict", () => {
  const item = (verdict: DiffItem["verdict"]): DiffItem => ({ entity: "x", attribute: "y", verdict });
  assert.equal(outcomeOf([item("unchanged"), item("changed")]), "changed");
  assert.equal(outcomeOf([item("unchanged"), item("unchanged")]), "unchanged");
  assert.equal(outcomeOf([item("unchanged"), item("couldnt_verify")]), "couldnt_verify"); // a gap is not "no change"
  assert.equal(outcomeOf([item("couldnt_verify")]), "couldnt_verify");
  assert.equal(outcomeOf([]), "couldnt_verify");
});

// ---- the store ------------------------------------------------------------------------------------------

test("watches: created weekly, one per answer, capped per user, and private to their owner", async () => {
  const { db, user, watches, watch, convId, msgId } = await watched();
  assert.equal(watch.status, "active");
  assert.equal(watch.title, "Neon Launch");
  assert.equal(watch.nextCheckAt, new Date(T0.getTime() + 7 * DAY).toISOString());
  assert.deepEqual(await watches.create({ conversationId: convId, messageId: msgId, claims: [claim()] }), { ok: false, reason: "exists" });

  const store = new ConversationStore(db, user, () => T0);
  for (let i = 1; i < MAX_WATCHES; i++) {
    const a = await store.append(convId, { role: "assistant", text: `answer ${i}` });
    assert.ok((await watches.create({ conversationId: convId, messageId: a.message.id, claims: [claim()] })).ok);
  }
  const extra = await store.append(convId, { role: "assistant", text: "one too many" });
  assert.deepEqual(await watches.create({ conversationId: convId, messageId: extra.message.id, claims: [claim()] }), { ok: false, reason: "limit" });

  const stranger = new WatchStore(db, await newUser(), () => T0);
  assert.equal((await stranger.list()).length, 0);
  assert.equal(await stranger.get(watch.id), null);
  assert.equal(await stranger.remove(watch.id), false);
  assert.equal(await stranger.setStatus(watch.id, "paused"), null);

  assert.equal((await watches.setStatus(watch.id, "paused"))?.status, "paused");
  assert.equal(await watches.remove(watch.id), true);
  assert.equal(await watches.get(watch.id), null);
});

// ---- scheduling -----------------------------------------------------------------------------------------

test("re-checks run only for active watches that are due, and the next one is scheduled a week later", async () => {
  const { db, watches, watch } = await watched();
  const search = fixedSearch("0.106");
  // (The job is not per user and other tests' watches share this database, so assert on this watch only.)
  // Six days in: not due yet.
  await runRecheck(deps(db, { search, now: at(6 * DAY) }));
  assert.equal((await watches.get(watch.id))!.lastCheckedAt, null);
  // Paused: skipped even when due.
  await watches.setStatus(watch.id, "paused");
  await runRecheck(deps(db, { search, now: at(8 * DAY) }));
  assert.equal((await watches.get(watch.id))!.lastCheckedAt, null);
  await watches.setStatus(watch.id, "active");
  const s = await runRecheck(deps(db, { search, now: at(8 * DAY) }));
  assert.ok(s.checked >= 1);
  const after = (await watches.get(watch.id))!;
  assert.equal(after.lastOutcome, "unchanged");
  assert.equal(after.nextCheckAt, new Date(T0.getTime() + 15 * DAY).toISOString());
  assert.equal(after.checks.length, 1);
  assert.equal(after.checks[0].items[0].verdict, "unchanged");
});

test("a run handles a bounded batch and never more than today's quota has left", async () => {
  const db = await testDb();
  const mine = await Promise.all([1, 2, 3].map(() => watched()));
  const now = at(30 * DAY);
  const one = await runRecheck(deps(db, { now, batch: 1 }));
  assert.equal(one.checked, 1);
  // A daily limit already used up by chat turns and re-checks leaves nothing for this run.
  const used = await runRecheck(deps(db, { now, limits: { ...NO_LIMITS, turnsPerDay: 1 } }));
  assert.equal(used.checked, 0);
  assert.equal(used.quotaLeft, 0);
  assert.ok(mine.length === 3);
});

// ---- telling the user -----------------------------------------------------------------------------------

test("a real change marks the watch, emails once, and becomes the new baseline; no change sends nothing", async () => {
  const { db, user, watches, watch } = await watched();
  const mailer = new MemoryMailer();
  const token = await startEmail(db, user, "me@example.com", T0);
  assert.ok((await confirmEmail(db, token, user, T0)).ok);

  // Same price: nothing to tell.
  await runRecheck(deps(db, { mailer, now: at(8 * DAY) }));
  assert.equal(mailer.sent.length, 0);
  assert.equal((await watches.get(watch.id))!.unseenChange, false);

  // The price went up: one email, a badge, and the new price is the baseline from now on.
  await runRecheck(deps(db, { mailer, search: fixedSearch("0.14"), llm: reader("0.14"), now: at(16 * DAY) }));
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, "me@example.com");
  assert.match(mailer.sent[0].subject, /^Changed: Neon Launch/);
  assert.match(mailer.sent[0].text, /\$0\.106 per CU-hour -> \$0\.14 per CU-hour/);
  assert.match(mailer.sent[0].text, /Stop these emails: https:\/\/neko\.test\/api\/email\/unsubscribe\?t=/);
  assert.equal(mailer.sent[0].headers?.["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.doesNotMatch(mailer.sent[0].text, new RegExp(user)); // the account id is the login cookie: never in an email
  const changed = (await watches.get(watch.id))!;
  assert.equal(changed.lastOutcome, "changed");
  assert.equal(changed.unseenChange, true);
  assert.equal(changed.claims[0].amount, 0.14);
  assert.equal((await watches.list())[0].lastCheck?.items[0].verdict, "changed");

  // A week later at the same new price: unchanged against the new baseline, so no second email.
  await runRecheck(deps(db, { mailer, search: fixedSearch("0.14"), llm: reader("0.14"), now: at(24 * DAY) }));
  assert.equal(mailer.sent.length, 1);
  assert.equal((await watches.get(watch.id))!.lastOutcome, "unchanged");
  assert.equal((await watches.get(watch.id))!.unseenChange, true); // still unseen until the user opens it
  await watches.markSeen(watch.id);
  assert.equal((await watches.get(watch.id))!.unseenChange, false);
});

test("couldn't verify is not a change: no email, no badge", async () => {
  const { db, user, watches, watch } = await watched();
  const mailer = new MemoryMailer();
  assert.ok((await confirmEmail(db, await startEmail(db, user, "cv@example.com", T0), user, T0)).ok);
  const blind: Llm = { async generateJson() { return { current: [{ claim_id: "c1", found: false }] }; }, async *stream() {} };
  await runRecheck(deps(db, { mailer, llm: blind, now: at(8 * DAY) }));
  assert.equal(mailer.sent.length, 0);
  const w = (await watches.get(watch.id))!;
  assert.equal(w.lastOutcome, "couldnt_verify");
  assert.equal(w.unseenChange, false);
});

test("a failed re-check is recorded and retried the next day, not next week", async () => {
  const { db, watches, watch } = await watched();
  const broken: Llm = { async generateJson() { throw new Error("rate limited"); }, async *stream() {} };
  const s = await runRecheck(deps(db, { llm: broken, now: at(8 * DAY) }));
  assert.ok(s.errors >= 1);
  const w = (await watches.get(watch.id))!;
  assert.equal(w.lastOutcome, "error");
  assert.equal(w.nextCheckAt, new Date(T0.getTime() + 9 * DAY).toISOString());
  assert.match(w.checks[0].error!, /rate limited/);
});

// ---- email tokens ---------------------------------------------------------------------------------------

test("email: stored only after confirming; tokens are hashed, single use and expire", async () => {
  const db = await testDb();
  const user = await newUser();
  const token = await startEmail(db, user, "a@example.com", T0);
  assert.equal((await getAccount(db, user)).email, null); // not before confirmation
  const raw = await db.query("SELECT token_hash FROM email_tokens WHERE user_id = $1", [user]);
  assert.equal(raw.rows[0].token_hash, hashToken(token));
  assert.notEqual(raw.rows[0].token_hash, token);

  // Opened in another browser: refused, and not used up.
  assert.deepEqual(await confirmEmail(db, token, await newUser(), T0), { ok: false, reason: "other_browser" });
  assert.deepEqual(await confirmEmail(db, token, user, T0), { ok: true, userId: user, email: "a@example.com", signedIn: false });
  assert.deepEqual(await confirmEmail(db, token, user, T0), { ok: false, reason: "used" });
  assert.deepEqual(await confirmEmail(db, "x".repeat(40), user, T0), { ok: false, reason: "invalid" });
  assert.equal((await getAccount(db, user)).email, "a@example.com");

  const late = await startEmail(db, user, "a@example.com", T0);
  assert.deepEqual(await confirmEmail(db, late, user, new Date(T0.getTime() + TOKEN_TTL_MS)), { ok: false, reason: "expired" });
});

test("email: confirming an address that already has an account signs this browser in to it", async () => {
  const db = await testDb();
  const owner = await newUser();
  assert.ok((await confirmEmail(db, await startEmail(db, owner, "Owner@Example.com", T0), owner, T0)).ok);
  const phone = await newUser(); // the same person on another device
  const r = await confirmEmail(db, await startEmail(db, phone, "owner@example.com", T0), phone, T0);
  assert.deepEqual(r, { ok: true, userId: owner, email: "owner@example.com", signedIn: true });
  assert.equal((await getAccount(db, phone)).email, null); // the phone's anonymous account is left as it was
});

test("unsubscribe stops change emails and keeps the address", async () => {
  const db = await testDb();
  const user = await newUser();
  await confirmEmail(db, await startEmail(db, user, "u@example.com", T0), user, T0);
  const target = await notifyTarget(db, user);
  assert.ok(target);
  assert.equal(await unsubscribe(db, "nope-nope-nope-nope-nope"), false);
  assert.equal(await unsubscribe(db, target.unsubscribeToken), true);
  assert.equal(await notifyTarget(db, user), null);
  assert.equal((await getAccount(db, user)).email, "u@example.com");
});

// ---- over HTTP: cron auth, the memory switch, forgetting the email -------------------------------------

class RouterLlm implements Llm {
  system = "";
  constructor(private updates: unknown[] = []) {}
  async generateJson() {
    return { route: "chat", time_phrase: "", topic: "", entities: [], rejects_previous: false, profile_updates: this.updates };
  }
  async *stream(req: { system: string }): AsyncGenerator<LlmEvent> {
    this.system = req.system;
    yield { type: "text", text: "Noted." };
  }
}

async function serve(llm: Llm, cronSecret?: string) {
  const db = await testDb();
  const user = await newUser();
  const server = createApp({ db, llm, search: { search: async () => [] }, publicDir: path.resolve("public"), now: () => T0, cronSecret, mailer: new MemoryMailer() });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (p: string, init: RequestInit = {}) => fetch(base + p, { ...init, headers: { cookie: `${USER_COOKIE}=${user}`, ...(init.headers as any) } });
  return { db, user, call, close: () => (server.closeAllConnections(), server.close()) };
}

test("cron: off without a secret; 401 without the right one; runs with it", async () => {
  const off = await serve(new RouterLlm());
  assert.equal((await off.call("/api/cron/recheck", { method: "POST" })).status, 404);
  off.close();

  const secret = "s".repeat(32);
  const on = await serve(new RouterLlm(), secret);
  assert.equal((await on.call("/api/cron/recheck", { method: "POST" })).status, 401);
  assert.equal((await on.call("/api/cron/recheck", { method: "POST", headers: { authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await on.call("/api/cron/recheck", { method: "GET", headers: { authorization: `Bearer ${secret}` } })).status, 405);
  const ok = await on.call("/api/cron/recheck", { method: "POST", headers: { authorization: `Bearer ${secret}` } });
  assert.equal(ok.status, 200);
  assert.equal(typeof (await ok.json()).checked, "number");
  on.close();
});

test("memory off: nothing new is saved about the user and nothing saved is used", async () => {
  const llm = new RouterLlm([{ key: "name", value: "Alex", quote: "I'm Alex" }]);
  const { call, close } = await serve(llm);
  const put = await call("/api/me", { method: "PUT", body: JSON.stringify({ memoryOn: false }) });
  assert.equal((await put.json()).memoryOn, false);
  const res = await call("/api/chat", { method: "POST", body: JSON.stringify({ text: "I'm Alex" }) });
  assert.doesNotMatch(await res.text(), /event: profile/);
  assert.deepEqual(await (await call("/api/profile")).json(), []);

  // Back on: the same message is remembered and used.
  await call("/api/me", { method: "PUT", body: JSON.stringify({ memoryOn: true }) });
  await (await call("/api/chat", { method: "POST", body: JSON.stringify({ text: "I'm Alex" }) })).text();
  assert.equal((await (await call("/api/profile")).json())[0].value, "Alex");
  assert.match(llm.system, /Alex/);

  // Off again: the fact stays (until deleted) but isn't used.
  await call("/api/me", { method: "PUT", body: JSON.stringify({ memoryOn: false }) });
  await (await call("/api/chat", { method: "POST", body: JSON.stringify({ text: "hello" }) })).text();
  assert.doesNotMatch(llm.system, /Alex/);
  assert.equal((await (await call("/api/profile")).json()).length, 1);
  close();
});

test("Forget everything also removes the email address", async () => {
  const { db, user, call, close } = await serve(new RouterLlm());
  await confirmEmail(db, await startEmail(db, user, "f@example.com", T0), user, T0);
  assert.equal((await (await call("/api/me")).json()).email, "f@example.com");
  await call("/api/profile", { method: "DELETE" });
  assert.equal((await (await call("/api/me")).json()).email, null);
  close();
});

test("email links never act on GET (mail scanners open them); the button posts", async () => {
  const { db, user, call, close } = await serve(new RouterLlm());
  const token = await startEmail(db, user, "g@example.com", T0);
  const page = await call(`/api/email/confirm?t=${token}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<form method="post"/);
  assert.equal((await getAccount(db, user)).email, null);
  const done = await call("/api/email/confirm", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `t=${token}` });
  assert.equal(done.status, 200);
  assert.equal((await getAccount(db, user)).email, "g@example.com");
  close();
});
