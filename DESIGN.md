# Neko: design

Neko is a chat agent whose one tool is web search. It does what ordinary chatbots can't: connect an earlier conversation to what has changed since ("Has any of those tools changed pricing since Monday?"), and be honest about what it cannot compare.

## How it works

One turn: **route → memory lookup → (claims → search → compare) → answer.**

1. **Router** (1 model call, structured output) classifies the turn (chat, research, memory, memory+research) and copies out the user's time words and topic. Bad output falls back to plain research, so the worst case is an ordinary search chatbot.
2. **Memory lookup** (code). "Last Tuesday" becomes ranked candidate days in each message's own timezone, and chats from those days are scored by topic. Result: one match, several (all reported), a real ambiguity (a concrete question), or no record. "That's wrong" excludes the chat and retries; after a second miss it asks.
3. **Then versus now.** The model reads old answers into claims; code keeps a claim only if its quote really appears in the stored message. After one search per product, the model proposes current values with quotes; code keeps one only if the quote is on that page and the number is in the quote, requires like-for-like (plan, billing period, unit), and computes the verdict: **changed / unchanged / couldn't verify / no baseline**. Different wording alone is never "changed".
4. **No record is not a dead end.** Without a stored baseline Neko says so (that sentence is written by code, not the model), then searches what changed on the web after the date code resolved.
5. **Answer** (1 model call, streamed) receives only verified findings and no search tool, so it can't add unverified ones.

Facts the user states about themselves ride on the router call, are kept only as verbatim quotes, and sit in an editable profile panel, so personalisation costs no extra call. Chats and profile live in Postgres (embedded PGlite when no server is configured), one anonymous user per browser cookie, and every query filters by user. A casual chat costs 2 model calls; a then-versus-now check 3 (4 the first time).

**Code is the librarian, the model is the reader.** The model has no memory, so anything that must be exact is code: dates, finding chats, quoting, search caps, provenance ("searched" vs "model knowledge", from our own log) and verdicts. The worst failure here is a fabricated baseline, so unverifiable output is dropped, never repaired.

## Considered and rejected

Vector database (tiny corpus; a date filter plus keywords is explainable) · agent framework (the loop is about 100 lines, and a framework would hide what reviewers should read) · SQLite (Postgres instead: the same SQL runs embedded locally and on a hosted server, and pgvector is ready for embedding search) · fine-tuning (can't give exact, source-linked recall) · always searching (slower, costs quota) · model-judged verdicts (can't be audited).

## Known limits

Checked on a handful of real conversations, not an evaluation set. Search turns take roughly 9 to 20 seconds on the free tier (routing adds 2 to 5), which is the weakest point against "answer fast". Wording-only differences end as "couldn't verify". Accounts are anonymous and tied to one browser.

## With another week

Nudges: scheduled re-checks so Neko speaks up only when something you asked about has changed (the stored claims already give the baseline; a scheduler and a quiet notifier are missing). Also an evaluation harness, lower latency (skip the router on obvious chat), official-over-aggregator source scoring, and a second model provider.
