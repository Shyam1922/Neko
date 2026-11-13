const $ = (id) => document.getElementById(id);
const log = $("log");
const form = $("form");
const input = $("input");
const send = $("send");
const main = $("main");
const historyEl = $("history");
const chipsEl = $("chips");
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
    .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, "$1<em>$2</em>");
}

// ---- landing vs conversation -------------------------------------------------------------

function greeting() {
  const h = new Date().getHours();
  const hello = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  const name = profile.find((f) => f.key === "name")?.value; // only if the user told us their name
  return name ? `${hello}, ${name}` : hello;
}
const updateGreeting = () => ($("greeting").textContent = greeting());

const setEmpty = (empty) => main.classList.toggle("empty", empty);

function renderChips() {
  const prompts = ["What's the gold price today?", "Compare Notion and Obsidian pricing for a 10-person team"];
  if (conversations.length) prompts.push("Did we ever talk about pricing?");
  chipsEl.textContent = "";
  for (const p of prompts) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = p;
    b.addEventListener("click", () => submit(p));
    chipsEl.appendChild(b);
  }
}

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
  renderChips();
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

function addMessage(role, text, at) {
  const d = at ? new Date(at) : new Date();
  const day = dayLabel(d);
  if (day !== lastDay) {
    const div = document.createElement("div");
    div.className = "day";
    div.textContent = day;
    log.appendChild(div);
    lastDay = day;
  }
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = render(text);
  const time = document.createElement("time");
  time.textContent = timeLabel(d);
  wrap.append(bubble, time);
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
  for (const m of conv.messages) addMessage(m.role, m.text, m.at);
  setEmpty(conv.messages.length === 0);
  setHash(id);
  renderHistory();
  document.body.classList.remove("nav-open");
  log.scrollTop = log.scrollHeight;
}

async function submit(text) {
  if (send.disabled) return;
  setEmpty(false);
  addMessage("user", text);
  const bubble = addMessage("assistant", "Thinking…");
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
    showRemembered(bubble.parentElement, remembered);
  } catch (err) {
    bubble.parentElement.className = "msg error";
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
$("open-profile").addEventListener("click", openProfile);
$("profile-close").addEventListener("click", () => dialog.close());
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
  renderChips();
  updateGreeting();
  const id = window.location.hash.slice(1);
  if (id) await openConversation(id);
  loadHistory();
  loadProfile();
})();
