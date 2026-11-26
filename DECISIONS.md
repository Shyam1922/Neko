# Decisions

A running log of what was chosen, what else was on the table, and why. Newest first.

## 2026-11-26 · Task 2: deploy, limits, logging

**Limits count rows that already exist.**
- Chose: the per-user hourly limit and the global daily limit run `count(*)` over recent user messages, backed by partial indexes on `messages (user_id, at)` and `messages (at)` where `role = 'user'`.
- Alternatives: an in-memory counter (lost on restart, wrong with two instances); Redis (another service to run for a demo); a separate counters table (duplicates what `messages` already records).
- Why: the messages table is already the source of truth, so the limit can't drift from what actually happened, and it holds across restarts and instances.
- The per-IP limit on new users is in memory (a sliding window), because there is no row to count for a refused visitor. It resets on restart, which is acceptable: it only stops someone clearing cookies to get a fresh hourly allowance.
- Limits are on by default, and `0` turns one off. A deploy that forgets the variables is still protected.
- Behind a proxy, the client IP is the *last* `X-Forwarded-For` entry, the one the proxy added. Earlier entries come from the client and can be forged. The header is ignored unless `TRUST_PROXY` is set.

**One JSON log line per turn.**
- Fields: route, total ms, router ms, first-token ms, model calls, searches, search errors, message and reply length, outcome.
- Model calls are counted by wrapping the `Llm` interface for the turn, so no agent code had to report them.
- Users are logged as a 10-character SHA-256 prefix. The raw id is the login cookie: logging it would let anyone with log access act as that user.
- Logs are for operations. Usage numbers come from the database (`npm run stats`), which outlives log retention.

**Runtime: tsx in production, no build step.**
- Alternatives: compile with `tsc` to JavaScript (a second code path to keep in sync); Node's built-in type stripping (it doesn't support constructor parameter properties, which the stores use).
- Cost: tsx becomes a runtime dependency and adds a moment to startup. Acceptable for this size.

**Hosting: Render blueprint, Docker everywhere.**
- The same Dockerfile runs in `docker compose` and on Render, so "works locally" means "works deployed".
- Compose uses the `pgvector/pgvector` image so Task 3 needs no infrastructure change.
- `/healthz` checks the database too, so the platform restarts an instance that lost its connection.

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
