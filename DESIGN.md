# Recall: design

Recall is a chat agent whose one tool is web search. Its job is the thing ordinary chatbots can't do: connect an earlier conversation to what has changed since ("Has any of those five tools changed pricing since Monday?"), and be honest about what it cannot compare.

## How it works

One turn: **route → memory lookup → (claims → search → compare) → answer.**

1. **Router** (1 model call, structured output). Classifies the turn as chat, research, memory, or memory+research, and copies out the user's time words, topic and any "that's the wrong one" signal. Invalid output falls back to plain research, so the worst case is a normal search chatbot.
2. **Memory lookup** (code). Date phrases become ranked candidate days ("last Tuesday" gives the two most recent Tuesdays) in the timezone stored with each message. Conversations with a user message that day are scored by topic and recency. A topic question with no date ("did we ever talk about X") reports every match with times; a genuine ambiguity asks a concrete question built from real history; no match says "no record" and hands the model the current chat, quoted with exact times, in case the answer is earlier in the same conversation.
3. **Claims** (1 model call, once per old conversation, cached). The model reads old answers and proposes claims. Code keeps a claim only if its quote really appears in the cited message.
4. **Then versus now.** One search per product in parallel, then one model call proposes current values with quotes. Code keeps a value only if the quote is in that page's excerpt and the number is in the quote, requires like-for-like (same plan, billing period, unit), and computes the verdict: **changed / unchanged / couldn't verify / no baseline**. For non-numeric values, different wording alone is not a change: only differing figures count, otherwise the verdict is "couldn't verify".
5. **Answer** (1 model call, streamed). It receives the verified findings as facts and has no search tool, so it cannot add unverified ones.
6. **Correction ladder.** "That's wrong" excludes the recalled conversation and retries (including the other date reading); after a second miss it stops guessing and lists real options.

A casual chat costs 2 model calls; a then-versus-now check costs 3 (4 the first time, while claims are extracted). Requests retry on rate limits and Google's "high demand" errors, and failures show Google's real reason instead of a spinner.

**Three ideas.** The stored transcript is the source of truth. Every claim carries provenance, "searched" or "model knowledge", taken from our own search log and never from the model. Every comparison ends in an honest verdict, because the worst failure here is a fabricated baseline.

**Code is the librarian, the model is the reader.** The model has no memory; each call sees only what code puts in the prompt. So anything that must be exact is code: date arithmetic, finding conversations, quoting the user verbatim, search caps, provenance, numeric comparison. The model classifies, reads, and writes.

## Why built this way

- Chatbots keep history and the web apart. Joining them needs claim-level memory: "what did you say, about what, when", not transcript search.
- The router and caps (2 searches per turn, a 10-minute result cache, claims extracted only on demand) exist for a zero-budget free tier.
- Every model output that gates behavior is validated, and unverifiable output is dropped rather than repaired.
- Model and search sit behind small interfaces (`Llm`, `Search`), so either can be swapped.
- The UI is a static page with no build step: a sidebar of past chats, a landing screen, and a streamed reply.

## Considered and rejected

- **Vector database / embeddings.** The corpus is tiny; date filter plus keyword overlap is explainable. Revisit if real misses appear.
- **Agent framework.** The search loop is about 100 lines; a framework would hide the part reviewers should read.
- **SQLite.** One JSON file per conversation is readable and needs no server. Fine until data grows.
- **Fine-tuning.** Weights can't give exact, updatable, source-linked recall.
- **Multi-tool agent.** The brief says one tool; the model never sees `web_fetch`.
- **Always search.** Slower, costs quota, and worse for simple questions. The tool stays available on chat turns only because the router can misjudge a current-facts question as small talk.
- **Proactive alerts.** Out of scope for the core loop.

## Known limits

Unit tests use fake models; real runs (Gemini 3.5 Flash-Lite plus the live search server) cover a handful of conversations, not an evaluation set. Search turns take about 11 to 22 seconds on the free tier and vary with Google's load. The router is non-deterministic. A chat is titled by its first message, so different chats can look alike in the sidebar. "Those five tools" depends on the router resolving names from context; shortlists are not stored as versioned facts. Recall lists at most 3 matching conversations, and the sidebar has no delete or rename.

## With another week

Claim-level source diffing over time and scheduled re-checks with alerts; stronger entity resolution; an evaluation harness with golden conversations; SQLite or embeddings once data grows; source-quality scoring (official pages over aggregators); a second model provider as fallback; generated chat titles plus delete and rename.
