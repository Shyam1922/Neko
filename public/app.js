import { numberSources, renderAnswer } from "./answer.js";

const $ = (id) => document.getElementById(id);
const log = $("log");
const form = $("form");
const input = $("input");
const send = $("send");
const stopBtn = $("stop");
const main = $("main");
const historyEl = $("history");
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

let conversationId; // the open chat; also kept in the URL hash so a reload reopens it
let lastDay = null;
let conversations = []; // summaries for the sidebar, newest first
let profile = []; // facts the user has told us about themselves
let busy = false; // a reply is streaming
let controller = null; // aborts the streaming reply when Stop is pressed

const dayLabel = (d) => d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const timeLabel = (d) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

// Answers are rendered by answer.js: safe markdown, verdict badges, and citations grounded in the search log.
const render = (text, sources = []) => renderAnswer(text, sources).html;

// ---- theme: light, dark, or follow the system ----------------------------------------------
// The choice lives in this browser only (localStorage). index.html applies it before first paint.

const THEME_KEY = "neko-theme";
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

function themePref() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system"; // storage blocked: just follow the system
  }
}

function applyTheme(pref) {
  const dark = pref === "dark" || (pref === "system" && systemDark.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  for (const b of document.querySelectorAll("#theme-seg button")) b.setAttribute("aria-checked", String(b.dataset.themePref === pref));
}

function setTheme(pref) {
  try {
    if (pref === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* the theme still changes for this visit */
  }
  applyTheme(pref);
}

systemDark.addEventListener("change", () => {
  if (themePref() === "system") applyTheme("system"); // follow the OS when it switches
});

// ---- landing vs conversation -------------------------------------------------------------

function greeting() {
  const h = new Date().getHours();
  const hello = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  const name = profile.find((f) => f.key === "name")?.value; // only if the user told us their name
  return name ? `${hello}, ${name}` : hello;
}
const updateGreeting = () => ($("greeting").textContent = greeting());

// The profile button: your initial (or a person icon until Neko knows your name) and how much it remembers.
const PERSON_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/></svg>';
// Top bar title (the open chat) and the memory line on the landing screen.
function updateChrome() {
  $("chat-title").textContent = conversations.find((c) => c.id === conversationId)?.title || "";
  const chats = conversations.length;
  const facts = profile.length;
  $("status-line").textContent =
    chats || facts
      ? `${chats} chat${chats === 1 ? "" : "s"} remembered · ${facts} fact${facts === 1 ? "" : "s"} about you`
      : "A fresh start: nothing remembered yet";
}

function updateProfileButton() {
  updateChrome();
  const name = profile.find((f) => f.key === "name")?.value;
  const initial = name ? [...name.trim()][0] : "";
  if (initial) $("avatar").textContent = initial.toUpperCase();
  else $("avatar").innerHTML = PERSON_ICON; // static markup, no user text
  $("who-name").textContent = name || "Your profile";
  $("who-sub").textContent = profile.length ? `${profile.length} thing${profile.length === 1 ? "" : "s"} remembered` : "Nothing remembered yet";
}

const setEmpty = (empty) => main.classList.toggle("empty", empty);

function resetLog() {
  log.textContent = "";
  lastDay = null;
}

function setHash(id) {
  window.history.replaceState(null, "", id ? `#${id}` : window.location.pathname);
}

// ---- sidebar: chat history ---------------------------------------------------------------

function groupLabel(iso) {
  const d = new Date(iso);
  const now = new Date();
  const yesterday = new Date();
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

function renderHistory() {
  updateChrome();
  historyEl.textContent = "";
  if (!conversations.length) {
    const note = document.createElement("div");
    note.className = "empty-note";
    note.textContent = "Your chats will show up here.";
    historyEl.appendChild(note);
    return;
  }
  let group = null;
  for (const c of conversations) {
    const label = groupLabel(c.lastAt);
    if (label !== group) {
      group = label;
      const g = document.createElement("div");
      g.className = "group";
      g.textContent = label;
      historyEl.appendChild(g);
    }
    historyEl.appendChild(historyRow(c));
  }
}

const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>';

// One chat in the sidebar: open it, rename it in place, or delete it.
function historyRow(c) {
  const row = document.createElement("div");
  row.className = "row" + (c.id === conversationId ? " active" : "");
  const item = document.createElement("button");
  item.type = "button";
  item.className = "item";
  item.title = c.title || "New chat";
  item.textContent = c.title || "New chat"; // textContent: a title can never inject HTML
  item.addEventListener("click", () => openConversation(c.id));

  const tool = (label, icon, onClick) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "row-action";
    b.title = label;
    b.setAttribute("aria-label", `${label}: ${c.title || "New chat"}`);
    b.innerHTML = icon; // a fixed icon, never user text
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  };
  row.append(item, tool("Rename", ICON_EDIT, () => startRename(row, c)), tool("Delete", ICON_TRASH, () => deleteConversation(c)));
  return row;
}

function startRename(row, c) {
  const field = document.createElement("input");
  field.className = "rename";
  field.value = c.title || "";
  field.maxLength = 120;
  field.setAttribute("aria-label", "Chat name");
  row.replaceChildren(field);
  field.focus();
  field.select();
  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    const title = field.value.replace(/\s+/g, " ").trim();
    if (save && title && title !== c.title) {
      const res = await fetch(`/api/conversations/${encodeURIComponent(c.id)}`, { method: "PATCH", body: JSON.stringify({ title }) }).catch(() => null);
      if (res && res.ok) c.title = title;
    }
    renderHistory();
  };
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  field.addEventListener("blur", () => finish(true));
}

async function deleteConversation(c) {
  if (busy && c.id === conversationId) return; // a reply is still streaming into it
  if (!confirm(`Delete "${c.title || "New chat"}"? This removes the chat and its messages for good. Facts it taught Neko about you stay in your profile.`)) return;
  const res = await fetch(`/api/conversations/${encodeURIComponent(c.id)}`, { method: "DELETE" }).catch(() => null);
  if (!res || !(res.ok || res.status === 404)) return;
  conversations = conversations.filter((x) => x.id !== c.id);
  if (c.id === conversationId) startNewChat();
  else renderHistory();
}

async function loadHistory() {
  try {
    const res = await fetch("/api/conversations");
    if (res.ok) conversations = await res.json();
  } catch {
    /* the sidebar is a convenience; chatting still works without it */
  }
  renderHistory();
}

// ---- "What I know about you": visible, editable, deletable ---------------------------------

const dialog = $("profile-dialog");
const labelOf = (key) => key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

async function loadProfile() {
  try {
    const res = await fetch("/api/profile");
    if (res.ok) profile = await res.json();
  } catch {
    /* personalisation is optional; the app works without it */
  }
  updateGreeting();
  updateProfileButton();
  if (dialog.open) renderProfile();
}

function profileError(msg) {
  const el = $("profile-error");
  el.hidden = !msg;
  el.textContent = msg || "";
}

function renderProfile() {
  const list = $("profile-list");
  list.textContent = "";
  profileError("");
  $("profile-clear").hidden = profile.length === 0;
  if (!profile.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "Nothing yet. As we chat, tell me things about yourself, such as \"I prefer short answers\" or \"I'm based in Lisbon\", and I'll remember them here.";
    list.appendChild(p);
    return;
  }
  for (const f of profile) {
    const row = document.createElement("div");
    row.className = "pf-row";
    const key = document.createElement("span");
    key.className = "pf-key";
    key.textContent = labelOf(f.key);
    const input = document.createElement("input");
    input.value = f.value;
    input.maxLength = 120;
    input.setAttribute("aria-label", labelOf(f.key));
    input.addEventListener("change", async () => {
      const res = await fetch(`/api/profile/${encodeURIComponent(f.id)}`, { method: "PUT", body: JSON.stringify({ value: input.value }) });
      if (!res.ok) {
        profileError((await res.json().catch(() => ({}))).error || "Couldn't save that.");
        input.value = f.value; // put the old value back
        return;
      }
      await loadProfile();
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "pf-del";
    del.setAttribute("aria-label", `Forget ${labelOf(f.key)}`);
    del.textContent = "×";
    del.addEventListener("click", async () => {
      await fetch(`/api/profile/${encodeURIComponent(f.id)}`, { method: "DELETE" });
      await loadProfile();
    });
    row.append(key, input, del);
    list.appendChild(row);
  }
}

function openProfile() {
  renderProfile();
  dialog.showModal();
}

// Under a reply: say what was just remembered, so nothing is saved silently.
function showRemembered(wrap, saved) {
  if (!saved.length) return;
  const note = document.createElement("div");
  note.className = "note";
  note.append(`✓ ${saved.some((s) => s.previous) ? "Updated" : "Remembered"}: ${saved.map((s) => `${labelOf(s.key)} = ${s.value}`).join(" · ")}`);
  const fresh = saved.filter((s) => s.previous === undefined); // undoing an update would lose the old value, so only new facts get Undo
  if (fresh.length) {
    const undo = document.createElement("button");
    undo.type = "button";
    undo.textContent = "Undo";
    undo.addEventListener("click", async () => {
      await Promise.all(fresh.map((s) => fetch(`/api/profile/${encodeURIComponent(s.id)}`, { method: "DELETE" })));
      note.textContent = "Forgotten.";
      await loadProfile();
    });
    note.append(undo);
  }
  const manage = document.createElement("button");
  manage.type = "button";
  manage.textContent = "Manage";
  manage.addEventListener("click", openProfile);
  note.append(manage);
  wrap.appendChild(note);
}

// ---- messages ----------------------------------------------------------------------------

// "12.3s", or "1m 05s" for a long one: how long the answer took, shown next to the time.
function formatDuration(ms) {
  const s = ms / 1000;
  if (s < 59.95) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

// Under each answer: how long it took and how many searches ran (for a saved reply), then the sources.
// "Sources" are the pages the answer actually cites; "Also checked" are the rest of what the searches returned.
// Every link comes from our own search log (numberSources), never from the model's text.
function setMeta(wrap, { ms, searches } = {}, cited = [], { timing = true } = {}) {
  const meta = wrap.querySelector(".meta");
  if (!meta) return;
  meta.textContent = "";
  const ok = (searches || []).filter((s) => !s.error && s.urls?.length);
  const parts = [];
  if (timing && typeof ms === "number") parts.push(`answered in ${formatDuration(ms)}`);
  if (timing && ok.length) parts.push(`${ok.length} search${ok.length === 1 ? "" : "es"}`);
  if (parts.length) {
    const s = document.createElement("div");
    s.className = "meta-line";
    s.textContent = parts.join(" · ");
    meta.append(s);
  }
  const sources = numberSources(searches);
  const used = sources.filter((s) => cited.includes(s.n));
  const seenHosts = new Set(used.map((s) => s.host)); // a site already under Sources isn't repeated
  const rest = sources.filter((s) => !cited.includes(s.n) && !seenHosts.has(s.host) && seenHosts.add(s.host)).slice(0, 6);
  const row = (label, list, numbered) => {
    if (!list.length) return;
    const r = document.createElement("div");
    r.className = "src-row";
    const l = document.createElement("span");
    l.className = "src-label";
    l.textContent = label;
    r.append(l);
    for (const s of list) {
      const a = document.createElement("a");
      a.className = "src";
      a.href = s.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.title = s.url;
      if (numbered) {
        const n = document.createElement("span");
        n.className = "src-n";
        n.textContent = String(s.n);
        a.append(n);
      }
      a.append(s.host);
      r.append(a);
    }
    meta.append(r);
  };
  row("Sources", used, true);
  row(used.length ? "Also checked" : "Checked", rest, false);
}

// The step list inside a pending answer: what Neko is doing right now, ticked off as it goes, with a running
// clock. When the answer is done it folds into one line ("4 steps · 1 search · 9.3s") that opens again on click.
function progressView(card) {
  const box = document.createElement("details");
  box.className = "steps";
  box.open = true;
  const summary = document.createElement("summary");
  const title = document.createElement("span");
  title.textContent = "Working on it";
  const clock = document.createElement("span");
  clock.className = "clock";
  clock.setAttribute("aria-hidden", "true"); // a ticking number would be read out every second
  summary.append(title, clock);
  const list = document.createElement("ol");
  box.append(summary, list);
  card.prepend(box);

  const t0 = Date.now();
  const tick = () => (clock.textContent = ` · ${Math.floor((Date.now() - t0) / 1000)}s`);
  tick();
  const timer = setInterval(tick, 1000);
  let current = null;
  let count = 0;
  let searches = 0;
  return {
    start(label, kind) {
      if (current) current.className = "done";
      const li = document.createElement("li");
      li.className = "active";
      const mark = document.createElement("span");
      mark.className = "mark";
      mark.setAttribute("aria-hidden", "true");
      const text = document.createElement("span");
      text.className = "step-label";
      text.textContent = label;
      li.append(mark, text);
      list.append(li);
      current = li;
      count++;
      if (kind === "search") searches++;
    },
    detail(text) {
      if (!current) return;
      let d = current.querySelector(".step-detail");
      if (!d) {
        d = document.createElement("span");
        d.className = "step-detail";
        current.append(d);
      }
      d.textContent = text;
    },
    finish(outcome, ms = Date.now() - t0) {
      clearInterval(timer);
      clock.textContent = "";
      if (current) current.className = outcome === "done" ? "done" : "stopped";
      const n = `${count} step${count === 1 ? "" : "s"}`;
      const q = `${searches} search${searches === 1 ? "" : "es"}`;
      title.textContent =
        outcome === "done" ? `${n} · ${q} · ${formatDuration(ms)}` : outcome === "stopped" ? `Stopped after ${formatDuration(ms)}` : `Didn't finish · ${formatDuration(ms)}`;
      box.open = false;
    },
  };
}

function addMessage(role, text, at, extra) {
  const d = at ? new Date(at) : new Date();
  const day = dayLabel(d);
  if (day !== lastDay) {
    const div = document.createElement("div");
    div.className = "day";
    div.textContent = day;
    log.appendChild(div);
    lastDay = day;
  }
  const wrap = document.createElement("article");
  wrap.className = `msg ${role}`;
  const lbl = document.createElement("div");
  lbl.className = "lbl";
  const who = document.createElement("span");
  who.textContent = role === "user" ? "You" : "Neko";
  const time = document.createElement("time");
  time.textContent = timeLabel(d);
  lbl.append(who, time);
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = render(text, role === "assistant" ? numberSources(extra?.searches) : []);
  if (role === "assistant") {
    const card = document.createElement("div");
    card.className = "card";
    const meta = document.createElement("div");
    meta.className = "meta";
    card.append(bubble, meta);
    wrap.append(lbl, card);
    if (extra) setMeta(wrap, extra, renderAnswer(text, numberSources(extra.searches)).cited);
  } else {
    wrap.append(lbl, bubble);
  }
  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
  return bubble;
}

function startNewChat() {
  if (busy) return; // don't abandon a reply that is still streaming
  conversationId = undefined;
  resetLog();
  setHash();
  setEmpty(true);
  renderHistory();
  setNav(false);
  input.focus();
}

async function openConversation(id) {
  if (busy) return;
  const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`).catch(() => null);
  if (!res || !res.ok) return startNewChat(); // deleted or bad link: fall back to the landing screen
  const conv = await res.json();
  conversationId = id;
  resetLog();
  conv.messages.forEach((m, i) => {
    const bubble = addMessage(m.role, m.text, m.at, m);
    if (m.role === "assistant" && (m.searches || []).some((x) => !x.error && x.urls?.length)) addWatchAction(bubble.closest(".msg"), m.id);
    // A reply that was stopped (or cut off) is not saved, so its question stands alone. Say so.
    if (m.role === "user" && conv.messages[i + 1]?.role !== "assistant") {
      note(bubble.closest(".msg"), "No answer was saved for this question.");
    }
  });
  setEmpty(conv.messages.length === 0);
  setHash(id);
  renderHistory();
  setNav(false);
  log.scrollTop = log.scrollHeight;
}

const note = (wrap, text) => {
  const p = document.createElement("div");
  p.className = "note";
  p.textContent = text;
  wrap.appendChild(p);
};

function setBusy(on) {
  busy = on;
  send.hidden = on; // Stop takes Send's place while a reply streams
  stopBtn.hidden = !on;
}

async function submit(text) {
  if (busy) return;
  setEmpty(false);
  if (!conversationId) $("chat-title").textContent = text.slice(0, 60); // until the sidebar learns the real title
  addMessage("user", text);
  const bubble = addMessage("assistant", "");
  const wrap = bubble.closest(".msg");
  const steps = progressView(wrap.querySelector(".card"));
  const searches = []; // this turn's search log, as the server reports it: what citations are numbered from
  let reply = "";
  let cited = [];
  let remembered = [];
  let outcome = "error";
  let serverMs;
  controller = new AbortController();
  setBusy(true);
  const showSources = () => setMeta(wrap, { searches }, cited, { timing: false });
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, text, tz }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "null");
        if (event === "meta") {
          conversationId = data.conversationId;
          setHash(conversationId);
        } else if (event === "step") {
          steps.start(data.label, data.kind);
        } else if (event === "search_done") {
          searches.push(data.log);
          const hosts = [...new Set((data.log.urls || []).map((u) => numberSources([{ urls: [u] }])[0]?.host).filter(Boolean))];
          steps.detail(data.log.error ? "Search failed" : `Found ${data.log.urls.length} source${data.log.urls.length === 1 ? "" : "s"}${hosts.length ? `: ${hosts.slice(0, 3).join(", ")}${hosts.length > 3 ? ` +${hosts.length - 3}` : ""}` : ""}`);
          showSources(); // the sources show up before the answer is written
        } else if (event === "done") {
          serverMs = data.assistantMessage?.ms;
          outcome = "done";
          const m = data.assistantMessage;
          if (m && (m.searches || []).some((x) => !x.error && x.urls?.length)) addWatchAction(wrap, m.id);
        } else if (event === "profile") {
          remembered = data.saved;
        } else if (event === "token") {
          reply += data.text;
          const out = renderAnswer(reply, numberSources(searches));
          bubble.innerHTML = out.html;
          if (out.cited.join() !== cited.join()) {
            cited = out.cited;
            showSources(); // a newly cited page moves from "Checked" to "Sources"
          }
          log.scrollTop = log.scrollHeight;
        } else if (event === "error") {
          throw new Error(data.message);
        }
      }
    }
    if (outcome !== "done") throw new Error("The connection closed before the answer finished.");
    showRemembered(wrap, remembered);
  } catch (err) {
    if (controller.signal.aborted) {
      outcome = "stopped";
      note(wrap, reply ? "Stopped. This partial answer wasn't saved." : "Stopped before an answer. Nothing was saved.");
    } else {
      wrap.classList.add("error");
      bubble.textContent = err.message;
    }
  } finally {
    steps.finish(outcome, outcome === "done" ? serverMs : undefined);
    controller = null;
    setBusy(false);
    input.focus();
    loadHistory(); // the chat now exists (or has a new message): refresh the sidebar
    loadProfile(); // and the router may have learned something about the user
  }
}


// ---- "Watch this": re-check an answer's facts every week, and say only when something changed -------------

let me = { memoryOn: true, email: null, emailNotify: false, emailAvailable: false, maxWatches: 10 };
let watches = [];
const watchDialog = $("watch-dialog");
let openWatchId = null;

const shortDate = (iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const httpUrl = (u) => {
  try {
    const url = new URL(u);
    return /^https?:$/.test(url.protocol) ? url : null;
  } catch {
    return null;
  }
};
const VERDICT = { changed: ["b-changed", "Changed"], unchanged: ["b-same", "Unchanged"], couldnt_verify: ["b-unv", "Couldn't verify"], no_baseline: ["b-none", "No baseline"] };
const badge = (verdict) => {
  const [cls, label] = VERDICT[verdict] ?? VERDICT.couldnt_verify;
  const b = document.createElement("span");
  b.className = `badge ${cls}`;
  b.textContent = label;
  return b;
};
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

async function loadMe() {
  try {
    const res = await fetch("/api/me");
    if (res.ok) me = await res.json();
  } catch {
    /* defaults: memory on, no email */
  }
  renderSettings();
}

async function loadWatches() {
  try {
    const res = await fetch("/api/watches");
    if (res.ok) watches = await res.json();
  } catch {
    /* the list is a convenience */
  }
  renderWatches();
  for (const b of document.querySelectorAll(".watch-btn")) syncWatchButton(b);
}

// The "Watching" section at the top of the sidebar; changed watches first, with a badge.
function renderWatches() {
  const list = $("watch-list");
  list.textContent = "";
  $("watch-section").hidden = watches.length === 0;
  const unseen = watches.filter((w) => w.unseenChange).length;
  $("watch-label").textContent = unseen ? `Watching · ${unseen} changed` : "Watching";
  $("menu-dot").hidden = unseen === 0;
  $("menu").setAttribute("aria-label", unseen ? `Show chats and watches, ${unseen} changed` : "Show chat history");
  for (const w of watches) {
    const b = el("button", "item watch-item");
    b.type = "button";
    b.title = w.title;
    const t = el("span", "watch-name", w.title);
    b.append(t);
    if (w.unseenChange) b.append(badge("changed"));
    else if (w.status === "paused") b.append(el("span", "chip", "Paused"));
    b.addEventListener("click", () => openWatch(w.id));
    const row = el("div", "row");
    row.append(b);
    list.append(row);
  }
}

// Under a researched answer: "Watch this", or "Watching" once it is.
function addWatchAction(wrap, messageId) {
  if (!messageId || !conversationId || wrap.querySelector(".watch-btn")) return;
  const bar = el("div", "watch-bar");
  const b = el("button", "watch-btn");
  b.type = "button";
  b.dataset.messageId = messageId;
  bar.append(b);
  wrap.querySelector(".card").append(bar);
  syncWatchButton(b);
  b.addEventListener("click", () => {
    const w = watches.find((x) => x.messageId === messageId);
    if (w) return openWatch(w.id);
    startWatch(b, bar, messageId);
  });
}

function syncWatchButton(b) {
  const w = watches.find((x) => x.messageId === b.dataset.messageId);
  b.textContent = w ? (w.unseenChange ? "Watching · changed" : "Watching") : "Watch this";
  b.setAttribute("aria-pressed", String(Boolean(w)));
  b.title = w ? "See what is watched and the last check" : "Re-check these facts every week and tell me if they change";
}

async function startWatch(b, bar, messageId) {
  b.disabled = true;
  b.textContent = "Reading the answer…";
  bar.querySelector(".watch-msg")?.remove();
  const res = await fetch("/api/watches", { method: "POST", body: JSON.stringify({ conversationId, messageId }) }).catch(() => null);
  const data = res ? await res.json().catch(() => ({})) : {};
  b.disabled = false;
  if (!res || !res.ok) {
    syncWatchButton(b);
    bar.append(el("p", "watch-msg err", data.error || "Couldn't start watching. Please try again."));
    return;
  }
  await loadWatches();
  const msg = el("p", "watch-msg", `I'll re-check ${data.claims.length === 1 ? "this fact" : `these ${data.claims.length} facts`} every week and show you here if anything changes.`);
  bar.append(msg);
  if (me.emailAvailable && !me.email) bar.append(emailOffer());
  else if (me.email && me.emailNotify) msg.append(` I'll also email ${me.email}.`);
}

// Email is offered at the moment it's useful, never demanded: a magic link, no password.
function emailOffer() {
  const f = el("form", "email-offer");
  const label = el("label", "", "Email me when it changes");
  const id = `email-${Math.random().toString(36).slice(2, 8)}`;
  label.htmlFor = id;
  const input = el("input");
  input.type = "email";
  input.id = id;
  input.required = true;
  input.autocomplete = "email";
  input.placeholder = "you@example.com";
  const go = el("button", "", "Send link");
  go.type = "submit";
  const out = el("p", "hint");
  out.setAttribute("role", "status");
  const row = el("div", "email-row");
  row.append(input, go);
  f.append(label, row, out);
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    go.disabled = true;
    const res = await fetch("/api/email/start", { method: "POST", body: JSON.stringify({ email: input.value }) }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    go.disabled = false;
    if (res && res.ok) {
      row.remove();
      out.textContent = `Check your inbox at ${input.value}, and open the link in this browser. It works for 30 minutes.`;
    } else {
      out.textContent = data.error || "Couldn't send the email. Please try again.";
    }
  });
  return f;
}

// The watch panel: what is watched, the last check (then vs now, with the source), pause and delete.
async function openWatch(id) {
  const res = await fetch(`/api/watches/${encodeURIComponent(id)}`).catch(() => null);
  if (!res || !res.ok) return;
  const w = await res.json();
  openWatchId = id;
  renderWatchDialog(w);
  if (!watchDialog.open) watchDialog.showModal();
  setNav(false);
  if (w.unseenChange) {
    await fetch(`/api/watches/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ seen: true }) }).catch(() => null);
    loadWatches();
  }
}

function renderWatchDialog(w) {
  $("watch-title").textContent = w.title;
  const body = $("watch-body");
  body.textContent = "";
  const when = w.status === "paused" ? "Paused. Resume to re-check it again." : `Re-checked every ${w.everyDays === 7 ? "week" : `${w.everyDays} days`}. Next check ${shortDate(w.nextCheckAt)}.`;
  body.append(el("p", "hint", when));

  const last = w.checks?.[0];
  body.append(el("p", "dlg-sec", last ? `Last check · ${shortDate(last.checkedAt)}` : "Last check"));
  if (!last) {
    body.append(el("p", "hint", "Not checked yet."));
  } else if (last.outcome === "error") {
    body.append(el("p", "hint", "That check didn't finish (the model or search was busy). It will try again tomorrow."));
  } else {
    const changed = last.items.filter((i) => i.verdict === "changed").length;
    const same = last.items.filter((i) => i.verdict === "unchanged").length;
    body.append(el("p", "check-sum", changed ? `${changed} of ${last.items.length} changed.` : same === last.items.length ? "Nothing changed." : `Nothing changed that I could confirm (${same} of ${last.items.length} checked).`));
    const list = el("ul", "check-list");
    const order = { changed: 0, unchanged: 1, couldnt_verify: 2, no_baseline: 3 };
    for (const item of [...last.items].sort((a, b) => (order[a.verdict] ?? 9) - (order[b.verdict] ?? 9))) {
      const li = el("li");
      const head = el("div", "check-head");
      head.append(el("span", "check-name", `${item.entity}, ${item.attribute}`), badge(item.verdict));
      li.append(head);
      const then = el("div", "check-line");
      then.append(el("span", "check-k", "Then"), el("span", "", item.baseline ? `${item.baseline.valueText} (${shortDate(item.baseline.assertedAt)})` : "–"));
      const now = el("div", "check-line");
      now.append(el("span", "check-k", "Now"), el("span", "", item.current?.valueText ?? "Not found in today's sources"));
      li.append(then, now);
      const src = item.current?.url && httpUrl(item.current.url);
      if (src) {
        const line = el("div", "check-line");
        const a = el("a", "src", src.hostname.replace(/^www\./, ""));
        a.href = src.href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.title = src.href;
        line.append(el("span", "check-k", "Source"), a);
        li.append(line);
      }
      if (item.reason && item.verdict !== "changed") li.append(el("p", "hint", item.reason));
      list.append(li);
    }
    body.append(list);
  }

  body.append(el("p", "dlg-sec", "What's watched"));
  const facts = el("ul", "check-list");
  for (const c of w.claims) facts.append(el("li", "", `${c.entity}, ${c.attribute}: ${c.valueText} (as of ${shortDate(c.assertedAt)})`));
  body.append(facts);
  $("watch-pause").textContent = w.status === "paused" ? "Resume" : "Pause";
  $("watch-chat").hidden = !w.conversationId;
  $("watch-chat").dataset.conv = w.conversationId || "";
}

// Your profile: the memory switch and, when the server can send email, the address.
function renderSettings() {
  const sw = $("memory-switch");
  sw.setAttribute("aria-checked", String(me.memoryOn !== false));
  $("memory-state").textContent = me.memoryOn !== false ? "On" : "Off";
  const sec = $("email-section");
  sec.hidden = !me.emailAvailable;
  $("email-none").hidden = Boolean(me.email);
  $("email-set").hidden = !me.email;
  $("email-addr").textContent = me.email || "";
  $("email-notify").checked = Boolean(me.emailNotify);
}

async function saveMe(patch) {
  const res = await fetch("/api/me", { method: "PUT", body: JSON.stringify(patch) }).catch(() => null);
  if (res && res.ok) me = await res.json();
  renderSettings();
}

// ---- wiring ------------------------------------------------------------------------------

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || busy) return;
  input.value = "";
  input.style.height = "auto";
  submit(text);
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
});
$("new-chat").addEventListener("click", startNewChat);
stopBtn.addEventListener("click", () => controller?.abort());
for (const b of document.querySelectorAll("#theme-seg button")) b.addEventListener("click", () => setTheme(b.dataset.themePref));
$("open-profile").addEventListener("click", openProfile);
$("profile-close").addEventListener("click", () => dialog.close());

// "What does Neko do for you?": a plain list of what it can do, from the landing screen or the "?" in the top bar.
const about = $("about-dialog");
for (const id of ["open-about", "open-about-top"]) $(id).addEventListener("click", () => about.showModal());
$("about-close").addEventListener("click", () => about.close());
about.addEventListener("click", (e) => {
  if (e.target === about) about.close();
});
dialog.addEventListener("click", (e) => {
  if (e.target === dialog) dialog.close(); // a click on the dimmed backdrop closes it
});
$("watch-close").addEventListener("click", () => watchDialog.close());
watchDialog.addEventListener("click", (e) => {
  if (e.target === watchDialog) watchDialog.close();
});
$("watch-pause").addEventListener("click", async () => {
  const w = watches.find((x) => x.id === openWatchId);
  const status = w?.status === "paused" ? "active" : "paused";
  const res = await fetch(`/api/watches/${encodeURIComponent(openWatchId)}`, { method: "PATCH", body: JSON.stringify({ status }) }).catch(() => null);
  if (res && res.ok) renderWatchDialog(await res.json());
  loadWatches();
});
$("watch-delete").addEventListener("click", async () => {
  if (!confirm("Stop watching this and delete its check history?")) return;
  await fetch(`/api/watches/${encodeURIComponent(openWatchId)}`, { method: "DELETE" }).catch(() => null);
  watchDialog.close();
  loadWatches();
});
$("watch-chat").addEventListener("click", () => {
  watchDialog.close();
  openConversation($("watch-chat").dataset.conv);
});
$("memory-switch").addEventListener("click", () => saveMe({ memoryOn: $("memory-switch").getAttribute("aria-checked") !== "true" }));
$("email-notify").addEventListener("change", () => saveMe({ emailNotify: $("email-notify").checked }));
$("email-remove").addEventListener("click", async () => {
  if (!confirm("Remove your email from Neko? Change emails stop, and you can't sign in with it on another device.")) return;
  await fetch("/api/email", { method: "DELETE" }).catch(() => null);
  loadMe();
});
$("profile-email-start").addEventListener("click", () => {
  const holder = $("email-none");
  if (!holder.querySelector(".email-offer")) holder.append(emailOffer());
  holder.querySelector("input")?.focus();
});
$("profile-clear").addEventListener("click", async () => {
  if (!confirm("Forget everything I know about you, including your email address? This can't be undone.")) return;
  await fetch("/api/profile", { method: "DELETE" });
  await loadProfile();
  loadMe(); // the email goes too
});
// Starter prompts on the landing screen: one click sends a fixed, known prompt (never page-supplied text).
for (const b of document.querySelectorAll(".starter")) b.addEventListener("click", () => submit(b.dataset.prompt));

// Phone drawer: the menu button reports its state, and Escape or a tap on the scrim closes it.
const setNav = (open) => {
  document.body.classList.toggle("nav-open", open);
  $("menu").setAttribute("aria-expanded", String(open));
  if (open) $("new-chat").focus();
};
$("menu").addEventListener("click", () => setNav(true));
$("scrim").addEventListener("click", () => setNav(false));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("nav-open")) {
    setNav(false);
    $("menu").focus();
  }
});

// A reload (or a shared link with #<id>) reopens that chat; otherwise show the landing screen.
(async function boot() {
  applyTheme(themePref()); // marks the right button in the profile panel
  updateGreeting();
  updateProfileButton();
  const hash = window.location.hash.slice(1);
  loadMe();
  await loadWatches();
  if (hash.startsWith("watch-")) {
    setHash(); // a link from a change email: open that watch on the landing screen
    openWatch(hash.slice(6));
  } else if (hash) await openConversation(hash);
  loadHistory();
  loadProfile();
})();
