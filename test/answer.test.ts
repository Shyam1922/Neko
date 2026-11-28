import { test } from "node:test";
import assert from "node:assert/strict";
import { numberSources, renderAnswer, sourceFor } from "../public/answer.js";

const log = (...urls: string[]) => ({ query: "q", urls, retrievedAt: "2026-11-28T08:00:00Z" });
const sources = numberSources([log("https://www.neon.com/pricing", "https://docs.neon.tech/x"), log("https://subscriptiongauge.com/neon")]);
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

test("sources are numbered in search order, each page once; failed searches and non-web URLs add nothing", () => {
  const s = numberSources([
    log("https://a.com/p", "https://b.com/"),
    { query: "x", urls: ["https://c.com"], retrievedAt: "", error: "timeout" },
    log("https://a.com/p/#pricing", "javascript:alert(1)", "not a url", "https://d.com/q"),
  ]);
  assert.deepEqual(s.map((x) => [x.n, x.url, x.host]), [
    [1, "https://a.com/p", "a.com"],
    [2, "https://b.com/", "b.com"],
    [3, "https://d.com/q", "d.com"],
  ]);
  assert.equal(numberSources(undefined).length, 0);
  assert.equal(sourceFor(s, "https://a.com/p/")?.n, 1); // trailing slash and #fragment don't make a new page
  assert.equal(sourceFor(s, "https://evil.com/p"), undefined);
});

test("[n] becomes a link to that page from the search log; numbers the log doesn't have are dropped", () => {
  const { html, cited } = renderAnswer("Launch has no monthly fee [1]. Storage is $0.35 [2, 9]. Made up [7].", sources);
  assert.deepEqual(hrefs(html), ["https://www.neon.com/pricing", "https://docs.neon.tech/x"]);
  assert.deepEqual(cited, [1, 2]);
  assert.doesNotMatch(html, /\[7\]|\[9\]|>7<|>9</);
  assert.match(html, /aria-label="Source 1: neon\.com"/);
});

test("a markdown link to a logged page becomes its number, so long link text is never repeated", () => {
  const text = "Compute is $0.106 [Neon Pricing Plans](https://www.neon.com/pricing). Storage too ([Neon Pricing Plans](https://www.neon.com/pricing)).";
  const { html, cited } = renderAnswer(text, sources);
  assert.doesNotMatch(html, /Neon Pricing Plans/);
  assert.equal(hrefs(html).length, 2);
  assert.deepEqual(cited, [1]);
});

test("links and URLs that are not in the search log are not linked", () => {
  const { html, cited } = renderAnswer("See [the deal](https://scam.example/buy) or https://scam.example/raw or [x](javascript:alert(1)).", sources);
  assert.deepEqual(hrefs(html), []);
  assert.deepEqual(cited, []);
  assert.match(html, /See the deal or https:\/\/scam\.example\/raw/);
});

test("a bare URL from the log becomes its citation", () => {
  const { html, cited } = renderAnswer("Docs: https://docs.neon.tech/x.", sources);
  assert.deepEqual(hrefs(html), ["https://docs.neon.tech/x"]);
  assert.deepEqual(cited, [2]);
});

test("a [SiteName] with no URL links when it names a source, and is dropped when it names none", () => {
  const a = renderAnswer("Per the tracker [SubscriptionGauge].", sources);
  assert.deepEqual(hrefs(a.html), ["https://subscriptiongauge.com/neon"]);
  const b = renderAnswer("Per a blog [PricingBlog].", sources);
  assert.equal(b.html, "Per a blog.");
  // Without any sources a bracketed word is just text, and a stray [1] links nowhere.
  assert.equal(renderAnswer("Reply [yes] or [1].", []).html, "Reply [yes] or.");
});

test("everything is escaped, code is left alone, and verdict badges still work", () => {
  const { html } = renderAnswer('<img src=x onerror=alert(1)> `list[1]` **Storage**: UNCHANGED [1]', sources);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<code>list\[1\]<\/code>/);
  assert.match(html, /<b>Storage<\/b>: <span class="badge b-same">Unchanged<\/span>/);
  assert.equal(hrefs(html).length, 1);
});
