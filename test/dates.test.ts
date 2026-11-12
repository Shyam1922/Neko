import { test } from "node:test";
import assert from "node:assert/strict";
import { dayOf, resolveTimePhrase, safeTimeZone } from "../src/memory/dates.ts";

// Thursday 12 November 2026, 14:00 in Delhi.
const NOW = new Date("2026-11-12T08:30:00Z");
const TZ = "Asia/Kolkata";
const days = (phrase: string, now = NOW, tz = TZ) => resolveTimePhrase(phrase, now, tz).map((c) => c.from);

test("yesterday and today", () => {
  assert.deepEqual(days("yesterday"), ["2026-11-11"]);
  assert.deepEqual(days("today"), ["2026-11-12"]);
  assert.deepEqual(days("3 days ago"), ["2026-11-09"]);
});

test("'earlier today' style phrases mean today (the router often says it this way)", () => {
  for (const p of ["earlier today", "Earlier", "this morning", "this afternoon"]) assert.deepEqual(days(p), ["2026-11-12"], p);
});

test("weekdays return the two most recent past occurrences, newest first", () => {
  assert.deepEqual(days("on Monday"), ["2026-11-09", "2026-11-02"]);
  assert.deepEqual(days("last Tuesday"), ["2026-11-10", "2026-11-03"]);
  // Today is Thursday: "Thursday" means a past Thursday, not today.
  assert.deepEqual(days("Thursday"), ["2026-11-05", "2026-10-29"]);
});

test("labels read like the 'taking that as' line", () => {
  assert.equal(resolveTimePhrase("last Tuesday", NOW, TZ)[0].label, "Tue 10 Nov");
});

test("day-and-month phrases give the latest occurrence that is not in the future", () => {
  assert.deepEqual(days("3 November"), ["2026-11-03"]);
  assert.deepEqual(days("November 3rd"), ["2026-11-03"]);
  assert.deepEqual(days("on 3rd Nov"), ["2026-11-03"]);
  assert.deepEqual(days("20 December"), ["2025-12-20"]); // later this year, so last year's
  assert.deepEqual(days("12 November"), ["2026-11-12"]); // today counts
});

test("impossible or unknown phrases return nothing instead of guessing", () => {
  assert.deepEqual(days("31 November"), []);
  assert.deepEqual(days("someday"), []);
  assert.deepEqual(days("3 blorp"), []);
});

test("last week is the previous Monday to Sunday", () => {
  const [week] = resolveTimePhrase("last week", NOW, TZ);
  assert.equal(week.from, "2026-11-02");
  assert.equal(week.to, "2026-11-08");
});

test("the timezone decides which day it is", () => {
  const lateUtc = new Date("2026-11-12T20:00:00Z"); // already Fri 13 Nov 01:30 in Delhi
  assert.equal(dayOf(lateUtc, "Asia/Kolkata"), "2026-11-13");
  assert.equal(dayOf(lateUtc, "UTC"), "2026-11-12");
  assert.deepEqual(days("yesterday", lateUtc, "Asia/Kolkata"), ["2026-11-12"]);
  assert.deepEqual(days("yesterday", lateUtc, "UTC"), ["2026-11-11"]);
});

test("weekday search crosses month and year boundaries", () => {
  const jan = new Date("2027-01-02T06:00:00Z"); // Saturday
  assert.deepEqual(days("Wednesday", jan), ["2026-12-30", "2026-12-23"]);
});

test("safeTimeZone", () => {
  assert.equal(safeTimeZone("Europe/London"), "Europe/London");
  assert.equal(safeTimeZone("nope"), "Asia/Kolkata");
  assert.equal(safeTimeZone(undefined), "Asia/Kolkata");
});
