// How an answer is shown, and how its citations are grounded. Shared by the page (app.js), the server
// (it numbers search results for the model with the same function) and the unit tests.
//
// Citations are done by code, not by the model. Every URL that this turn's searches returned is numbered
// once, in the order the searches ran (`numberSources`). The model sees those numbers and cites [n]. Code
// then turns each [n] into a link to that URL from Neko's own search log, and drops any [n], markdown link
// or bare URL that the log can't back. So every link under an answer is a page Neko actually fetched.

/** @typedef {{ query?: string, urls?: string[], error?: string, retrievedAt?: string }} SearchLogLike */
/** @typedef {{ n: number, url: string, host: string }} Source */

/** @type {Record<string, [string, string]>} */
const LABELS = { CHANGED: ["b-changed", "Changed"], UNCHANGED: ["b-same", "Unchanged"], "COULD NOT VERIFY": ["b-unv", "Couldn't verify"], "NO BASELINE": ["b-none", "No baseline"] };

/** @param {string} raw */
function parseUrl(raw) {
  try {
    const url = new URL(raw);
    return /^https?:$/.test(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

/** The same page however it is written: no #fragment, no trailing slash, host in lower case. @param {string} raw */
function keyOf(raw) {
  const url = parseUrl(raw);
  if (!url) return null;
  url.hash = "";
  return url.href.replace(/\/$/, "");
}

/**
 * Number every URL this turn's searches returned, in order, each once. Failed searches add nothing.
 * @param {SearchLogLike[] | undefined} searches
 * @returns {Source[]}
 */
export function numberSources(searches) {
  /** @type {Source[]} */
  const out = [];
  const seen = new Set();
  for (const s of searches || []) {
    if (!s || s.error) continue;
    for (const raw of s.urls || []) {
      const key = keyOf(raw);
      const url = parseUrl(raw);
      if (!key || !url || seen.has(key)) continue;
      seen.add(key);
      out.push({ n: out.length + 1, url: url.href, host: url.hostname.replace(/^www\./, "") });
    }
  }
  return out;
}

/**
 * The numbered source for a URL, or undefined when the URL is not in this turn's search log.
 * @param {Source[]} sources
 * @param {string} raw
 */
export function sourceFor(sources, raw) {
  const key = keyOf(raw);
  return key ? sources.find((s) => keyOf(s.url) === key) : undefined;
}

/** @param {string} s */
const escHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** @param {string} s */
const unescHtml = (s) => s.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
/** @param {string} s */
const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Render a reply as safe HTML, with grounded citations.
 * Everything is escaped first; then only bullets, ``` blocks, `code`, **bold**, *italic*, verdict badges and
 * citation links are added. Links only ever point at URLs from `sources`.
 * @param {string} text
 * @param {Source[]} [sources]
 * @returns {{ html: string, cited: number[] }}
 */
export function renderAnswer(text, sources = []) {
  /** @type {Set<number>} */
  const cited = new Set();
  /** @param {Source} s */
  const chip = (s) => {
    cited.add(s.n);
    const host = escHtml(s.host);
    return `<a class="cite" href="${escHtml(s.url)}" target="_blank" rel="noopener noreferrer" title="${host}" aria-label="Source ${s.n}: ${host}">${s.n}</a>`;
  };
  /** @param {string} n */
  const byNumber = (n) => sources.find((s) => s.n === Number(n));
  /** @param {string} label */
  const byName = (label) => {
    const want = squash(label);
    if (want.length < 3) return undefined;
    return sources.find((s) => squash(s.host).startsWith(want) || want === squash(s.host.replace(/\.[a-z.]+$/, "")));
  };

  // Code is set aside first, so nothing below (citations, badges, bold) rewrites what is inside it.
  /** @type {string[]} */
  const code = [];
  /** @param {string} html */
  const stash = (html) => `\u0000${code.push(html) - 1}\u0000`;

  const html = escHtml(text)
    .replace(/```([\s\S]*?)```/g, (_, c) => stash(`<pre>${c.trim()}</pre>`))
    .replace(/`([^`\n]+)`/g, (_, c) => stash(`<code>${c}</code>`))
    .replace(/^[*-] /gm, "• ") // bullet lists, before italics so a leading "* " isn't read as one
    // A markdown link to a page from the log becomes its numbered citation (no repeated link text); a link to
    // anything else keeps its words but loses the link. "([label](url))" loses the brackets too.
    .replace(/[ \t]*\(\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)\)|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, l1, u1, l2, u2) => {
      const s = sourceFor(sources, unescHtml(u1 ?? u2));
      if (s) return chip(s);
      return u1 ? ` (${l1})` : l2;
    })
    // A bare URL: a citation when it is in the log, plain text otherwise.
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+?)(?=&quot;|&gt;|[.,;:!?]*(?:\s|$|\)))/gm, (m, pre, u) => {
      const s = sourceFor(sources, unescHtml(u));
      return s ? `${pre.trim() ? pre : ""}${chip(s)}` : m;
    })
    // [1], [2, 3], [1][4]: a link per number the log has; numbers it doesn't have are dropped.
    .replace(/[ \t]*\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g, (_, nums) =>
      String(nums)
        .split(",")
        .map((n) => byNumber(n.trim()))
        .filter((s) => s !== undefined)
        .map((s) => chip(s))
        .join(""),
    )
    // A one-word "[SiteName]" with no URL: a citation if it names a source, otherwise dropped (only when there
    // are sources; without any, a bracketed word is just text).
    .replace(/[ \t]*\[([A-Za-z][\w.'-]{1,40})\](?!\()/g, (m, label) => {
      if (!sources.length) return m;
      const s = byName(label);
      return s ? chip(s) : "";
    })
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, "$1<em>$2</em>")
    // The four verdicts Neko reports are shown as badges, so a then-versus-now answer reads at a glance.
    .replace(/\b(COULD NOT VERIFY|NO BASELINE|UNCHANGED|CHANGED)\b/g, (v) => {
      const [cls, label] = LABELS[v];
      return `<span class="badge ${cls}">${label}</span>`;
    })
    .replace(/\u0000(\d+)\u0000/g, (_, i) => code[Number(i)]);
  return { html, cited: [...cited].sort((a, b) => a - b) };
}
