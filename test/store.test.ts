import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JsonStore, isValidId } from "../src/memory/store.ts";

const tmp = () => mkdtemp(path.join(os.tmpdir(), "recall-"));

test("append creates a conversation and sets server-side timestamps", async () => {
  const fixed = new Date("2026-11-03T10:00:00Z");
  const store = new JsonStore(await tmp(), () => fixed);
  const { conversation, message } = await store.append(undefined, { role: "user", text: "Postgres hosting?", tz: "Asia/Kolkata" });
  assert.equal(message.at, fixed.toISOString());
  assert.equal(conversation.title, "Postgres hosting?");
  assert.equal(message.tz, "Asia/Kolkata");
  assert.deepEqual((await store.get(conversation.id))?.messages.length, 1);
});

test("invalid timezone falls back to the default", async () => {
  const store = new JsonStore(await tmp());
  const { message } = await store.append(undefined, { role: "user", text: "hi", tz: "Not/AZone" });
  assert.equal(message.tz, "Asia/Kolkata");
});

test("concurrent appends are not lost", async () => {
  const store = new JsonStore(await tmp());
  const { conversation } = await store.append(undefined, { role: "user", text: "start" });
  await Promise.all(Array.from({ length: 10 }, (_, i) => store.append(conversation.id, { role: "user", text: `m${i}` })));
  assert.equal((await store.get(conversation.id))?.messages.length, 11);
});

test("ids are validated; path tricks are rejected", async () => {
  const store = new JsonStore(await tmp());
  assert.equal(isValidId("../../etc/passwd"), false);
  assert.equal(await store.get("../x"), null);
  await assert.rejects(store.append("../x", { role: "user", text: "hi" }));
});

test("unknown conversation id is an error, not a silent new conversation", async () => {
  const store = new JsonStore(await tmp());
  await assert.rejects(store.append("does-not-exist", { role: "user", text: "hi" }), /not found/);
});

test("list is newest first and leaves no temp files behind", async () => {
  const dir = await tmp();
  let n = 0;
  const store = new JsonStore(dir, () => new Date(Date.UTC(2026, 10, 1 + n++)));
  const a = await store.append(undefined, { role: "user", text: "first" });
  const b = await store.append(undefined, { role: "user", text: "second" });
  const list = await store.list();
  assert.deepEqual(list.map((c) => c.id), [b.conversation.id, a.conversation.id]);
  assert.ok((await readdir(dir)).every((f) => f.endsWith(".json")));
});
