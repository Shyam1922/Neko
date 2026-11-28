# Neko

**A chat agent that remembers your past conversations, re-checks them against the live web, and tells you what changed, without ever inventing a past it can't prove.**

**Live demo: <https://neko-qt6g.onrender.com>** · no sign-up · the first load can take a minute while the free server wakes up

Designed and built solo by [Shyam](https://github.com/Shyam1922): agent design, retrieval, evals, backend and deployment.

![Neko in use: a live research answer with sources, a re-check of it in a new chat, and recall of an earlier chat by meaning](docs/demo.gif)

| | |
| --- | --- |
| **Recall** | Finds the past chat you mean by date and by meaning: recall@1 **96%** with embeddings vs **56%** on keywords alone ([evals](#evals)) |
| **Grounding** | Every baseline and current value is a verbatim quote, checked by code: **0** invented quotes reached an answer in the eval set |
| **Agent** | One router call with schema-validated JSON picks chat, web research (MCP search tool), memory, or then-vs-now; invalid output is dropped, not repaired |
| **Memory** | Per-user profile facts the user can see, edit, undo and delete; secrets, contact details and IDs are never stored |
| **Backend** | TypeScript on Node, Postgres + pgvector (embedded PGlite locally), anonymous multi-user accounts, rate limits, JSON logs |
| **Shipped** | Docker image, Render deploy from a one-file blueprint, 144 unit tests (also run against real Postgres), `npm run eval` scorecard |

> **You:** Earlier today I asked you about Neon pricing. Has anything changed since then?
>
> **Neko:** The monthly base fee, storage rate, and data egress allowance for Neon's Launch plan are unchanged since earlier today (…from a web search), but compute, instant restore, and extra branch rates **could not be verified**.

## Evals

`npm run eval` runs Neko's real router, recall, personalisation and then-versus-now code with a real model against fixed fixtures ([eval/fixtures](eval/fixtures)), then prints a scorecard. No web search is called: each then-versus-now scenario brings fixed search results, so a verdict can't change because the web did. The scoring rules are in [eval/score.ts](eval/score.ts), unit-tested.

| Metric | What it checks | gemini-3.5-flash-lite |
| --- | --- | --- |
| Router accuracy | 39 messages sent down the right path (chat, research, memory, then-vs-now) | 100% |
| Recall@1, keywords only | 27 memory questions: the right chat first, an honest "no record", or "which one?" when ambiguous | 56% |
| **Recall@1, hybrid** | the same questions with embeddings added | **96%** (held-out 100%) |
| Verdict accuracy | 8 Changed / Unchanged / Couldn't verify / No baseline verdicts | 100% |
| Invented quotes reaching the answer | quotes not literally in their source, after code's checks | **0** |
| Profile facts | right facts saved; passwords, emails, phones, cards, others' facts never saved | 100%, 0 unsafe |
| Median model call | router, claim extraction, comparison | 1.0–1.3 s |

**A second model.** `gemini-3.5-flash` couldn't be scored on a free key: 50 of its 55 calls failed with Google's "high demand" error, and the 5 that succeeded took a median of 93 seconds per call (flash-lite: 1.0 s). The runner marks such a run invalid rather than reporting its numbers as accuracy; the raw result is in [eval/results](eval/results). For an interactive agent on a free key, flash-lite is the only usable choice measured so far.

Embeddings take recall from 56% to 96%: most of the gain is questions worded differently from the chat ("East Africa" for a Uganda chat). Thresholds were tuned on a dev split and checked on 8 held-out questions written before tuning; how, and what was deliberately *not* tuned, is in [DECISIONS.md](DECISIONS.md). Every case and call is saved in [eval/results](eval/results).

```bash
npm run eval                                  # the configured model, all suites
npm run eval -- --model gemini-3.5-flash      # another model
npm run eval -- --suites router,recall        # some suites only
```

## Design decisions

The longer reasoning, with the alternatives rejected, is in [DECISIONS.md](DECISIONS.md) and [DESIGN.md](DESIGN.md).

- **Code is the librarian, the model is the reader.** Anything that must be exact is code: resolving "last Tuesday" to dates, finding the conversation, quoting it, deciding Changed / Unchanged. The model classifies, reads old answers into claims, and writes prose. A model can't invent a past if it never gets to supply one.
- **Drop invalid output, don't repair it.** A route that isn't one of four, a quote that isn't in its source, a profile fact that isn't the user's own words: all discarded. A repaired output is still a guess.
- **Hybrid recall, dates first.** The date filter always runs first and is never overridden by a vector; then a topic scores the stronger of keyword overlap and embedding similarity. Embeddings rescue paraphrases ("East Africa" → the Uganda chat) without letting "close enough" replace "on the day you said".
- **One database.** Postgres holds users, chats, profile facts and vectors (pgvector), so deleting a chat deletes its vectors through a foreign key and every query filters by user in plain SQL. Locally and in tests the same SQL runs on embedded PGlite.
- **Measure before tuning.** Held-out eval questions were written before any threshold changed. One known miss was left in rather than bending the threshold to fit it.

## What it does

| You ask | What Neko does |
| --- | --- |
| "What does Neon charge for Postgres hosting?" | Searches the web and answers with clickable source links. |
| "Has any of that changed since I asked on Monday?" | Finds that earlier conversation, re-checks each fact, and reports **changed / unchanged / couldn't verify / no baseline**, with sources. If there is no record of that chat, it says so first, then searches what changed on the web since that date. |
| "Did we ever talk about Uganda?" | Lists every earlier chat that mentions it, with times and your exact words. |
| "Did we discuss East Africa?" | Finds the Uganda chat even though you never wrote "East Africa": topics are matched by meaning (embeddings) as well as by keywords. |
| "No, that's not the one I meant" | Excludes that conversation and tries the next candidate; after a second miss it asks which one you mean. |
| "I'm Alex, I'm based in Lisbon and I prefer short answers" | Remembers it, tailors this and every later answer to you, and greets you by name. See [Personalisation](#personalisation). |
| "What is the capital of France?" | Answers directly. No search, no memory lookup. |

You don't need to read this to find out: the app explains itself. **What can Neko do?** (a link under the input on the landing screen, and the sparkle button in the top bar) lists the features in plain language.

![The "What Neko can do for you" panel, in the dark theme](docs/screenshots/features.jpg)

Every answer sits in a card with its evidence underneath: how long it took, how many searches ran, and which sites they returned.

![A web-searched answer in a card, with time taken, searches run and the sites checked](docs/screenshots/research.jpg)

Then-versus-now results show each verdict as a badge (**Changed**, **Unchanged**, **Couldn't verify**, **No baseline**):

![A then-versus-now check with verdict badges, in the dark theme](docs/screenshots/then-vs-now.jpg)

The worst failure for an assistant like this is **inventing a past that never happened**, so Neko never does: a baseline must be a verbatim quote from a stored message, and a current value must be a verbatim quote from a real search result. If it can't prove it, it says "no record" or "couldn't verify".

## How it works

```mermaid
flowchart LR
  Q[Your message] --> L[Limits + user<br/>code]
  L --> R[Router<br/>1 model call, JSON]
  R -->|chat / research| A[Answer<br/>streamed, up to 2 web searches]
  R -->|memory| M[Recall<br/>dates, then keywords + pgvector]
  R -->|memory + research| M
  M -->|one clear match| C[Claims<br/>quotes checked in code]
  C --> S[Search each product]
  S --> V[Compare in code<br/>changed / unchanged /<br/>couldn't verify / no baseline]
  V --> A
  M -->|several / none| A
  DB[(Postgres<br/>chats, facts, vectors)] -.-> M
```

The principle: **code is the librarian, the model is the reader.** The model has no memory, so anything that must be exact is done in code: date arithmetic, finding the right conversation, quoting you verbatim, search limits, provenance, and the verdicts. The model only classifies the message, reads old answers into claims, and writes the final reply. Every model output that gates behaviour is validated, and anything that fails verification is dropped, not repaired.

**Hybrid recall.** Finding "that chat about laptops" runs in a fixed order. First code resolves the date ("last Tuesday" → the days it could mean) and keeps only chats with a message on those days. Then each chat gets a topic score: the stronger of keyword overlap and closeness in meaning. Meaning comes from [pgvector](https://github.com/pgvector/pgvector): every message is embedded in the background after its turn (768-dimension vectors from `gemini-embedding-001`), and a topic is compared against one user's messages by cosine similarity. Embeddings only *find* candidates. The date filter, the quotes and the verdicts stay exact, in code, and if the embedding model is unavailable recall falls back to keywords instead of failing.

A casual chat costs 2 model calls; a then-versus-now check costs 3 (4 the first time). The full reasoning, the options rejected and the known limits are in **[DESIGN.md](DESIGN.md)**.

## Personalisation

Neko remembers what you tell it about yourself and uses it to tailor answers:

- **Facts you state** ("I'm Alex", "I'm a freelance designer", "my budget is 500 a month", "I'm based in Lisbon", "I prefer short answers") are saved automatically and used in every later chat, so you never repeat them. It also greets you by name.
- **Local context.** A saved currency or region steers how prices are shown. Neko never converts currencies from memory: if a source only gives another currency, it shows that and says so.
- **Tone and format.** A stated preference for short answers, bullets or detail is followed.
- **You stay in control.** Under each reply Neko says what it just remembered, with **Undo**. The **profile button** (top-right: your name and initial, or an icon until it knows your name) opens **Your profile**. It lists every saved fact, so you can check what it learned, correct a value, delete one, or forget everything. The same panel has the **Appearance** switch: Light, Dark, or System (follow your device). The theme choice is kept in your browser. Everything else is kept in Neko's database, under your own anonymous account (see [Storage and accounts](#storage-and-accounts)); nothing else leaves it except the model and search calls.

![Your profile panel: the theme switch (Light, Dark, System) and what Neko remembers about you](docs/screenshots/profile.jpg)

How it stays trustworthy: nothing is inferred. The router that already reads each message proposes facts you stated, and code keeps one only if it is a **verbatim quote** from your message, is short, and does not look like a secret, an email or an ID number (passwords, API keys, card or phone numbers and health details are never stored). That costs **no extra model call**. Facts live in the `profile_facts` table, one row per fact, with the message it came from; a newer statement replaces an older one for the same key.

## Watch

Under any answer that searched the web there is **Watch this**. Neko keeps the facts from that answer (the same verified claims a then-vs-now check uses) and re-checks them every week. Code decides each verdict, as in the chat. You only hear about a watch when a fact really **Changed**; "Couldn't verify" is never reported as a change. After a change, the new value becomes the baseline, so the same change is reported once.

- **In the app.** The sidebar's **Watching** section lists your watches. A changed one gets a **Changed** badge, and on a phone a dot on the menu button. Open it to see then vs now for each fact, with the source, and to pause or delete it. Up to 10 watches per person.
- **By email, optional.** When the server has email set up, Neko offers **Email me when it changes** after you add a watch. You get a sign-in link, not a password, and your address is stored only after you open it in the same browser. Every email has a one-click unsubscribe. The same address also signs you in on another device, with the same chats and watches. **Forget everything** removes the address.
- **How re-checks run.** Render's free service sleeps, so a timer inside the app can't be trusted. Instead, [a GitHub Actions job](.github/workflows/recheck.yml) calls `POST /api/cron/recheck` once a day with a shared secret. Each call checks a small batch of due watches, and never more than today's quota has left: `TURNS_PER_DAY` counts chat messages and re-checks together. Locally, `npm run recheck` does the same. `npm run recheck -- --all --fixture scripts/fixtures/neon-price-changed.json --print-email` makes a watched Neon price "change" on purpose, for trying the whole flow.

**Memory switch.** Your profile has a **Memory** switch. When it is off, Neko doesn't save anything new about you and doesn't use what's saved. Saved facts stay until you delete them.

## Run it

You need a recent Node.js (developed and tested on Node 24; there is no build step).

```bash
npm install
cp .env.example .env     # then paste your free key after GEMINI_API_KEY=
npm run dev              # http://localhost:3000
```

Get a free Gemini key at <https://aistudio.google.com/apikey>. Search needs **no key**. The server reads `.env` only at startup, so restart it after changing it.

**Try it:** ask something current, press **New chat**, then ask "has that changed since I asked you earlier?". The sidebar keeps your past chats; open one to continue it.

### Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | yes | | Free key from Google AI Studio |
| `GEMINI_MODEL` | no | `gemini-3.5-flash-lite` | Run `npm run check:models` to see what your key can use |
| `MODEL_TIMEOUT_SECONDS` | no | `45` | How long to wait for the model before showing an error; raise it for slower models |
| `PARALLEL_API_KEY` | no | | Higher limits on the hosted search server; works without it |
| `SEARCH_MCP_URL` | no | `https://search.parallel.ai/mcp` | Search server (MCP over HTTP) |
| `PORT` | no | `3000` | |
| `TURNS_PER_HOUR` | no | `30` | Messages one user may send per hour. `0` turns the limit off |
| `TURNS_PER_DAY` | no | `500` | Messages everyone together may send per 24 hours, to stay inside the key's daily quota. `0` = off |
| `NEW_USERS_PER_IP_PER_HOUR` | no | `10` | New anonymous accounts per IP address per hour, so clearing cookies doesn't reset the hourly limit. `0` = off |
| `TRUST_PROXY` | no | `false` | Set `true` behind a hosting proxy (Render, Railway, Fly) so the visitor's IP is read from `X-Forwarded-For` |
| `DATABASE_URL` | no | | A Postgres server, e.g. `postgres://user:pass@host:5432/neko`. Unset: an embedded Postgres in `DATA_DIR` |
| `DATA_DIR` | no | `data` | Where the embedded database lives (`data/pglite`) when `DATABASE_URL` is unset |
| `EMBED_MODEL` | no | `gemini-embedding-001` | Embedding model for finding chats by meaning; `off` = keywords only |
| `CRON_SECRET` | no | | Turns on `POST /api/cron/recheck` for the daily re-check of watches; at least 24 characters (`openssl rand -hex 32`). Put the same value in the GitHub repository secret `CRON_SECRET`. Unset: re-checks run only through `npm run recheck` |
| `RECHECK_BATCH` | no | `5` | The most watches re-checked per call |
| `RESEND_API_KEY` | no | | [Resend](https://resend.com) API key, for change emails and sign-in links. Unset: Neko never offers email |
| `EMAIL_FROM` | no | | The verified sender, e.g. `Neko <neko@yourdomain.com>`. Email is on only when this and `RESEND_API_KEY` are both set |
| `PUBLIC_URL` | no | Render's own URL, else `http://localhost:PORT` | The site's address, used in links inside emails |
| `EMAIL_LOG` | no | `false` | Local only: print emails (sign-in links included) to the server log instead of sending them. Never on a deployed server |

### Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the server with auto-reload |
| `npm test` | Unit tests (no network, key or database server needed; set `TEST_DATABASE_URL` to run them against a real Postgres) |
| `npm run eval` | The eval scorecard (needs the key; about 5 minutes on a free key) |
| `npm run stats` | Usage from the database: people who sent a message, returning people, answers, median and p90 answer time, per day. Set `DATABASE_URL` for a deployed database |
| `npm run recheck` | Re-checks due watches now, like the daily cron call (`--all` for every active watch, `--fixture <file>` for fixed search results, `--print-email` to print emails instead of sending). With the embedded database, stop the server first |
| `npm run import:json` | Copies chats and profile facts saved by older versions (`data/*.json`) into the database. Stop the server first |
| `npm run typecheck` | TypeScript check |
| `npm run ping:model` | One tiny model call with timings; tells key/network problems apart from app problems |
| `npm run check:models` | Lists the models your key can call |
| `npm run probe:search` | Connects to the search server and prints its tools and a sample result |

**Using a paid key or a stronger model.** The default, `gemini-3.5-flash-lite`, is the fastest option and works on free keys. A stronger model can give fuller answers but is slower: in one test on a free key, `gemini-3.5-flash` took 57 seconds for a search question against 6.8 seconds for the default, and `gemini-3.8-flash` gave no answer within 150 seconds. These were single runs. A paid key has higher limits and may be quicker, which I haven't been able to test. To switch, set `GEMINI_MODEL` and raise `MODEL_TIMEOUT_SECONDS` (see `npm run check:models` for what your key can use).

**Troubleshooting.** If the configured model isn't available for your key, Neko switches to the newest flash-lite model your key can use and logs the switch; to choose one yourself, pick from `npm run check:models` and set `GEMINI_MODEL`. Free-tier rate limits and Google's occasional "high demand" errors are retried automatically and otherwise shown with Google's own reason.

### Storage and accounts

Everything is stored in **Postgres**: `users`, `conversations`, `messages` and `profile_facts` (schema in [src/db/schema.ts](src/db/schema.ts)). With `DATABASE_URL` set, Neko uses that server. Without it, Neko runs an embedded Postgres ([PGlite](https://pglite.dev), Postgres compiled to WebAssembly) in `data/pglite`, so local use still needs no setup. Both run the same SQL.

There is no sign-up. The first message you send creates an anonymous account and stores its random id in an HttpOnly cookie. An email is optional and only ever added from a link you open (see [Watch](#watch)). Every query filters on that id, so people sharing one server never see each other's chats or profile. Clearing your cookies starts a fresh, empty account.

In the sidebar, hover a chat to **rename** or **delete** it. Deleting a chat removes its messages; facts it taught Neko stay in your profile until you remove them there.

## Deploy

**Docker, locally.** `docker compose up --build` runs Neko with a Postgres server (with pgvector) on <http://localhost:3000>. It reads your key from `.env`.

**Render (free).** The repo includes a blueprint, [render.yaml](render.yaml). In Render, choose **New → Blueprint**, pick this repository and paste your Gemini key when asked. Render builds the Dockerfile, creates a Postgres database and wires `DATABASE_URL`, and checks `/healthz`. Free web services sleep when idle, so the first visit after a quiet spell takes about a minute. A free Render database expires after 30 days; for a longer-lived demo, point `DATABASE_URL` at a free [Neon](https://neon.tech) database instead (add `?sslmode=require`).

**Protecting the key.** A public demo spends your Gemini quota, so the limits in the table above are on by default. Someone over a limit gets a plain message saying how long to wait, not an error. Request bodies are capped at 100 KB and messages at 8,000 characters.

**Logs.** Every turn writes one JSON line: route, total and first-token latency, model calls, searches, search errors, and the outcome (`ok`, `error`, `aborted`). Users appear as a short hash, never the cookie id. `npm run stats` turns the database into usage numbers.

## Project layout

```
src/
  server.ts            entry point: config, wiring, listen
  app.ts               HTTP server: /api/chat (streamed), /api/conversations, /api/profile, the user cookie, static files
  config.ts            env loading with clear errors
  limits.ts            per-user, daily and per-IP limits that protect the model key
  log.ts               one JSON line per event; users appear only as a hash
  db/
    db.ts              one interface over Postgres (DATABASE_URL) and embedded PGlite; migrations
    schema.ts          the tables, as append-only migrations
  adapters/
    llm.ts             Gemini: streaming, tool calls, JSON output, retries and timeouts
    search.ts          Parallel Search over MCP, plus a result cache
    embed.ts           Gemini embeddings (documents vs queries), in batches
    errors.ts          turns Google's raw errors into readable ones
  agent/
    pipeline.ts        one turn, end to end
    router.ts          classify the message and spot facts about you (1 model call)
    personalize.ts     which proposed facts are kept (verbatim quote, no secrets) and how the model sees them
    claims.ts          old answers -> verified claims
    compare.ts         then vs now: verification and verdicts, in code
    check.ts           re-check stored claims: search, read, compare (shared by the chat and by watches)
    recheck.ts         the scheduled re-check of watches: batch, quota, verdict rule, change email
    research.ts        bounded search loop (2 searches per turn)
    prompt.ts          system prompt
  memory/
    store.ts           one user's conversations and messages, in SQL
    users.ts           anonymous users
    dates.ts           "last Tuesday" -> ranked candidate days (injectable clock)
    recall.ts          find the conversation you mean: dates first, then keywords + meaning
    semantic.ts        embeds messages in the background; per-user similarity search (pgvector)
    profile.ts         the facts you told Neko about yourself (viewable, editable)
    watches.ts         "Watch this": watched facts, their checks, the per-user cap
    account.ts         memory switch, optional email: sign-in links (hashed, single use), unsubscribe
public/                the chat page: landing, answer cards, verdict badges, history (no build step; light and dark themes)
scripts/               ping-model, check-models, probe-search, import-json, stats, recheck (+ a fixture)
.github/workflows/     recheck.yml: the daily call that re-checks watches
Dockerfile, docker-compose.yml, render.yaml    container, local stack, Render blueprint
eval/                  eval fixtures, runner and scoring (npm run eval); results per model
test/                  unit tests with fake models, a fake search and a fake embedder
```

## Limits

The eval set is small (about 60 judged items, one made-up user), so one case moves recall by about 4 points. Search turns take roughly 11 to 22 seconds on the free tier. A chat is titled by its first message until you rename it. Accounts are anonymous and tied to one browser unless you add an email. Watches are re-checked about once a week, on the daily run after they fall due, so a change can take up to a day longer to show. See the *Known limits* section of [DESIGN.md](DESIGN.md) for the full list.
