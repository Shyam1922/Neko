# Decisions

A running log of what was chosen, what else was on the table, and why. Newest first.

## 2026-11-26 · Task 1: multi-user, SQL storage

**Postgres, with an embedded PGlite fallback.**
- Chose: one small `Db` interface ([src/db/db.ts](src/db/db.ts)) with two implementations: node-postgres when `DATABASE_URL` is set, and [PGlite](https://pglite.dev) (Postgres compiled to WebAssembly, running in-process) otherwise.
- Alternatives: SQLite (easy locally, but a different SQL dialect from production and no pgvector); Postgres only (every contributor and every test run would need a server or Docker); an ORM such as Prisma or Drizzle (a build step and generated code for four tables).
- Why: local dev and `npm test` still need no setup, production runs on a managed Postgres, and both execute the same SQL. PGlite also ships pgvector, so Task 3 (embeddings) can be tested the same way. Hand-written SQL keeps every query readable in review.

**Stores are scoped to one user.**
- Chose: `new ConversationStore(db, userId)` and `new ProfileStore(db, userId)`, created per request. Every query has `WHERE user_id = $n`.
- Alternative: pass `userId` into each method.
- Why: the agent pipeline did not change at all: it still calls `store.getAll()` and gets only this user's chats. A forgotten parameter is impossible because there is no parameter. Isolation tests (store and HTTP level) check that another user's id returns nothing and changes nothing.

**Anonymous users in an HttpOnly cookie.**
- Chose: the first message creates a user with a random UUID and sets `neko_uid` (HttpOnly, SameSite=Lax, Secure behind HTTPS, one year). Page loads and reads never create users. An unknown or forged id gets a fresh user; a client-chosen id is never adopted.
- Alternatives: sign-in (friction for a demo people try once); localStorage plus a header (readable by any script on the page); a signed cookie (a UUID has 122 random bits, so signing adds little for anonymous data).
- Trade-off: clearing cookies loses the account. That's fine for a demo and is stated in the README.

**Schema choices** ([src/db/schema.ts](src/db/schema.ts)).
- `text` ids, not `uuid`: the HTTP layer already validates id shape, and a malformed id should match no row rather than raise a cast error (a 404, not a 500).
- `messages.seq` identity column for ordering: timestamps can tie (fast turns, tests with a fixed clock).
- Claims, search logs and recall metadata stay `jsonb`: they are written and read whole, never queried by field. They can be split into tables later if that changes.
- `profile_facts.message_id` is a foreign key with `ON DELETE SET NULL`: deleting a chat keeps the fact (it's still true about the user) but drops the link to a message that no longer exists.
- `UNIQUE (user_id, key)` enforces one fact per key in the database, not just in code.
- Migrations are an append-only list, applied in one transaction under a Postgres advisory lock, so two instances starting together cannot both apply one.

**Concurrency.** The JSON store serialised every write through an in-process queue. That doesn't work across processes or app instances. Now `append` is one transaction that locks the conversation row (`SELECT ... FOR UPDATE`), and profile upserts lock the user row so two quick messages can't both pass the 40-fact cap. Tests fire 10 concurrent appends and 50 concurrent upserts.

**Old data.** `npm run import:json` copies `data/*.json` and the old profile file into the most recently active user. It is idempotent: existing rows are skipped.
