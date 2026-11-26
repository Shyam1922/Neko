import { test } from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";
import { clientIp, NO_LIMITS, SlidingWindow, turnLimitReason } from "../src/limits.ts";
import { ConversationStore } from "../src/memory/store.ts";
import { newUser, testDb } from "./db-helper.ts";

const NOW = new Date("2026-11-12T08:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

// Sends `count` user messages for one user, spread back in time from `startMinutesAgo`.
async function sent(user: string, count: number, startMinutesAgo: number) {
  const db = await testDb();
  let i = 0;
  const store = new ConversationStore(db, user, () => minutesAgo(startMinutesAgo - i++));
  const { conversation } = await store.append(undefined, { role: "user", text: "q" });
  for (let k = 1; k < count; k++) await store.append(conversation.id, { role: "user", text: "q" });
}

test("per-user hourly limit: counts only this user's messages in the last hour, and says when to retry", async () => {
  const db = await testDb();
  const user = await newUser();
  const limits = { ...NO_LIMITS, turnsPerHour: 3 };
  await sent(user, 5, 120); // two hours ago: outside the window
  assert.equal(await turnLimitReason(db, user, NOW, limits), null);
  await sent(user, 3, 50); // 50, 49 and 48 minutes ago
  const why = await turnLimitReason(db, user, NOW, limits);
  assert.match(why!, /3 messages in the last hour/);
  assert.match(why!, /about 10 minutes/); // the oldest one in the window turns an hour old in 10 minutes
  assert.equal(await turnLimitReason(db, await newUser(), NOW, limits), null); // another user is unaffected
  assert.equal(await turnLimitReason(db, user, NOW, NO_LIMITS), null); // 0 means off
});

test("assistant replies don't count as turns", async () => {
  const db = await testDb();
  const user = await newUser();
  const store = new ConversationStore(db, user, () => minutesAgo(1));
  const { conversation } = await store.append(undefined, { role: "user", text: "q" });
  for (let i = 0; i < 5; i++) await store.append(conversation.id, { role: "assistant", text: "a" });
  assert.equal(await turnLimitReason(db, user, NOW, { ...NO_LIMITS, turnsPerHour: 2 }), null);
});

test("daily limit counts everyone's messages", async () => {
  const db = await testDb();
  const { rows } = await db.query("SELECT count(*)::int AS n FROM messages WHERE role = 'user' AND at > $1", [minutesAgo(24 * 60).toISOString()]);
  const already = rows[0].n; // other tests in this file share the database
  const a = await newUser();
  await sent(a, 2, 30);
  const limits = { ...NO_LIMITS, turnsPerDay: already + 2 };
  assert.match((await turnLimitReason(db, await newUser(), NOW, limits))!, /quota for today/);
  assert.equal(await turnLimitReason(db, a, NOW, { ...limits, turnsPerDay: already + 3 }), null);
});

test("sliding window: allows max hits per window, then frees up as old hits expire", () => {
  let t = 0;
  const w = new SlidingWindow(2, 1000, () => t);
  assert.equal(w.take("ip"), true);
  t = 400;
  assert.equal(w.take("ip"), true);
  assert.equal(w.take("ip"), false);
  assert.equal(w.take("other"), true); // per key
  t = 1001; // the first hit has expired
  assert.equal(w.take("ip"), true);
  assert.equal(w.take("ip"), false);
  assert.equal(new SlidingWindow(0, 1000).take("x"), true); // 0 means off
});

test("client IP: the socket address, or the proxy-added (last) X-Forwarded-For entry when trusted", () => {
  const req = (fwd?: string) => ({ headers: fwd ? { "x-forwarded-for": fwd } : {}, socket: { remoteAddress: "10.0.0.1" } }) as unknown as http.IncomingMessage;
  assert.equal(clientIp(req("1.1.1.1, 2.2.2.2"), false), "10.0.0.1"); // not behind a proxy: the header is ignored
  assert.equal(clientIp(req("forged, 2.2.2.2"), true), "2.2.2.2");
  assert.equal(clientIp(req(), true), "10.0.0.1");
});
