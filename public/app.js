const $ = (id) => document.getElementById(id);
const log = $("log");
const form = $("form");
const input = $("input");
const send = $("send");
const main = $("main");
const historyEl = $("history");
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

let conversationId; // the open chat; also kept in the URL hash so a reload reopens it
let lastDay = null;
let conversations = []; // summaries for the sidebar, newest first
let profile = []; // facts the user has told us about themselves

const dayLabel = (d) => d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const timeLabel = (d) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

// Tiny safe markdown: everything is escaped first, then only links, `code`, **bold**, *italic*, bullets and ``` blocks are added.
// Only https/http URLs become links, so a model can't produce javascript: links.
function render(text) {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const link = (url, label) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  return esc
    .replace(/```([\s\S]*?)```/g, (_, c) => `<pre>${c.trim()}</pre>`)
    .replace(/^[*-] /gm, "• ") // bullet lists, before italics so a leading "* " isn't read as one
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => link(url, label))
    .replace(/(^|[\s(])(https?:\/\/[^\s<)&]+[^\s<).,;:&])/g, (_, pre, url) => `${pre}${link(url, url)}`)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, "$1<em>$2</em>")
    // The four verdicts Neko reports are shown as badges, so a then-versus-now answer reads at a glance.
    .replace(/\b(COULD NOT VERIFY|NO BASELINE|UNCHANGED|CHANGED)\b/g, (v) => {
      const [cls, label] = { CHANGED: ["b-changed", "Changed"], UNCHANGED: ["b-same", "Unchanged"], "COULD NOT VERIFY": ["b-unv", "Couldn't verify"], "NO BASELINE": ["b-none", "No baseline"] }[v];
      return `<span class="badge ${cls}">${label}</span>`;
    });
}

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
    const item = document.createElement("button");
    item.type = "button";
    item.className = "item" + (c.id === conversationId ? " active" : "");
    item.title = c.title || "New chat";
    item.textContent = c.title || "New chat"; // textContent: a title can never inject HTML
    item.addEventListener("click", () => openConversation(c.id));
    historyEl.appendChild(item);
  }
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

// Under each answer: how long it took, how many searches it ran, and which sites those searches returned.
// Only http(s) links are ever made; the data comes from our own search log, not from the model's text.
function setMeta(wrap, { ms, searches } = {}) {
  const meta = wrap.querySelector(".meta");
  if (!meta) return;
  meta.textContent = "";
  const ok = (searches || []).filter((s) => !s.error && s.urls?.length);
  const parts = [];
  if (typeof ms === "number") parts.push(`answered in ${formatDuration(ms)}`);
  if (ok.length) parts.push(`${ok.length} search${ok.length === 1 ? "" : "es"}`);
  if (parts.length) {
    const s = document.createElement("span");
    s.textContent = parts.join(" · ");
    meta.append(s);
  }
  const sites = new Map();
  for (const search of ok) {
    for (const u of search.urls) {
      try {
        const url = new URL(u);
        if (!/^https?:$/.test(url.protocol)) continue;
        const host = url.hostname.replace(/^www\./, "");
        if (!sites.has(host)) sites.set(host, url.href);
      } catch {
        /* skip a malformed URL */
      }
    }
  }
  if (sites.size) {
    const label = document.createElement("span");
    label.textContent = "checked:";
    meta.append(label);
    for (const [host, href] of [...sites].slice(0, 6)) {
      const a = document.createElement("a");
      a.className = "src";
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.title = href;
      a.textContent = host;
      meta.append(a);
    }
  }
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
  bubble.innerHTML = render(text);
  if (role === "assistant") {
    const card = document.createElement("div");
    card.className = "card";
    const meta = document.createElement("div");
    meta.className = "meta";
    card.append(bubble, meta);
    wrap.append(lbl, card);
    setMeta(wrap, extra);
  } else {
    wrap.append(lbl, bubble);
  }
  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
  return bubble;
}

function startNewChat() {
  if (send.disabled) return; // don't abandon a reply that is still streaming
  conversationId = undefined;
  resetLog();
  setHash();
  setEmpty(true);
  renderHistory();
  document.body.classList.remove("nav-open");
  input.focus();
}

async function openConversation(id) {
  if (send.disabled) return;
  const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`).catch(() => null);
  if (!res || !res.ok) return startNewChat(); // deleted or bad link: fall back to the landing screen
  const conv = await res.json();
  conversationId = id;
  resetLog();
  for (const m of conv.messages) addMessage(m.role, m.text, m.at, m);
  setEmpty(conv.messages.length === 0);
  setHash(id);
  renderHistory();
  document.body.classList.remove("nav-open");
  log.scrollTop = log.scrollHeight;
}

async function submit(text) {
  if (send.disabled) return;
  setEmpty(false);
  if (!conversationId) $("chat-title").textContent = text.slice(0, 60); // until the sidebar learns the real title
  addMessage("user", text);
  const bubble = addMessage("assistant", "Thinking…");
  const wrap = bubble.closest(".msg");
  let reply = "";
  let remembered = [];
  send.disabled = true;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, text, tz }),
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
        } else if (event === "done") {
          setMeta(wrap, data.assistantMessage || {}); // time measured by the server, searches from its log
        } else if (event === "profile") {
          remembered = data.saved;
        } else if (event === "status") {
          if (!reply) bubble.textContent = data.text;
        } else if (event === "searching") {
          if (!reply) bubble.textContent = `Searching the web: ${data.queries.join(" · ")}`;
        } else if (event === "token") {
          reply += data.text;
          bubble.innerHTML = render(reply);
          log.scrollTop = log.scrollHeight;
        } else if (event === "error") {
          throw new Error(data.message);
        }
      }
    }
    showRemembered(wrap, remembered);
  } catch (err) {
    wrap.classList.add("error");
    bubble.textContent = err.message;
  } finally {
    send.disabled = false;
    input.focus();
    loadHistory(); // the chat now exists (or has a new message): refresh the sidebar
    loadProfile(); // and the router may have learned something about the user
  }
}

// ---- wiring ------------------------------------------------------------------------------

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || send.disabled) return;
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
$("profile-clear").addEventListener("click", async () => {
  if (!confirm("Forget everything I know about you? This can't be undone.")) return;
  await fetch("/api/profile", { method: "DELETE" });
  await loadProfile();
});
$("menu").addEventListener("click", () => document.body.classList.add("nav-open"));
$("scrim").addEventListener("click", () => document.body.classList.remove("nav-open"));

// A reload (or a shared link with #<id>) reopens that chat; otherwise show the landing screen.
(async function boot() {
  applyTheme(themePref()); // marks the right button in the profile panel
  updateGreeting();
  updateProfileButton();
  const id = window.location.hash.slice(1);
  if (id) await openConversation(id);
  loadHistory();
  loadProfile();
})();
