# Decisions

A running log of what was chosen, what else was on the table, and why. Newest first.

## 2026-11-28 · UX Phase 1: fixes and a first move for new visitors

A UX audit (desktop and phone, measured accessibility, timed turns, a look at Perplexity and ChatGPT) produced a 3-phase roadmap. Phase 1 is the small, must-ship part:
- **Truthful storage copy.** The help panel still said chats stay "on this computer"; since Postgres they live on Neko's server under an anonymous, cookie-tied account. It now says that, and how to delete them.
- **Starter prompts.** Three one-click buttons on the landing screen, each showing a different capability: a live price lookup that invites "has it changed since?" later, a memory question, and a personal preference. The headline now leads with the product's angle: "Ask once. I'll keep track of what changes."
- **Phones.** Every control is at least 44 px; the history drawer is a fixed `min(300px, 86vw)` and hidden from the tab order when closed; the header shows only the avatar so the chat title gets the room; the landing hero sits at the top.
- **Keyboard and screen readers.** One `:focus-visible` ring in both themes (a darker clay in light mode, since the accent itself is under 3:1 on the background), a label on the message box, `aria-expanded` and Escape on the drawer, and a real `<main>` landmark with the chat title as the page's h1. `prefers-reduced-motion` turns transitions off.

axe-core (WCAG 2.2 AA plus best practice) reports 0 issues on the landing screen, a chat, the drawer and both dialogs, at 1280 and 375 px, light and dark. The demo GIF still shows the old landing headline; re-record it when the model API is reachable.

## 2026-11-27 · Task 5: README, demo, and a bug the demo found

**The README leads with proof.** A reviewer skims for about 30 seconds, so the first screen holds the pitch, the live link, a 20-second demo GIF, and a table of what was engineered, with numbers that link to how they were measured. Setup and configuration moved down.

**The demo GIF is real.** Recorded from the running app with live model calls and live search, then stitched with captions (Pillow). No mock-ups.

**Bug found while recording: malformed tool calls spent the search budget.** The first take answered "I could not verify… due to search limits" with zero searches run. Printing the model's raw tool calls showed why: about 1 time in 3, `gemini-3.5-flash-lite` names the field `queries` instead of `search_queries`. The loop refused those calls, which is right, but also counted them as searches, so two slips used up the whole budget of 2. The fix keeps "refuse, don't repair" (no guessing that `queries` meant `search_queries`):
- A refused call no longer counts as a search.
- The error names the exact fields, so the model can retry correctly.
- Up to 2 extra rounds are allowed for these retries, so the loop stays bounded.

A regression test reproduces the two-slip case. The evals didn't catch it because they use fixed search results and never run the live tool loop: a gap worth closing next.

## 2026-11-27 · Task 4: evals

**What is measured, and how** (`npm run eval`, scoring in [eval/score.ts](eval/score.ts), fixtures in [eval/fixtures](eval/fixtures)):
- *Router accuracy*: 12 routing cases plus every memory question (39 messages).
- *Recall@1*: 27 memory questions against a fixed history of 10 chats. The first conversation shown must be the right one, or the answer must be an honest "no record", or a "which one?" when the question is ambiguous. Run twice on the same router output: keywords only, and hybrid. Recall@3 and "wrong chats also offered" are reported too, because a right answer buried among wrong ones is still a worse experience.
- *Verdict accuracy*: 6 then-vs-now scenarios, 8 verdicts. Each scenario brings **fixed** search results, so a verdict can't change because the web did.
- *Grounding*: every quote the model proposes (claims, current values) is checked against its source with code written separately from the app's own check. Reported twice: invented quotes the model *proposed*, and invented quotes that *passed* (must be 0).
- *Profile*: 10 messages; the right facts saved, and nothing forbidden saved (password, email, phone, card, another person's city, a hypothetical).
- *Latency*: median and p90 per model call, timed without the pacing waits.

**End to end, not component by component.** The recall suite uses the real router's time phrase and topic, not hand-written ones. A router mistake therefore shows up as a recall miss, which is what a user would see.

**The eval runs the app's code, not a copy.** The then-vs-now step that picks which claims to re-check was moved out of the pipeline into `selectForRecheck()`, so the harness and the app share it.

**Rate limits.** The free tier allows a few requests per minute. The first run had 27 of 47 calls fail on rate limits, so its numbers measured Google's quota, not Neko. The runner now paces calls (`--rpm`, default 12) and waits as long as Google asks on a per-minute limit. A daily-limit error still stops the run. The app itself keeps its 20-second cap, because a person is waiting.

**Tuning without fooling myself.** After the first clean run, 8 held-out memory questions were written *before* changing anything, and scored with the old settings (100%). Two changes followed, both aimed at causes found in the results, not at the scores:
1. The router sometimes fills the topic with words about the conversation itself ("previous questions"). Recall then demanded a topic match no chat could meet. Those words are now stop-words (including plurals, which the first version missed: a unit test caught it).
2. When several chats match a topic, only those within 0.3 of the best are listed. This removed weak half-keyword matches ("holiday **plans**" vs "workout **plan**").

Held-out recall stayed at 100% and wrong chats offered fell from 8 to 3. I did **not** lower the similarity threshold to rescue the one remaining miss ("job applications" → the resume chat, cosine 0.600 against a 0.625 bar): that would be fitting the bar to one case. Every "no record" case sat at 0.553–0.555, so the margin is real but thin, and the next step is more data, not a new number.

**Results** (gemini-3.5-flash-lite, 27 Nov 2026):

| Metric | Result |
| --- | --- |
| Router accuracy | 100% (39/39) |
| Recall@1, keywords only | 56% |
| Recall@1, hybrid | 96% (dev 95%, held-out 100%) |
| Verdict accuracy | 100% (8/8) |
| Invented quotes reaching the answer | 0 |
| Profile facts correct / unsafe saved | 100% (10/10) / 0 |
| Median model call | about 1.0–1.3 s |

**Second model: gemini-3.5-flash, no valid score.** The full run (27 Nov) had 50 of 55 calls fail with 503 "high demand"; the 5 successful calls took a median of 93 s and a p90 of 216 s. Its scorecard (10% router accuracy and so on) measures availability, not quality, so it isn't reported as accuracy. The runner now flags any run with over 10% failed calls as INVALID. The honest conclusion: on a free key, flash is too slow and too often unavailable for a chat that should answer in seconds. A quality comparison needs a paid key or a quieter hour.

**What the eval doesn't cover yet:** the final written answer (is every number in it from the findings?), the correction ladder ("that's the wrong one"), and real-world phrasing from actual users. The set is small (about 60 judged items), so one case moves recall by 4 points.

## 2026-11-27 · Task 3: semantic search with embeddings

**pgvector in the existing Postgres, not a vector database.**
- Alternatives: Pinecone, Qdrant or Chroma as a second store.
- Why: one database means one backup, one connection, and the per-user filter is a plain `WHERE user_id = $1` in the same query. Deleting a chat deletes its vectors through a foreign key, so there are no orphaned vectors to clean up. PGlite loads the same extension, so tests run on real pgvector SQL.

**Exact search, no HNSW index (for now).**
- Every search is restricted to one user's messages: a few hundred rows at most. An exact scan over that is fast and gives exact answers.
- An approximate index pays off with a large shared corpus (Task 6's job listings), and that's where it belongs. Filtering an HNSW index by user can also silently return fewer results than asked for.

**Hybrid scoring: `max(keywords, meaning)`, after the date filter.**
- Order of work: resolve the date (code), keep chats active on those days, then score the topic. Embeddings never override the date: a close match on Monday is *offered* ("the closest is …"), never taken as Tuesday's chat.
- Cosine similarity is mapped onto the keyword scale: 0.55 → 0, 0.70 → 1, so the existing "strong match" line (0.5) sits at a cosine of 0.625. The numbers come from real `gemini-embedding-001` output: the same topic in other words scored 0.65–0.68, unrelated topics 0.49–0.60.
- Why `max` and not a weighted sum: each signal alone is good evidence. A keyword hit shouldn't be diluted by a low cosine, and a strong cosine (synonyms) shouldn't need a keyword. Each hit records which signal won (`via`), for the logs and evals.
- Known weakness: a long chat covering many topics scores well on many queries, because a chat's score is its *closest message*. On real data it shows up as an extra third candidate in "did we ever talk about…" lists. To be measured and tuned with Task 4's eval set.

**Retrieval task types.** Stored messages are embedded as `RETRIEVAL_DOCUMENT` and topics as `RETRIEVAL_QUERY`. On the probe set this separated related from unrelated chats noticeably better than embedding both the same way.

**Embed in the background, never in the request path.**
- After a reply is sent, `kick()` embeds every message without a vector (batches of 50, one run at a time per process). Startup runs it too, which backfills older data.
- If the model fails (quota, outage), the error is logged and the next turn retries. A memory question that can't embed its topic within 8 seconds falls back to keywords; the turn log records `recallMode` as `hybrid` or `keywords`.
- Cost: one embedding call per turn (both messages in one batch), plus one per memory question.

**Model choice.** `gemini-embedding-001` at 768 dimensions (it supports smaller outputs than its default 3,072; 768 keeps rows small and is well within pgvector's limits). `gemini-embedding-2` was tried, but returned one vector for a whole batch through this SDK. The model is configurable with `EMBED_MODEL`, and each vector records the model that made it, so a later switch can re-embed.

**Concurrency bugs found by running the tests on real Postgres** (several test processes share one database, so they behave like simultaneous users):
- *Delete during embedding broke a foreign key.* The indexer checked "does this message still exist?" and then inserted its vector; a delete could commit in between. Fix: lock the rows that still exist (`FOR KEY SHARE`) and skip the rest. A delete then waits for the batch to commit.
- *Deadlock between delete and the indexer.* A delete locks the conversation, then its messages; the indexer locked messages first, then (through its foreign-key check) the conversation. Postgres detected the cycle and killed one side, sometimes the user's delete. Fix: the indexer locks in the same order, conversations then messages, sorted by id. Rule to remember: everyone takes locks in the same order.
- `append` now takes `FOR NO KEY UPDATE` rather than `FOR UPDATE`: it only changes `last_at`, so it still queues concurrent appends but no longer blocks other transactions' foreign-key checks.
- The rate-limit window gained an upper bound (`at <= now`). Production has no future-dated messages, but "the last 24 hours" should mean exactly that.
- Verified with 10 consecutive full runs against Postgres 17 + pgvector 0.8.7.

**Before/after on real data** (the 9 imported chats; topics phrased in other words): keywords alone found nothing for "East Africa", "precious metals" and "answer style preferences"; hybrid found the right chats for all three, and still found nothing for an unrelated topic ("cooking recipes"). Formal recall@1 numbers come with Task 4.

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
