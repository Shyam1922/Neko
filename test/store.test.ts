import { test } from "node:test";
import assert from "node:assert/strict";
import { ConversationStore, isValidId, type Claim } from "../src/memory/store.ts";
import { migrate, openDb } from "../src/db/db.ts";
import { MIGRATIONS } from "../src/db/schema.ts";
import { touchUser } from "../src/memory/users.ts";
import { newUser, testDb } from "./db-helper.ts";

const storeFor = async (now?: () => Date) => new ConversationStore(await testDb(), await newUser(), now);

test("append creates a conversation and sets server-side timestamps", async () => {
  const fixed = new Date("2026-11-03T10:00:00Z");
  const store = await storeFor(() => fixed);
  const { conversation, message } = await store.append(undefined, { role: "user", text: "Postgres hosting?", tz: "Asia/Kolkata" });
  assert.equal(message.at, fixed.toISOString());
  assert.equal(conversation.title, "Postgres hosting?");
  assert.equal(conversation.startedAt, fixed.toISOString());
  assert.equal(message.tz, "Asia/Kolkata");
  assert.deepEqual((await store.get(conversation.id))?.messages.length, 1);
});

test("invalid timezone falls back to the default", async () => {
  const store = await storeFor();
  const { message } = await store.append(undefined, { role: "user", text: "hi", tz: "Not/AZone" });
  assert.equal(message.tz, "Asia/Kolkata");
});

test("messages keep their order, searches, recall and timing", async () => {
  const store = await storeFor(() => new Date("2026-11-03T10:00:00Z")); // same timestamp for every message
  const { conversation } = await store.append(undefined, { role: "user", text: "one" });
  const searches = [{ query: "neon pricing", urls: ["https://neon.com/pricing"], retrievedAt: "2026-11-03T10:00:00.000Z" }];
  const recall = { ids: ["abc"], topic: "neon", route: "memory" };
  await store.append(conversation.id, { role: "assistant", text: "two", searches, recall, ms: 1234.6 });
  await store.append(conversation.id, { role: "user", text: "three" });
  const msgs = (await store.get(conversation.id))!.messages;
  assert.deepEqual(msgs.map((m) => m.text), ["one", "two", "three"]); // ties on time are broken by insertion order
  assert.deepEqual(msgs[1].searches, searches);
  assert.deepEqual(msgs[1].recall, recall);
  assert.equal(msgs[1].ms, 1235);
  assert.equal(msgs[0].recall, undefined);
  assert.equal(msgs[0].ms, undefined);
});

test("concurrent appends are not lost", async () => {
  const store = await storeFor();
  const { conversation } = await store.append(undefined, { role: "user", text: "start" });
  await Promise.all(Array.from({ length: 10 }, (_, i) => store.append(conversation.id, { role: "user", text: `m${i}` })));
  assert.equal((await store.get(conversation.id))?.messages.length, 11);
});

test("ids are validated; malformed ids match nothing", async () => {
  const store = await storeFor();
  assert.equal(isValidId("../../etc/passwd"), false);
  assert.equal(await store.get("../x"), null);
  await assert.rejects(store.append("../x", { role: "user", text: "hi" }));
  assert.equal(await store.rename("../x", "t"), false);
  assert.equal(await store.remove("../x"), false);
});

test("unknown conversation id is an error, not a silent new conversation", async () => {
  const store = await storeFor();
  await assert.rejects(store.append("does-not-exist", { role: "user", text: "hi" }), /not found/);
});

test("list is newest first, with message counts", async () => {
  let n = 0;
  const store = await storeFor(() => new Date(Date.UTC(2026, 10, 1 + n++)));
  const a = await store.append(undefined, { role: "user", text: "first" });
  const b = await store.append(undefined, { role: "user", text: "second" });
  await store.append(a.conversation.id, { role: "assistant", text: "reply" }); // a is now the most recent
  const list = await store.list();
  assert.deepEqual(list.map((c) => [c.id, c.messageCount]), [[a.conversation.id, 2], [b.conversation.id, 1]]);
  assert.equal("messages" in list[0], false);
});

test("patch stores claims and rejected ids without touching messages; getAll returns everything", async () => {
  const store = await storeFor();
  const { conversation, message } = await store.append(undefined, { role: "assistant", text: "Neon Launch is $19/month." });
  const claim: Claim = {
    id: "c1", messageId: message.id, entity: "Neon", attribute: "price", valueText: "$19", amount: 19, unit: "USD/month",
    qualifiers: { plan: "Launch" }, quote: "$19/month", assertedAt: message.at, provenance: "searched", perishability: "volatile", sources: [],
  };
  await store.patch(conversation.id, { claims: [claim] });
  await store.patch(conversation.id, { rejected: ["other"] }); // a second patch leaves claims alone
  const got = (await store.get(conversation.id))!;
  assert.deepEqual(got.claims, [claim]);
  assert.deepEqual(got.rejected, ["other"]);
  assert.equal(got.messages.length, 1);
  await assert.rejects(store.patch("nope", { rejected: [] }), /not found/);

  const second = await store.append(undefined, { role: "user", text: "another" });
  const all = await store.getAll();
  assert.deepEqual(new Set(all.map((c) => c.id)), new Set([conversation.id, second.conversation.id]));
  assert.equal(all.find((c) => c.id === conversation.id)?.messages[0].text, "Neon Launch is $19/month.");
});

test("rename and delete", async () => {
  const store = await storeFor();
  const { conversation } = await store.append(undefined, { role: "user", text: "hello" });
  await store.append(conversation.id, { role: "assistant", text: "hi" });
  assert.equal(await store.rename(conversation.id, "Greetings"), true);
  assert.equal((await store.get(conversation.id))?.title, "Greetings");
  assert.equal(await store.rename("nope", "x"), false);
  assert.equal(await store.remove(conversation.id), true);
  assert.equal(await store.get(conversation.id), null);
  assert.equal(await store.remove(conversation.id), false);
  assert.deepEqual(await store.list(), []);
  // Its messages went with it.
  const { rows } = await (await testDb()).query("SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1", [conversation.id]);
  assert.equal(rows[0].n, 0);
});

test("users are isolated: one user's store cannot read, change or append to another's chats", async () => {
  const db = await testDb();
  const alice = new ConversationStore(db, await newUser());
  const bob = new ConversationStore(db, await newUser());
  const { conversation } = await alice.append(undefined, { role: "user", text: "alice's secret plan" });

  assert.equal(await bob.get(conversation.id), null);
  assert.deepEqual(await bob.list(), []);
  assert.deepEqual(await bob.getAll(), []); // so recall can never surface someone else's chat
  await assert.rejects(bob.append(conversation.id, { role: "user", text: "hi" }), /not found/);
  await assert.rejects(bob.patch(conversation.id, { rejected: [] }), /not found/);
  assert.equal(await bob.rename(conversation.id, "pwned"), false);
  assert.equal(await bob.remove(conversation.id), false);

  const still = await alice.get(conversation.id);
  assert.equal(still?.title, "alice's secret plan");
  assert.equal(still?.messages.length, 1);
});

test("migrations are idempotent and users are recognised", async () => {
  const db = await openDb();
  await migrate(db); // running again changes nothing
  const { rows } = await db.query("SELECT version FROM schema_migrations");
  assert.equal(rows.length, MIGRATIONS.length);
  assert.equal(await touchUser(db, "no-such-user"), false);
  await db.close();
});
