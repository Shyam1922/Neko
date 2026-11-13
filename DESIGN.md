# Recall: design

Recall is a chat agent whose one tool is web search. It does what ordinary chatbots can't: connect an earlier conversation to what has changed since ("Has any of those tools changed pricing since Monday?"), and be honest about what it cannot compare.

## How it works

One turn: **route → memory lookup → (claims → search → compare) → answer.**

1. **Router** (1 model call, structured output) classifies the turn (chat, research, memory, memory+research) and copies out the user's time words and topic. Bad output falls back to plain research, so the worst case is an ordinary search chatbot.
2. **Memory lookup** (code). "Last Tuesday" becomes ranked candidate days in the timezone stored with each message; conversations from those days are scored by topic. Result: one match, several (reported with times), a real ambiguity (a concrete question), or no record.
3. **Then versus now.** The model reads the old answers into claims; code keeps a claim only if its quote really appears in the stored message. One search per product, then the model proposes current values with quotes. Code keeps a value only if the quote is in that page and the number is in the quote, requires like-for-like (plan, billing period, unit), and computes the verdict: **changed / unchanged / couldn't verify / no baseline**.
4. **No record is not a dead end.** "Has pricing changed since last Tuesday?" can be answered from the web alone, so without a stored baseline Recall says so first, then searches what changed after the date code resolved.
5. **Answer** (1 model call, streamed) receives only verified findings and has no search tool in that case, so it cannot add unverified ones. "That's wrong" excludes the recalled chat and retries; after a second miss it asks a concrete question.

Facts the user states about themselves ("we're a 20-person team") are picked out by the same router call, kept only as verbatim quotes, and shown in an editable panel, so personalisation costs no extra call.

A casual chat costs 2 model calls; a then-versus-now check 3 (4 the first time).

**Code is the librarian, the model is the reader.** The model has no memory; each call sees only what code puts in the prompt. Anything that must be exact is code: date arithmetic, finding conversations, quoting the user, search caps, provenance ("searched" vs "model knowledge", from our own search log), and verdicts. The worst failure here is a fabricated baseline, so unverifiable output is dropped, never repaired.

## Why this way

Chatbots keep history and the web apart; joining them needs claim-level memory ("what did you say, about what, when"), not transcript search. Calls, searches and retries are capped for a zero-budget free tier. Model and search sit behind small interfaces (`Llm`, `Search`).

## Considered and rejected

- **Vector database / embeddings:** the corpus is tiny; date filter plus keyword overlap is explainable.
- **Agent framework:** the search loop is about 100 lines; a framework would hide what reviewers should read.
- **SQLite:** one JSON file per chat is readable and needs no server.
- **Fine-tuning:** weights can't give exact, updatable, source-linked recall.
- **Always search:** slower, costs quota, worse for simple questions.
- **Model-judged verdicts:** convenient, but they can't be audited.

## Known limits

Verified on a handful of real conversations (Gemini 3.5 Flash-Lite plus the live search server), not an evaluation set. Search turns take about 11 to 22 seconds on the free tier; routing alone adds 2 to 5. Text claims that differ only in wording end as "couldn't verify", never "changed". The app is single-user.

## With another week

An evaluation harness with golden conversations; a "what shipped since" search driven by source dates; lower latency (skip the router on obvious chat, overlap search and extraction); source-quality scoring (official pages over aggregators); a second model provider as fallback; generated chat titles.
