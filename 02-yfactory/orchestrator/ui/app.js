"use strict";
// yfactory UI: repositories and their sessions (runs) on the left, a prompt and the conversation in the middle.
// Everything that comes from a VM, the agent or the provider (names, file content, transcript, prompts, errors) is put
// on the page with textContent / DOM APIs only. There is no innerHTML in this file.
const $ = (s, r = document) => r.querySelector(s);
const SVGNS = "http://www.w3.org/2000/svg";

// Icons come from the sprite in index.html; names are fixed strings, never data.
function icon(name, cls = "") {
  const s = document.createElementNS(SVGNS, "svg");
  s.setAttribute("class", `i ${cls}`.trim());
  const u = document.createElementNS(SVGNS, "use");
  u.setAttribute("href", `#i-${name}`);
  s.append(u);
  return s;
}

// h("div", { class: "x", onclick: fn, text: "t" }, child, "text", [children]) builds DOM; strings become text nodes.
function h(tag, props, ...kids) {
  const n = document.createElement(tag);
  const late = {};
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "value" || k === "checked" || k === "disabled" || k === "selected") late[k] = v;
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  for (const [k, v] of Object.entries(late)) n[k] = v;
  return n;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const safeUrl = (u) => (/^https?:\/\//.test(String(u ?? "")) ? String(u) : null);
const p2 = (n) => String(n).padStart(2, "0");
const fmtDate = (t) => { const d = new Date(t); return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${p2(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${p2(Math.floor((s % 3600) / 60))}m`;
}
const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 45 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const clip = (s, n) => { s = String(s ?? ""); return s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters not shown)` : s; };

const api = async (method, url, body) => {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
};
const getJson = (url) => api("GET", url);

let toastTimer = 0;
function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = bad ? "bad" : "";
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 2800);
}

const parseEnv = (text) => {
  const env = {};
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.indexOf("=");
    if (i < 1) throw new Error(`not KEY=value: ${line.slice(0, 40)}`);
    env[line.slice(0, i)] = line.slice(i + 1);
  }
  return env;
};
const fmtEnv = (e) => Object.entries(e ?? {}).map(([k, v]) => `${k}=${v}`).join("\n");

// ---------------------------------------------------------------- state

const state = { cfg: { repos: [], providers: [], models: [], environments: [] }, config: null, runs: [], connected: true };
let route = { name: "home" };
let view = null; // { el, update(), destroy() }

async function loadCfg() {
  const d = await getJson("/api/repos");
  state.cfg = { repos: d.repos, providers: d.providers, models: d.models, environments: d.environments };
  try { state.config = await getJson("/api/config"); } catch { state.config = null; }
}
const repoOf = (name) => state.cfg.repos.find((r) => r.repo === name);
const runsOf = (repo) => state.runs.filter((r) => r.repo === repo);
const findRun = (id) => state.runs.find((r) => r.id === id);
const isActive = (r) => r.status === "queued" || r.status === "running";
const allowedModels = (repo) => (repo?.models?.length ? state.cfg.models.filter((m) => repo.models.includes(m)) : state.cfg.models);

function runTitle(r) {
  if (r.kind === "inspect") return "Inspect environment";
  if (r.kind === "verify") return "Verify setup";
  const first = String(r.prompt ?? "").split("\n").find((l) => l.trim());
  return first ? first.trim().slice(0, 140) : "VM only";
}

const STATUS = {
  queued: { label: "queued", hint: "waiting for a free slot" },
  running: { label: "running", hint: "the VM is being set up or the agent is working" },
  ready: { label: "ready", hint: "the VM is up and kept for you: terminal, files, VS Code, publish" },
  done: { label: "done", hint: "finished" },
  failed: { label: "failed", hint: "failed" },
};
const chip = (r) => h("span", { class: `chip s-${r.status}`, title: STATUS[r.status]?.hint ?? "" }, h("i", { class: "dot" }), STATUS[r.status]?.label ?? r.status);

// ---------------------------------------------------------------- routing

function parseRoute() {
  const p = decodeURIComponent(location.hash.slice(1) || "/");
  let m;
  if ((m = /^\/r\/([\w.-]+\/[\w.-]+)\/s\/(\w+)$/.exec(p))) return { name: "session", repo: m[1], id: m[2] };
  if ((m = /^\/r\/([\w.-]+\/[\w.-]+)\/settings$/.exec(p))) return { name: "settings", repo: m[1] };
  if ((m = /^\/r\/([\w.-]+\/[\w.-]+)$/.exec(p))) return { name: "repo", repo: m[1] };
  if (p === "/new-repo") return { name: "settings", repo: null };
  if (p === "/environments") return { name: "environments" };
  if (p === "/sessions") return { name: "sessions" };
  if (p === "/review") return { name: "review" };
  return { name: "home" };
}

function mount(next) {
  view?.destroy?.();
  view = next;
  $("#view").replaceChildren(next.el);
  $("#main").scrollTop = 0;
}

async function navigate() {
  route = parseRoute();
  document.body.classList.remove("nav-open");
  let next;
  if (route.name === "session") next = sessionView(route.repo, route.id);
  else if (route.name === "settings") next = settingsView(route.repo);
  else if (route.name === "repo") next = repoView(route.repo);
  else if (route.name === "environments") next = environmentsView();
  else if (route.name === "sessions") next = listView("Sessions", "Every session of every repository, newest first.", () => true);
  else if (route.name === "review") next = listView("Review", "Pull request reviews. The findings wait here as a draft until you publish them.", (r) => r.kind === "review");
  else next = homeView();
  mount(next);
  renderSide();
}

// ---------------------------------------------------------------- sidebar

// A row of "Recent": the title, below it when and what came of it (a pull request, findings), a status dot on the right.
function recentRow(r) {
  const n = r.review?.findings, pr = safeUrl(r.pr);
  const result = r.review?.published ? "published" : n ? plural(n, "finding") : pr ? "1 open" : null;
  return h("a", { class: `rec${route.id === r.id ? " on" : ""}`, href: `#/r/${r.repo}/s/${r.id}`, title: `${runTitle(r)}\n${r.repo}` },
    h("div", { class: "tx" },
      h("div", { class: "t", text: runTitle(r) }),
      h("div", { class: "m" }, h("span", { text: ago(r.startedAt ?? r.createdAt) }), result ? h("span", { class: "go" }, icon("pr"), result) : null)),
    h("i", { class: `dot s-${r.status}`, title: `${STATUS[r.status]?.label ?? r.status}: ${STATUS[r.status]?.hint ?? ""}` }));
}

function renderSide() {
  const list = $("#repo-list");
  const rows = state.runs.slice(0, 16).map(recentRow);
  list.replaceChildren(...(rows.length ? rows : [h("div", { class: "none pad", text: "No sessions yet" })]));
  $("#sys-run").textContent = String(state.runs.filter((r) => r.status === "running").length);
  $("#sys-q").textContent = String(state.runs.filter((r) => r.status === "queued").length);
  $("#live").classList.toggle("off", !state.connected);
  for (const a of document.querySelectorAll("[data-nav]")) a.classList.toggle("on", a.dataset.nav === route.name);
}

// The sidebar can be hidden; the choice is remembered.
const LS = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private window: the choice is just not kept */ } },
};
const setSide = (hidden) => { document.body.classList.toggle("side-hidden", hidden); LS.set("yf.side", hidden ? "hidden" : ""); };
setSide(LS.get("yf.side") === "hidden");
$("#side-toggle").addEventListener("click", () => setSide(true));
$("#menu-btn").addEventListener("click", () => (innerWidth > 860 ? setSide(!document.body.classList.contains("side-hidden")) : document.body.classList.toggle("nav-open")));
$("#scrim").addEventListener("click", () => document.body.classList.remove("nav-open"));

// ---------------------------------------------------------------- shared pieces

function sessionItem(r, showRepo) {
  const at = r.startedAt ?? r.createdAt;
  const dur = r.status === "queued" ? null : (r.finishedAt ?? Date.now()) - (r.startedAt ?? r.createdAt);
  const pr = safeUrl(r.pr);
  const findings = r.review?.findings;
  return h("a", { class: "sess", href: `#/r/${r.repo}/s/${r.id}` },
    h("i", { class: `dot s-${r.status}`, title: `${STATUS[r.status]?.label ?? r.status}: ${STATUS[r.status]?.hint ?? ""}` }),
    h("div", { class: "body" },
      h("div", { class: "ttl" }, runTitle(r), findings ? h("span", { class: "count", title: "findings in the draft", text: String(findings) }) : null),
      h("div", { class: "meta" },
        showRepo ? h("span", { class: "repo-tag", text: r.repo }) : null,
        h("span", { class: "st", text: STATUS[r.status]?.label ?? r.status }),
        r.model ? h("span", {}, icon("cpu"), r.model) : null,
        h("span", {}, icon("branch"), r.kind === "review" && r.target ? `#${r.target.id}` : r.base),
        r.kind ? h("span", { class: `tag ${r.kind}`, text: r.kind }) : null,
        r.keep && !r.kind ? h("span", { class: "tag", title: "the VM is kept after the run" }, icon("box"), "keep") : null,
        pr ? h("span", { class: "pr" }, icon("pr"), "PR") : null,
        r.review?.published ? h("span", { class: "pr" }, icon("pr"), "published") : null,
        r.error ? h("span", { class: "err", text: r.error }) : null)),
    h("div", { class: "when", title: fmtDate(at) }, h("div", { text: ago(at) }), dur != null ? h("div", { text: fmtDur(dur) }) : null));
}

function emptyBox(title, text, ...extra) {
  return h("div", { class: "empty-box" }, h("b", { text: title }), text ? h("p", { text }) : null, ...extra);
}

// ---------------------------------------------------------------- home: what do you want to get done?

// 42, #42, a pull request or a merge request URL.
function prNumber(text) {
  const t = text.trim();
  const m = /(?:pulls?|merge_requests)\/(\d{1,9})(?:\D|$)/.exec(t) || /^#?(\d{1,9})$/.exec(t);
  return m ? m[1] : null;
}

// A VM without an agent, kept for the terminal, files and VS Code.
async function startVm(repo, extra = {}) {
  const r = await api("POST", "/api/runs", { repo, prompt: "", keep: true, ...extra });
  state.runs.unshift(r);
  location.hash = `#/r/${repo}/s/${r.id}`;
}

function homeView() {
  const el = h("div", { class: "page home" });
  let repoName = repoOf(LS.get("yf.repo") ?? "")?.repo ?? state.cfg.repos[0]?.repo ?? null;
  let mode = "agent"; // or "review": the text is then a pull request number or URL

  if (!state.cfg.repos.length) {
    el.append(h("h1", { class: "hero-title", text: "What do you want to get done?" }),
      emptyBox("No repositories yet", "Add a repository to start a session.", h("a", { class: "btn primary", href: "#/new-repo" }, icon("plus"), "Add repository")));
    return { el, update() {} };
  }

  const text = h("textarea", { id: "composer-text", rows: "3", spellcheck: "false" });
  const msg = h("span", { class: "msg" });
  const base = h("input", { name: "base", placeholder: "default branch" });
  const keep = h("input", { type: "checkbox", name: "keep" });
  const modelSel = h("select", { name: "model", title: "model of this session" });
  const submit = h("button", { class: "primary send", type: "submit", title: "Start (Ctrl+Enter)", "aria-label": "Start" }, icon("arrowup"));

  // ---- repository menu, with a search like the repository selector of Devin
  const repoBtn = h("button", { type: "button", class: "chipbtn", "aria-haspopup": "listbox" });
  const search = h("input", { type: "search", placeholder: "Search for a repository", "aria-label": "Search for a repository" });
  const menu = h("div", { class: "menu", hidden: true, role: "listbox" });
  const wrap = h("div", { class: "menu-wrap" }, repoBtn, menu);
  function renderMenu() {
    const q = search.value.trim().toLowerCase();
    const items = state.cfg.repos.filter((r) => !q || r.repo.toLowerCase().includes(q));
    menu.replaceChildren(
      h("div", { class: "menu-search" }, icon("search"), search),
      h("div", { class: "menu-list" }, items.length ? items.map((r) => h("button", { type: "button", class: `menu-item${r.repo === repoName ? " on" : ""}`, role: "option", onclick: () => { pick(r.repo); closeMenu(); } },
        h("span", { class: "chk" }, r.repo === repoName ? icon("ok") : null), h("span", { class: "nm", text: r.repo }), h("small", { text: r.provider }))) : [h("div", { class: "none pad", text: "No repository matches" })]),
      h("div", { class: "menu-foot" }, h("span", { text: plural(state.cfg.repos.length, "repository").replace("repositorys", "repositories") }),
        repoName ? h("a", { href: `#/r/${repoName}/settings` }, "Settings") : null, h("a", { href: "#/new-repo" }, icon("plus"), "Add")));
  }
  const openMenu = () => { menu.hidden = false; search.value = ""; renderMenu(); search.focus(); };
  const closeMenu = () => { menu.hidden = true; };
  repoBtn.addEventListener("click", () => (menu.hidden ? openMenu() : closeMenu()));
  search.addEventListener("input", renderMenu);
  const onDoc = (e) => { if (!menu.hidden && !wrap.contains(e.target)) closeMenu(); };
  const onKey = (e) => { if (e.key === "Escape") closeMenu(); };
  document.addEventListener("mousedown", onDoc);
  document.addEventListener("keydown", onKey);

  function pick(name) {
    repoName = name;
    LS.set("yf.repo", name);
    const repo = repoOf(name), models = allowedModels(repo);
    repoBtn.replaceChildren(icon("branch"), h("span", { text: name }), icon("chev", "down"));
    modelSel.replaceChildren(...(repo.model && models.includes(repo.model) ? [] : [h("option", { value: "", text: "Default model" })]), ...models.map((m) => h("option", { value: m, text: m })));
    modelSel.value = repo.model && models.includes(repo.model) ? repo.model : "";
    base.placeholder = repo.base || "default branch";
  }
  pick(repoName);

  // ---- mode: an agent run with a prompt, or a review of a pull request
  const modeBtn = h("button", { type: "button", class: "chipbtn", title: "Agent: change the code. Review: read a pull request and report findings." });
  function setMode(m) {
    mode = m;
    modeBtn.replaceChildren(icon(m === "agent" ? "cpu" : "pr"), h("span", { text: m === "agent" ? "Agent" : "Review" }));
    text.placeholder = m === "agent" ? "Ask the agent to build features, fix bugs, or work on your code…" : "Pull request number or URL, e.g. 42 or https://github.com/owner/repo/pull/42";
    text.rows = m === "agent" ? 3 : 1;
    adv.hidden = m !== "agent" || !advOpen;
    advLink.hidden = m !== "agent";
    vmBtn.hidden = m !== "agent";
    msg.textContent = "";
  }
  modeBtn.addEventListener("click", () => setMode(mode === "agent" ? "review" : "agent"));

  const vmBtn = h("button", { type: "button", class: "chipbtn", title: "Start a VM without the agent: terminal, files and VS Code; it is kept until you delete it",
    onclick: async (e) => {
      e.currentTarget.disabled = true; msg.textContent = "";
      try { await startVm(repoName, { model: modelSel.value, base: base.value.trim() }); } catch (err) { msg.textContent = err.message; }
      e.currentTarget.disabled = false;
    } }, icon("terminal"), h("span", { text: "VM only" }));
  let advOpen = false;
  const adv = h("div", { class: "advanced", hidden: true },
    h("label", {}, "Base branch", base),
    h("label", { class: "check" }, keep, "Keep the VM after the run ", h("small", { text: "(terminal, files, VS Code)" })));
  const advLink = h("button", { type: "button", class: "linkbtn", onclick: () => { advOpen = !advOpen; adv.hidden = !advOpen; advLink.firstChild.textContent = advOpen ? "Advanced ↓" : "Advanced →"; } }, h("span", { text: "Advanced →" }));

  const form = h("form", { class: "composer big", onsubmit: async (e) => {
    e.preventDefault();
    submit.disabled = true; msg.textContent = "";
    try {
      let r;
      if (mode === "review") {
        const pr = prNumber(text.value);
        if (!pr) throw new Error("Enter the number of a pull request, or its URL.");
        r = await api("POST", "/api/runs", { repo: repoName, pr, model: modelSel.value });
      } else {
        const prompt = text.value.trim();
        if (!prompt) throw new Error("Write what the agent should do, or start a VM only.");
        r = await api("POST", "/api/runs", { repo: repoName, prompt, model: modelSel.value, base: base.value.trim(), keep: keep.checked });
      }
      text.value = "";
      state.runs.unshift(r);
      location.hash = `#/r/${repoName}/s/${r.id}`;
    } catch (err) { msg.textContent = err.message; }
    submit.disabled = false;
  } },
    text,
    h("div", { class: "composer-bar" }, wrap, h("label", { class: "pill" }, icon("cpu"), modelSel), modeBtn, vmBtn, msg, h("span", { class: "grow" }), h("kbd", { text: "Ctrl+Enter" }), submit));
  text.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) form.requestSubmit(); });
  setMode("agent");

  el.append(h("h1", { class: "hero-title", text: "What do you want to get done?" }), form, h("div", { class: "below" }, advLink), adv);
  queueMicrotask(() => text.focus());
  return { el, update() {}, destroy() { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); } };
}

// ---------------------------------------------------------------- lists of sessions: all of them, reviews

function listView(title, lead, pick) {
  const el = h("div", { class: "page" });
  const filter = h("input", { type: "search", placeholder: "Filter sessions", class: "filter" });
  const list = h("div", { class: "sess-list" });
  const count = h("span", { class: "msg" });
  filter.addEventListener("input", () => update());
  el.append(h("div", { class: "page-head" }, h("div", {}, h("h1", { text: title }), h("p", { class: "lead", text: lead }))), h("div", { class: "list-head" }, count, filter), list);
  function update() {
    const q = filter.value.trim().toLowerCase();
    const all = state.runs.filter(pick);
    const shown = all.filter((r) => !q || `${r.id} ${r.repo} ${runTitle(r)} ${r.status} ${r.model ?? ""}`.toLowerCase().includes(q));
    count.textContent = shown.length === all.length ? plural(all.length, "session") : `${shown.length} of ${all.length}`;
    list.replaceChildren(...(shown.length ? shown.map((r) => sessionItem(r, true)) : [emptyBox(all.length ? "No session matches" : "Nothing here yet", all.length ? "" : "Start one from the Sessions page.")]));
  }
  update();
  return { el, update };
}

// ---------------------------------------------------------------- repository: its sessions and settings

function repoView(name) {
  const repo = repoOf(name);
  const el = h("div", { class: "page" });
  if (!repo) { el.append(emptyBox("Repository not found", `${name} is not configured.`, h("a", { class: "btn", href: "#/" }, "Back"))); return { el, update() {} }; }
  const models = allowedModels(repo);
  const newHere = () => { LS.set("yf.repo", repo.repo); location.hash = "#/"; };
  const filter = h("input", { type: "search", placeholder: "Filter sessions", class: "filter" });
  const list = h("div", { class: "sess-list" });
  const count = h("span", { class: "msg" });
  filter.addEventListener("input", () => update());
  el.append(
    h("div", { class: "page-head" },
      h("div", {}, h("h1", { text: repo.repo }),
        h("div", { class: "subline" }, h("span", {}, icon("server"), repo.environment), h("span", {}, icon("branch"), repo.base || "default branch"), h("span", {}, icon("db"), repo.provider),
          models.length ? h("span", {}, icon("cpu"), repo.model || plural(models.length, "model")) : null,
          h("span", {}, icon("pr"), repo.reviewPublish === "auto" ? "reviews publish at once" : "reviews wait as a draft"))),
      h("div", { class: "head-actions" }, h("button", { type: "button", class: "btn primary", onclick: newHere }, icon("plus"), "New session"),
        h("button", { type: "button", class: "btn", title: "A VM without the agent: terminal, files and VS Code", onclick: async (e) => {
          e.currentTarget.disabled = true;
          try { await startVm(repo.repo); } catch (err) { toast(err.message, true); e.currentTarget.disabled = false; }
        } }, icon("terminal"), "Start VM"),
        h("a", { class: "btn", href: `#/r/${repo.repo}/settings` }, icon("sliders"), "Settings"))),
    h("div", { class: "list-head" }, count, filter), list);
  function update() {
    const q = filter.value.trim().toLowerCase();
    const all = runsOf(repo.repo);
    const shown = all.filter((r) => !q || `${r.id} ${runTitle(r)} ${r.status} ${r.model ?? ""}`.toLowerCase().includes(q));
    count.textContent = shown.length === all.length ? plural(all.length, "session") : `${shown.length} of ${all.length}`;
    list.replaceChildren(...(shown.length ? shown.map((r) => sessionItem(r, false)) : [emptyBox(all.length ? "No session matches" : "No sessions yet", all.length ? "" : "Start the first one with New session.")]));
  }
  update();
  return { el, update };
}

// ---------------------------------------------------------------- session

function sessionView(repoName, id) {
  const el = h("div", { class: "page s-page" });
  // Wide: the conversation stays on the left and the tools (review, terminal, files…) are on the right, each scrolls on its own,
  // like the session page of Devin. Narrow: one column and Conversation is a tab again.
  const wide = matchMedia("(min-width: 1100px)");
  let run = findRun(id);
  let tab = null, convRaw = "", convN = 0, convStatus = "", lastProposalKey = "", destroyed = false, headKey = "";
  const openTools = new Set();
  const runUrl = (suffix) => `/api/runs/${encodeURIComponent(id)}/${suffix}`;

  const head = h("div", { class: "s-head" });
  const tabs = h("div", { class: "tabs" });
  const conv = h("div", { class: "pane conv" });
  const term = h("div", { class: "pane term-pane", hidden: true });
  const files = h("div", { class: "pane", hidden: true });
  const log = h("div", { class: "pane", hidden: true });
  const proposal = h("div", { class: "pane", hidden: true });
  const reviewPane = h("div", { class: "pane review", hidden: true });
  const requestsPane = h("div", { class: "pane review", hidden: true });
  const panes = { conv, term, files, log, proposal, review: reviewPane, requests: requestsPane };
  const left = h("div", { class: "s-left" }, conv);
  const right = h("div", { class: "s-right" }, tabs, term, files, log, proposal, reviewPane, requestsPane);
  el.append(head, h("div", { class: "s-split" }, left, right));
  const scroller = () => (wide.matches ? left : $("#main"));

  // ---- header and actions
  async function openIde() {
    // Opened before the await, otherwise the browser blocks it as a popup. No opener: the IDE serves pages from the VM.
    const w = window.open("about:blank");
    if (w) w.opener = null;
    try {
      const d = await api("POST", runUrl("ide"), {});
      const url = `${location.protocol}//${location.hostname}:${d.port}${d.path}`;
      if (w) w.location = url; else location.assign(url);
    } catch (err) { w?.close(); toast(err.message, true); }
  }
  const act = (label, ic, cls, fn, confirmMsg) => h("button", { class: `btn ${cls}`, type: "button", onclick: async (e) => {
    if (confirmMsg && !confirm(confirmMsg)) return;
    e.currentTarget.disabled = true;
    try { await fn(); await tick(); } catch (err) { toast(err.message, true); }
    renderHead(true);
  } }, icon(ic), label);

  function renderHead(force) {
    if (!run) return;
    const key = JSON.stringify([run.status, run.vm, run.pr, run.error, run.finishedAt, run.kind, run.proposal ? 1 : 0, run.model, run.review?.published?.url, run.requests, !!run.actions]);
    if (!force && key === headKey) { $(".dur", head) && ($(".dur", head).textContent = durText()); return; }
    headKey = key;
    const pr = safeUrl(run.pr);
    const actions = [
      run.vm && run.status === "ready" ? act("VS Code", "code", "", openIde) : null,
      run.status === "ready" && !run.kind ? act("Publish", "upload", "primary", () => api("POST", runUrl("publish"), {}).then(() => toast("Branch pushed, pull request opened.")),
        "Push the branch to the provider and open a pull request?") : null,
      // A revise run of the same PR: the agent addresses the review threads and pushes to the PR branch.
      run.kind === "review" && run.target && !isActive(run) ? act("Address comments", "wrench", "", async () => {
        const r = await api("POST", "/api/runs", { repo: run.repo, pr: run.target.id, kind: "revise", model: run.model ?? undefined });
        state.runs.push(r);
        location.hash = `#/r/${r.repo}/s/${r.id}`;
      }, `Start a revise session for #${run.target.id}? The agent changes the code for the unresolved review threads and its commits are pushed to ${run.target.headRef}.`) : null,
      isActive(run) ? act("Cancel", "stop", "danger", () => api("POST", runUrl("cancel"), {}), "Cancel this session? The VM is removed.") : null,
      run.vm && run.status !== "running" ? act("Delete VM", "trash", "ghost danger-text", () => api("POST", runUrl("destroy"), {}), "Export the sessions and remove the VM?") : null,
    ];
    head.replaceChildren(...[
      h("a", { class: "back", href: `#/r/${run.repo}` }, icon("chev", "flip"), run.repo),
      h("div", { class: "s-title" }, chip(run), h("h1", { text: runTitle(run) })),
      h("div", { class: "subline" },
        (run.kind === "review" || run.kind === "revise") && run.target
          ? h("span", { title: "pull request" }, icon("branch"), `#${run.target.id} ${run.target.headRef} → ${run.target.baseRef}`)
          : h("span", { title: "branch" }, icon("branch"), `${run.branch} ← ${run.base}`),
        h("span", { title: "environment" }, icon("server"), run.environment ?? ""),
        run.model ? h("span", { title: "model" }, icon("cpu"), run.model) : null,
        h("span", { title: fmtDate(run.startedAt ?? run.createdAt) }, icon("clock"), ago(run.startedAt ?? run.createdAt)),
        h("span", {}, icon("timer"), h("span", { class: "dur", text: durText() })),
        pr ? h("a", { href: pr, target: "_blank", rel: "noopener" }, icon("pr"), "Pull request") : null,
        run.kind === "review" || (run.kind === "revise" && !pr) ? safeUrl(run.target?.url) && h("a", { href: safeUrl(run.target.url), target: "_blank", rel: "noopener" }, icon("pr"), "Pull request") : null,
        run.kind === "review" && safeUrl(run.review?.published?.url) ? h("a", { href: safeUrl(run.review.published.url), target: "_blank", rel: "noopener" }, icon("link"), "Published review") : null,
        h("span", { class: "idc", title: "click to copy the id", onclick: (e) => { navigator.clipboard?.writeText(run.id).then(() => { e.target.textContent = "copied"; setTimeout(() => { e.target.textContent = run.id; }, 900); }, () => {}); }, text: run.id })),
      run.error ? h("div", { class: "banner bad", text: run.error }) : null,
      h("div", { class: "s-actions" }, actions)].filter(Boolean));
    renderTabs();
  }
  const durText = () => fmtDur(run.status === "queued" ? Date.now() - run.createdAt : (run.finishedAt ?? Date.now()) - (run.startedAt ?? run.createdAt));

  function renderTabs() {
    // Terminal and Files only exist while the VM does; a finished session keeps its conversation, log and proposal.
    if (!run.vm && (tab === "term" || tab === "files")) { if (ws || xterm) closeTerm(); showTab("conv"); return; }
    const review = run.kind === "review";
    const defs = [...(review ? [["review", "pr", "Review"]] : []), ["conv", "msg", "Conversation"], ["term", "terminal", "Terminal"], ["files", "folder", "Files"], ["log", "log", "Setup log"]]
      .filter(([k]) => run.vm || (k !== "term" && k !== "files")).filter(([k]) => !(review && k === "log")).filter(([k]) => !(wide.matches && k === "conv"));
    if (run.proposal || run.kind === "inspect") defs.push(["proposal", "bulb", "Proposal"]);
    if (run.actions || run.requests || run.kind === "revise") defs.push(["requests", "list", run.requests ? `Requests (${run.requests})` : "Requests"]);
    tabs.replaceChildren(...defs.map(([k, ic, label]) => h("button", { type: "button", class: `tab${tab === k ? " on" : ""}`, onclick: () => showTab(k) }, icon(ic), label)));
  }

  // What the right side shows first when the conversation has the left side to itself.
  const defaultTool = () => (run.kind === "review" ? "review" : run.kind === "revise" || run.requests ? "requests" : run.vm && run.status === "ready" && !run.prompt ? "term" : run.proposal || run.kind === "inspect" ? "proposal" : run.vm ? "term" : "log");
  function showTab(k) {
    if (wide.matches && k === "conv") k = defaultTool();
    tab = k;
    for (const [name, p] of Object.entries(panes)) p.hidden = name === "conv" ? !(wide.matches || k === "conv") : name !== k;
    renderTabs();
    if (k === "term") startTerm();
    if (k === "files") startFiles();
    if (k === "log") loadLog();
    if (k === "proposal") renderProposal(true);
    if (k === "review") loadReview(true);
    if (k === "requests") loadRequests(true);
    if (k === "conv" || wide.matches) loadTranscript(true);
  }
  wide.addEventListener("change", () => { if (run) showTab(tab); });

  // ---- conversation
  async function loadTranscript(force) {
    if (!run || destroyed) return;
    let raw = "", n = convN;
    try {
      const r = await fetch(runUrl(`transcript?n=${n}`));
      raw = r.ok ? await r.text() : "";
    } catch { return; }
    if (!force && raw === convRaw && run.status === convStatus) return;
    convRaw = raw; convStatus = run.status;
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
    const main = scroller();
    const atBottom = main.scrollTop + main.clientHeight >= main.scrollHeight - 100;
    conv.replaceChildren(...renderConversation(data));
    if (atBottom) main.scrollTop = main.scrollHeight;
  }

  function renderConversation(data) {
    const out = [];
    const sessions = run.sessions?.length ?? 0;
    if (sessions > 1) {
      out.push(h("div", { class: "sess-switch" }, "Session ", Array.from({ length: sessions }, (_, i) =>
        h("button", { type: "button", class: `btn sm${i === convN ? " primary" : ""}`, onclick: () => { convN = i; loadTranscript(true); }, text: String(i + 1) }))));
    }
    if (!data || !Array.isArray(data.messages)) {
      const waiting = isActive(run);
      out.push(emptyBox(waiting ? (run.status === "queued" ? "Waiting for a free slot" : "Setting up the VM") : run.prompt || run.kind ? "No conversation recorded" : "Terminal-only VM",
        waiting ? "The conversation appears here as soon as the agent starts working." : run.prompt || run.kind ? "The agent did not leave a session (the run may have failed before it started)." : "This session has no agent. Use the Terminal, Files or VS Code.",
        waiting ? h("span", { class: "spinner" }, icon("spin", "spin")) : null));
      return out;
    }
    const info = data.info ?? {};
    out.push(h("div", { class: "conv-info" },
      h("b", { text: info.title || "Conversation" }),
      info.model?.id ? h("span", {}, icon("cpu"), info.model.id) : null,
      info.tokens ? h("span", { title: "input / output tokens" }, `${info.tokens.input ?? 0} in · ${info.tokens.output ?? 0} out`) : null));
    for (const m of data.messages) {
      const role = m.info?.role === "user" ? "user" : "asst";
      const parts = Array.isArray(m.parts) ? m.parts : [];
      // The steps of one message (tool calls, thinking) are folded into one block, the words stay out of it.
      const steps = [], words = [];
      for (const p of parts) {
        if (p.type === "text" && String(p.text ?? "").trim()) words.push(h("div", { class: "txt", text: String(p.text) }));
        else if (p.type === "reasoning" && String(p.text ?? "").trim()) steps.push(detailsBlock(`r:${p.id}`, h("span", {}, icon("bulb"), "Thinking"), h("pre", { text: clip(p.text, 20000) }), "reasoning"));
        else if (p.type === "tool") steps.push(toolBlock(p));
      }
      const last = m === data.messages[data.messages.length - 1];
      const blocks = [...(steps.length ? [stepsBlock(`g:${m.info?.id ?? out.length}`, steps, last && isActive(run))] : []), ...words];
      if (blocks.length) out.push(h("div", { class: `msg-row ${role}` }, h("div", { class: "bubble" }, blocks)));
    }
    if (isActive(run)) out.push(h("div", { class: "working" }, icon("spin", "spin"), run.status === "queued" ? "Waiting for a slot…" : "Working…"));
    return out;
  }

  function detailsBlock(key, summary, body, cls) {
    const d = h("details", { class: cls }, h("summary", {}, summary), body);
    if (openTools.has(key)) d.open = true;
    d.addEventListener("toggle", () => { if (d.open) openTools.add(key); else openTools.delete(key); });
    return d;
  }

  // Open while the agent is still working on it, closed afterwards; a choice of the reader wins.
  function stepsBlock(key, steps, openByDefault) {
    const d = h("details", { class: "steps" }, h("summary", {}, icon("chev", "chev"), plural(steps.length, "step")), h("div", { class: "steps-list" }, steps));
    d.open = openTools.has(key) ? true : openTools.has(`!${key}`) ? false : openByDefault;
    d.addEventListener("toggle", () => { if (d.open) { openTools.add(key); openTools.delete(`!${key}`); } else { openTools.delete(key); openTools.add(`!${key}`); } });
    return d;
  }
  function toolBlock(p) {
    const s = p.state ?? {};
    const input = s.input === undefined ? "" : typeof s.input === "string" ? s.input : JSON.stringify(s.input, null, 2);
    const output = s.output === undefined ? "" : typeof s.output === "string" ? s.output : JSON.stringify(s.output, null, 2);
    const title = s.title || (s.input && typeof s.input === "object" ? clip(Object.values(s.input).find((v) => typeof v === "string") ?? "", 90).split("\n")[0] : "");
    return detailsBlock(`t:${p.id}`,
      h("span", {}, icon("wrench"), h("b", { text: String(p.tool ?? "tool") }), title ? h("span", { class: "tt", text: title }) : null, h("span", { class: `tstat ${s.status ?? ""}`, text: String(s.status ?? "") })),
      h("div", {}, input ? h("div", { class: "io-l", text: "Input" }) : null, input ? h("pre", { text: clip(input, 8000) }) : null, output ? h("div", { class: "io-l", text: "Output" }) : null, output ? h("pre", { text: clip(output, 20000) }) : null), "tool");
  }

  // ---- terminal (xterm.js over the existing WebSocket; its size is fixed when it opens)
  let xterm = null, fitAddon = null, ws = null;
  const termState = h("span", { class: "msg" });
  const termBox = h("div", { class: "term" });
  term.append(h("div", { class: "pane-bar" }, termState, h("button", { class: "btn sm", type: "button", onclick: () => connectTerm() }, icon("refresh"), "Reconnect")), termBox);
  function closeTerm() {
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    if (xterm) { xterm.dispose(); xterm = null; fitAddon = null; }
    termBox.replaceChildren();
  }
  // A moment after the pane is shown: measured while it is still laid out as hidden, the size came out as 80x24.
  function startTerm() { if (!ws) setTimeout(() => { if (!ws && tab === "term") connectTerm(); }, 60); }
  function connectTerm() {
    closeTerm();
    if (!run?.vm) { termState.textContent = "This session has no VM."; return; }
    if (typeof Terminal === "undefined" || typeof FitAddon === "undefined") { termState.textContent = "terminal library failed to load"; return; }
    xterm = new Terminal({ cursorBlink: true, fontSize: 13, scrollback: 5000,
      fontFamily: 'ui-monospace, "JetBrains Mono", "Fira Code", Menlo, "DejaVu Sans Mono", monospace',
      theme: { background: "#0b0d10", foreground: "#d6dde6", cursor: "#7aa2ff", selectionBackground: "#5b8cff44" } });
    fitAddon = new FitAddon.FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(termBox);
    fitAddon.fit(); // the size is fixed at connect time, so measure before connecting
    const { rows, cols } = xterm;
    const sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${runUrl(`terminal?rows=${rows}&cols=${cols}`)}`);
    ws = sock;
    sock.binaryType = "arraybuffer";
    const enc = new TextEncoder();
    termState.textContent = `connecting (${cols}x${rows})…`;
    sock.onopen = () => { termState.textContent = `connected (${cols}x${rows})`; xterm.focus(); };
    sock.onmessage = (ev) => { if (ev.data instanceof ArrayBuffer) xterm.write(new Uint8Array(ev.data)); else xterm.write(String(ev.data)); };
    sock.onerror = () => { termState.textContent = "connection error"; };
    sock.onclose = (ev) => { if (ws === sock) termState.textContent = `closed (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ""}). Press Reconnect.`; };
    xterm.onData((d) => { if (sock.readyState === WebSocket.OPEN) sock.send(enc.encode(d)); });
    xterm.onBinary((d) => { if (sock.readyState === WebSocket.OPEN) sock.send(Uint8Array.from(d, (c) => c.charCodeAt(0))); });
  }

  // ---- files: lazy tree and a read-only viewer
  const tree = h("ul", { class: "tree" });
  const filesMsg = h("span", { class: "msg" });
  const fileHead = h("div", { class: "file-head" }, h("i", { text: "Select a file" }));
  const fileNote = h("div", { class: "note", hidden: true });
  const fileBody = h("pre", { class: "file-body" });
  files.append(h("div", { class: "pane-bar" }, filesMsg, h("button", { class: "btn sm", type: "button", onclick: () => { tree.replaceChildren(); resetViewer(); loadRoot(); } }, icon("refresh"), "Refresh")),
    h("div", { class: "files" }, tree, h("div", { class: "viewer" }, fileHead, fileNote, fileBody)));
  function resetViewer() { fileHead.replaceChildren(h("i", { text: "Select a file" })); fileNote.hidden = true; fileBody.textContent = ""; }
  function startFiles() { if (!tree.children.length) loadRoot(); }
  async function loadDir(ul, dir) {
    const d = await getJson(runUrl(`files?path=${encodeURIComponent(dir)}`));
    ul.replaceChildren();
    if (!d.entries.length) ul.append(h("li", { class: "empty", text: "empty" }));
    for (const e of d.entries) {
      const full = `${dir === "/" ? "" : dir}/${e.name}`;
      const row = h("div", { class: `node ${e.type}`, "data-path": full, "data-type": e.type },
        h("span", { class: "ico", text: e.type === "dir" ? "▸" : e.type === "link" ? "↪" : "·" }), h("span", { class: "name", text: e.name }),
        e.type === "file" && typeof e.size === "number" ? h("small", { text: fmtSize(e.size) }) : null);
      ul.append(h("li", {}, row));
    }
  }
  async function loadRoot() {
    if (!run?.vm) { filesMsg.textContent = "This session has no VM."; return; }
    filesMsg.textContent = "loading…";
    try { await loadDir(tree, "/workspace"); filesMsg.textContent = "/workspace"; } catch (err) { filesMsg.textContent = err.message; }
  }
  tree.addEventListener("click", async (e) => {
    const row = e.target.closest(".node");
    if (!row) return;
    if (row.dataset.type === "dir") {
      const li = row.parentElement, open = li.querySelector(":scope > ul");
      if (open) { open.remove(); row.querySelector(".ico").textContent = "▸"; return; }
      const ul = h("ul", { class: "tree" }, h("li", { class: "empty", text: "loading…" }));
      li.append(ul);
      row.querySelector(".ico").textContent = "▾";
      try { await loadDir(ul, row.dataset.path); } catch (err) { ul.replaceChildren(h("li", { class: "empty", text: err.message })); }
    } else if (row.dataset.type === "file") {
      for (const n of tree.querySelectorAll(".node.sel")) n.classList.remove("sel");
      row.classList.add("sel");
      openFile(row.dataset.path);
    }
  });
  let fileSeq = 0;
  async function openFile(p) {
    const seq = ++fileSeq;
    fileHead.replaceChildren(h("code", { text: p }));
    fileNote.hidden = true;
    fileBody.textContent = "loading…";
    try {
      const r = await fetch(runUrl(`file?path=${encodeURIComponent(p)}`));
      if (seq !== fileSeq) return;
      if (r.status === 415) { fileBody.textContent = ""; fileNote.textContent = "Binary file, not shown."; fileNote.hidden = false; return; }
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const text = await r.text();
      if (seq !== fileSeq) return;
      fileBody.textContent = text;
      if (r.headers.get("X-Truncated") === "1") { fileNote.textContent = "Truncated: only the first 512 KB are shown."; fileNote.hidden = false; }
    } catch (err) { if (seq === fileSeq) { fileBody.textContent = ""; fileNote.textContent = err.message; fileNote.hidden = false; } }
  }

  // ---- setup log
  const logMsg = h("span", { class: "msg" });
  const logBody = h("pre", { class: "log" });
  log.append(h("div", { class: "pane-bar" }, logMsg, h("button", { class: "btn sm", type: "button", onclick: () => loadLog() }, icon("refresh"), "Refresh")), logBody);
  async function loadLog() {
    logMsg.textContent = "loading";
    try { const r = await fetch(runUrl("log")); logBody.textContent = (await r.text()) || "No setup output."; logMsg.textContent = ""; } catch (err) { logMsg.textContent = err.message; }
  }

  // ---- proposal of an inspect run: current and proposed settings side by side
  const proposalMsg = h("span", { class: "msg", text: "Written by an agent that read the repository: check every script before applying it." });
  const proposalBox = h("div", { class: "proposal" });
  proposal.append(h("div", { class: "pane-bar" }, proposalMsg), proposalBox);
  function renderProposal(force) {
    const key = JSON.stringify([run?.proposal, run?.applied, run?.status]);
    if (!force && key === lastProposalKey) return;
    lastProposalKey = key;
    proposalBox.replaceChildren();
    const p = run?.proposal;
    if (!p) { proposalBox.append(h("p", { class: "empty", text: run?.kind === "inspect" ? (run.status === "failed" ? `No proposal: ${run.error}` : "Not ready yet.") : "This session has no proposal." })); return; }
    proposalBox.append(h("pre", { class: "summary", text: p.summary }));
    if (p.allowlist?.length) proposalBox.append(h("p", { text: `The proxy would also have to allow: ${p.allowlist.join(", ")} (config/proxy/allowlist.txt, by hand).` }));
    const repo = repoOf(run.repo), env = state.cfg.environments.find((e) => e.name === repo?.environment);
    const view = (o) => JSON.stringify(o, null, 1).replace(/\\n/g, "\n");
    const merged = (cur, pr) => pr && { ...pr, env: { ...cur?.env, ...pr.env } }; // apply merges env: the proposal adds or changes, never drops
    const part = (name, title, current, proposed) => {
      if (!proposed) return;
      const applied = run.applied?.includes(name);
      const btn = h("button", { class: "btn sm primary", type: "button", disabled: !!applied, text: applied ? "Applied" : "Apply" });
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          const d = await api("POST", runUrl("apply"), { part: name });
          proposalMsg.textContent = d.verify ? `applied, verify run ${d.verify} started` : `applied, verify run not started: ${d.error}`;
          btn.textContent = "Applied";
          await loadCfg(); await tick();
        } catch (err) { btn.disabled = false; proposalMsg.textContent = err.message; }
      });
      proposalBox.append(h("h3", {}, title, btn), h("div", { class: "cmp" },
        [["current", current], ["proposed", proposed]].map(([label, o]) => h("div", {}, h("div", { class: "file-head", text: label }), h("pre", { text: view(o) })))));
    };
    part("repository", `Repository ${run.repo}`, repo && { setup: repo.setup, env: repo.env }, merged(repo, p.repository));
    part("environment", `Environment ${env?.name ?? "?"} (used by ${state.cfg.repos.filter((r) => r.environment === env?.name).map((r) => r.repo).join(", ")})`,
      env && { setup: env.setup, maintenance: env.maintenance, env: env.env }, merged(env, p.environment));
  }

  // ---- review of a pull request: the draft of the findings
  let reviewKey = "", reviewBusy = false;
  const SEVERITIES = ["blocker", "major", "minor", "nit", "praise"];
  async function loadReview(force) {
    if (!run || destroyed || reviewBusy) return;
    let d;
    try { d = await getJson(runUrl("review")); } catch (err) { reviewPane.replaceChildren(h("p", { class: "empty", text: err.message })); return; }
    const key = JSON.stringify(d);
    if (!force && key === reviewKey) return;
    reviewKey = key;
    renderReview(d);
  }
  async function reviewCall(method, suffix, body) {
    reviewBusy = true;
    try { return await api(method, runUrl(suffix), body); } finally { reviewBusy = false; }
  }
  function renderReview(d) {
    const rv = d.review, published = rv.published, live = d.status === "running" || d.status === "queued";
    const shown = rv.findings.filter((f) => !f.deleted);
    const out = [];
    if (published) out.push(h("div", { class: "banner ok" }, "Published", safeUrl(published.url) ? h("span", {}, " · ", h("a", { href: safeUrl(published.url), target: "_blank", rel: "noopener", text: "open the review" })) : null, ` · ${fmtDate(published.at)}`));
    else if (live) out.push(h("div", { class: "banner" }, d.progress ? `${d.progress.phase}: ${d.progress.message}` : "The agent is reading the pull request…"));
    else if (d.status === "failed") out.push(h("div", { class: "banner bad", text: d.error || "The review failed." }));
    else out.push(h("div", { class: "banner" }, d.publish === "auto" ? "Automatic publishing is on for this repository." : "A draft: nothing has been sent to the forge. Edit or delete what you do not agree with, then publish."));
    if (d.finish?.summary) out.push(h("p", { class: "review-note" }, h("strong", { text: `Agent (${d.finish.outcome}): ` }), d.finish.summary));
    if (run.requests) out.push(h("div", { class: "banner" }, `The agent asked for something: ${plural(run.requests, "request")} wait${run.requests === 1 ? "s" : ""} in `, h("a", { href: "#", onclick: (e) => { e.preventDefault(); showTab("requests"); }, text: "Requests" }), "."));

    const verdict = h("select", {}, [["comment", "Comment"], ["request_changes", "Request changes"], ["approve", "Approve"]].map(([v, l]) => h("option", { value: v, text: l })));
    verdict.value = rv.submitted?.verdict ?? "comment";
    const summary = h("textarea", { rows: "4", spellcheck: "false", disabled: !!published, placeholder: "Summary of the review" });
    summary.value = rv.submitted?.summary ?? d.finish?.summary ?? "";
    if (!published) {
      const publish = h("button", { class: "btn primary", type: "button", disabled: live || !(shown.length || summary.value.trim()), onclick: async (e) => {
        if (!confirm(`Post this review to the forge: ${plural(shown.length, "inline comment")}, verdict "${verdict.value}"?`)) return;
        e.currentTarget.disabled = true;
        try { await reviewCall("POST", "review/publish", { verdict: verdict.value, summary: summary.value.trim() || undefined }); toast("Review published."); await tick(); } catch (err) { toast(err.message, true); }
        await loadReview(true);
      } }, icon("upload"), `Publish review (${plural(shown.length, "comment")})`);
      out.push(h("div", { class: "finding" }, h("div", { class: "file-head", text: "Review" }), summary, h("div", { class: "row" }, h("label", {}, "Verdict ", verdict), publish)));
    } else out.push(h("div", { class: "finding" }, h("div", { class: "file-head", text: `Review · ${rv.submitted?.verdict ?? ""}` }), h("pre", { class: "summary", text: rv.submitted?.summary ?? "" })));

    if (!rv.findings.length) out.push(h("p", { class: "empty", text: live ? "No findings yet." : "The agent reported no findings." }));
    for (const f of rv.findings) {
      const body = h("textarea", { rows: "4", spellcheck: "false", disabled: !!published || !!f.deleted });
      body.value = f.body;
      const sev = h("select", { disabled: !!published || !!f.deleted }, SEVERITIES.map((s) => h("option", { value: s, text: s })));
      sev.value = f.severity;
      const call = (payload) => async () => { try { await reviewCall("PUT", `review/findings/${f.n}`, payload()); await loadReview(true); } catch (err) { toast(err.message, true); } };
      out.push(h("div", { class: `finding sev-${f.severity}${f.deleted ? " deleted" : ""}` },
        h("div", { class: "file-head" }, h("code", { text: `${f.path}:${f.startLine ? `${f.startLine}-` : ""}${f.line}${f.side === "LEFT" ? " (old)" : ""}` }),
          h("span", { class: "tag", text: f.category }), f.confidence !== undefined ? h("span", { class: "tag", text: `${Math.round(f.confidence * 100)}%` }) : null, f.edited ? h("span", { class: "tag", text: "edited" }) : null, sev),
        body, f.suggestion !== undefined ? h("pre", { class: "suggestion", text: f.suggestion }) : null,
        published ? null : h("div", { class: "row" },
          f.deleted ? h("button", { class: "btn sm", type: "button", onclick: call(() => ({ deleted: false })), text: "Restore" })
            : [h("button", { class: "btn sm primary", type: "button", onclick: call(() => ({ body: body.value, severity: sev.value })), text: "Save" }),
              h("button", { class: "btn sm ghost danger-text", type: "button", onclick: call(() => ({ deleted: true })), text: "Delete" })])));
    }
    reviewPane.replaceChildren(...out);
  }

  // ---- requests of the agent (actions API): questions, and actions that wait for a person to approve or reject them
  let requestsKey = "", requestsBusy = false;
  async function loadRequests(force) {
    if (!run || destroyed || requestsBusy) return;
    let d;
    try { d = await getJson(runUrl("actions")); } catch (err) { requestsPane.replaceChildren(h("p", { class: "empty", text: err.message })); return; }
    const key = JSON.stringify([d.questions, d.requests, d.finish, d.progress, d.status]);
    if (!force && key === requestsKey) return;
    requestsKey = key;
    renderRequests(d);
  }
  async function requestCall(suffix, body) {
    requestsBusy = true;
    try { await api("POST", runUrl(suffix), body); } catch (err) { toast(err.message, true); } finally { requestsBusy = false; }
    await tick();
    await loadRequests(true);
  }
  const REQUEST = {
    comment: { title: (x) => (x.inReplyTo ? `Reply in thread ${x.inReplyTo}` : "Comment on the pull request"), approve: "Post", hint: "posted under the bot account" },
    thread_resolve: { title: (x) => `Resolve thread ${x.thread_id} · ${x.resolution.replace("_", " ")}`, approve: "Resolve", hint: "resolves the thread on the forge" },
    propose_followup: { title: (x) => `Follow-up · ${x.kind.replace("_", " ")}: ${x.title}`, approve: "Create issue", hint: "creates an issue in the repository" },
    request_domain: { title: (x) => `Domains: ${x.domains.join(", ")}`, approve: "Acknowledge", hint: "the allowlist is changed by an operator, not by this button" },
  };
  function renderRequests(d) {
    const out = [];
    const live = d.status === "running" || d.status === "queued";
    if (live && d.progress) out.push(h("div", { class: "banner" }, `${d.progress.phase}: ${d.progress.message}`));
    if (d.finish?.summary) out.push(h("p", { class: "review-note" }, h("strong", { text: `Agent (${d.finish.outcome}): ` }), d.finish.summary));
    const open = d.questions.filter((q) => !q.answered && Date.now() < q.expiresAt), pending = d.requests.filter((x) => !x.decision);
    if (!open.length && !pending.length) out.push(h("div", { class: "banner" }, d.requests.length || d.questions.length ? "Nothing waits for you." : live ? "The agent has not asked for anything yet." : "The agent asked for nothing."));
    for (const q of open) {
      const text = h("input", { placeholder: "answer", size: "40" });
      const send = (payload) => requestCall("answer", { question_id: q.id, ...payload });
      out.push(h("div", { class: "finding" }, h("div", { class: "file-head" }, h("strong", { text: "Question from the agent" }), q.blocking ? h("span", { class: "tag", text: "the agent waits" }) : null),
        h("p", { text: q.question }),
        h("div", { class: "row" }, (q.options ?? []).map((o) => h("button", { class: "btn sm", type: "button", onclick: () => send({ option_id: o.id }), text: o.label })),
          text, h("button", { class: "btn sm", type: "button", onclick: () => text.value.trim() && send({ text: text.value.trim() }), text: "Answer" }))));
    }
    // Pending first, then what was decided, newest last within each group.
    for (const x of [...pending, ...d.requests.filter((r) => r.decision)]) {
      const def = REQUEST[x.type], dec = x.decision;
      const body = x.type === "comment" ? x.body : x.type === "propose_followup" ? x.body : x.type === "thread_resolve" ? x.note : x.reason;
      const note = h("input", { placeholder: "note for the agent (optional)", size: "32" });
      const decide = (decision) => requestCall(`actions/${encodeURIComponent(x.id)}/decide`, { decision, note: note.value.trim() || undefined });
      out.push(h("div", { class: `finding${dec?.status === "rejected" ? " deleted" : ""}` },
        h("div", { class: "file-head" }, h("strong", { text: def.title(x) }), x.path ? h("code", { text: x.path }) : null,
          h("span", { class: "tag", text: dec ? dec.status : "waits for you" })),
        body ? h("pre", { class: "summary", text: body }) : null,
        dec ? h("p", { class: "review-note" }, `${dec.status === "approved" ? "Approved" : "Rejected"} ${fmtDate(dec.at)}`, dec.note ? `: ${dec.note}` : "",
          safeUrl(dec.url) ? h("span", {}, " · ", h("a", { href: safeUrl(dec.url), target: "_blank", rel: "noopener", text: "open" })) : null)
          : h("div", { class: "row" }, note,
            h("button", { class: "btn sm primary", type: "button", title: def.hint, onclick: (e) => { e.currentTarget.disabled = true; decide("approve"); }, text: def.approve }),
            h("button", { class: "btn sm ghost danger-text", type: "button", onclick: (e) => { e.currentTarget.disabled = true; decide("reject"); }, text: "Reject" }),
            h("small", { text: def.hint }))));
    }
    const answered = d.questions.filter((q) => q.answered);
    if (answered.length) out.push(h("h3", { text: "Answered questions" }), ...answered.map((q) => h("p", { text: q.question })));
    requestsPane.replaceChildren(...out);
  }

  // ---- lifecycle
  function update() {
    const r = findRun(id);
    if (!r) return;
    // A VM-only session opens on the log while the VM starts; once it is ready the terminal is what it is for.
    const vmReady = r.status === "ready" && run.status !== "ready" && !r.prompt && !r.kind && tab === "log";
    run = r;
    renderHead(false);
    if (vmReady) showTab("term");
    if ((tab === "conv" || wide.matches) && (isActive(run) || convStatus !== run.status)) loadTranscript(false);
    if (tab === "proposal") renderProposal(false);
    if (tab === "review") loadReview(false);
    if (tab === "requests") loadRequests(false);
  }
  function destroy() { destroyed = true; closeTerm(); }

  (async () => {
    if (!run) { try { run = await getJson(`/api/runs/${encodeURIComponent(id)}`); state.runs.push(run); } catch { /* shown below */ } }
    if (!run) { head.replaceChildren(emptyBox("Session not found", `${id} does not exist.`, h("a", { class: "btn", href: `#/r/${repoName}` }, "Back"))); tabs.hidden = true; conv.hidden = true; return; }
    tab = run.kind === "review" ? "review" : run.status === "ready" && !run.prompt && !run.kind ? "term" : "conv";
    renderHead(true);
    showTab(tab);
  })();
  return { el, update, destroy };
}

// ---------------------------------------------------------------- repository settings

function settingsView(name) {
  const repo = name ? repoOf(name) : null;
  const el = h("div", { class: "page" });
  if (name && !repo) { el.append(emptyBox("Repository not found", `${name} is not configured.`, h("a", { class: "btn", href: "#/" }, "Back"))); return { el, update() {} }; }
  const cfg = state.cfg;
  const msg = h("span", { class: "msg" });
  const f = {
    repo: h("input", { name: "repo", placeholder: "owner/name", required: true, value: repo?.repo ?? "", disabled: !!repo }),
    provider: h("select", { name: "provider" }, cfg.providers.map((p) => h("option", { value: p.id, text: p.ready ? p.id : `${p.id} (${p.tokenEnv} missing)` }))),
    base: h("input", { name: "base", placeholder: "provider's default branch", value: repo?.base ?? "" }),
    environment: h("select", { name: "environment" }, cfg.environments.map((e) => h("option", { value: e.name, text: e.name }))),
    model: h("select", { name: "model" }, h("option", { value: "", text: "No default (server decides)" }), cfg.models.map((m) => h("option", { value: m, text: m }))),
    reviewPublish: h("select", { name: "reviewPublish" }, h("option", { value: "draft", text: "Draft: findings wait for me to publish them" }), h("option", { value: "auto", text: "Automatic: post the review to the forge at once (never approves)" })),
    setup: h("textarea", { name: "setup", rows: "8", spellcheck: "false", placeholder: "composer install --no-interaction", value: repo?.setup ?? "" }),
    env: h("textarea", { name: "env", rows: "4", spellcheck: "false", placeholder: "APP_ENV=test", value: fmtEnv(repo?.env) }),
  };
  if (repo) { f.provider.value = repo.provider; f.environment.value = repo.environment; f.model.value = repo.model ?? ""; f.reviewPublish.value = repo.reviewPublish ?? "draft"; }
  const modelBoxes = cfg.models.map((m) => h("label", { class: "check" }, h("input", { type: "checkbox", value: m, checked: !!repo?.models?.includes(m) }), m));
  const checked = (boxes) => boxes.map((b) => b.querySelector("input")).filter((i) => i.checked).map((i) => i.value);

  const form = h("form", { class: "card form", onsubmit: async (e) => {
    e.preventDefault();
    try {
      const body = { repo: f.repo.value.trim(), provider: f.provider.value, base: f.base.value.trim(), environment: f.environment.value, model: f.model.value || null,
        models: checked(modelBoxes), reviewPublish: f.reviewPublish.value, setup: f.setup.value, env: parseEnv(f.env.value) };
      await api("PUT", "/api/repos", body);
      await loadCfg();
      toast("Saved");
      location.hash = `#/r/${body.repo}`;
    } catch (err) { msg.textContent = err.message; }
  } },
    h("div", { class: "row" },
      h("label", { class: "grow" }, "Repository", f.repo), h("label", {}, "Provider", f.provider), h("label", {}, "Base branch", f.base)),
    h("div", { class: "row" },
      h("label", { class: "grow" }, "Environment ", h("small", { text: "VM image setup, shared by repositories" }), f.environment),
      h("label", { class: "grow" }, "Default model", f.model)),
    h("label", {}, "Review of a pull request ", h("small", { text: "what happens to the findings when the agent is done" }), f.reviewPublish),
    h("fieldset", {}, h("legend", { text: "Models a session may use" }), h("div", { class: "checks" }, modelBoxes), h("small", { text: "None selected: every model is allowed." })),
    h("label", {}, "Setup script ", h("small", { text: "bash, root in the VM, cwd /workspace, after clone. Empty: .yfactory/setup.sh from the repository." }), f.setup),
    h("label", {}, "Environment variables ", h("small", { text: "KEY=value per line. Visible to the agent, never put secrets here." }), f.env),
    h("div", { class: "actions" }, msg, h("button", { class: "primary", type: "submit" }, repo ? "Save" : "Add repository")));
  form.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) form.requestSubmit(); });

  const extra = [];
  if (repo) {
    extra.push(h("div", { class: "card" }, h("h3", { text: "Inspect environment" }),
      h("p", { class: "hint", text: "An agent reads the repository (manifests, CI, devcontainer), tries install, build and test, and proposes repository and environment settings. Nothing is changed until you apply the proposal." }),
      h("button", { class: "btn", type: "button", onclick: async (e) => {
        e.currentTarget.disabled = true;
        try { const r = await api("POST", `/api/repos/${repo.repo}/inspect`, { model: f.model.value || undefined }); state.runs.unshift(r); location.hash = `#/r/${repo.repo}/s/${r.id}`; } catch (err) { toast(err.message, true); e.currentTarget.disabled = false; }
      } }, icon("scan"), "Inspect environment")));
    extra.push(h("div", { class: "card danger-zone" }, h("h3", { text: "Remove repository" }),
      h("p", { class: "hint", text: "Removes the configuration only. Sessions already run stay in the history." }),
      h("button", { class: "btn danger", type: "button", onclick: async () => {
        if (!confirm(`Remove ${repo.repo}?`)) return;
        try { await fetch(`/api/repos/${repo.repo}`, { method: "DELETE" }); await loadCfg(); location.hash = "#/"; } catch (err) { toast(err.message, true); }
      } }, icon("trash"), "Remove")));
  }
  el.append(h("div", { class: "page-head" }, h("div", {}, repo ? h("a", { class: "back", href: `#/r/${repo.repo}` }, icon("chev", "flip"), repo.repo) : null, h("h1", { text: repo ? "Repository settings" : "Add repository" }))),
    form, ...extra);
  return { el, update() {} };
}

// ---------------------------------------------------------------- environments

function environmentsView() {
  const el = h("div", { class: "page" });
  const msg = h("span", { class: "msg" });
  const f = {
    name: h("input", { name: "name", placeholder: "lowercase-name", pattern: "[a-z0-9][a-z0-9\\-]*", required: true }),
    setup: h("textarea", { name: "setup", rows: "6", spellcheck: "false", placeholder: "apt-get install -y imagemagick" }),
    maintenance: h("textarea", { name: "maintenance", rows: "6", spellcheck: "false", placeholder: "composer install --no-interaction" }),
    env: h("textarea", { name: "env", rows: "4", spellcheck: "false", placeholder: "APP_ENV=test" }),
  };
  const list = h("div", { class: "env-list" });
  const edit = (x) => { f.name.value = x?.name ?? ""; f.setup.value = x?.setup ?? ""; f.maintenance.value = x?.maintenance ?? ""; f.env.value = fmtEnv(x?.env); msg.textContent = ""; f.name.focus(); };
  const form = h("form", { class: "card form", onsubmit: async (e) => {
    e.preventDefault();
    try {
      await api("PUT", "/api/environments", { name: f.name.value.trim(), setup: f.setup.value, maintenance: f.maintenance.value, env: parseEnv(f.env.value) });
      await loadCfg();
      msg.textContent = "saved";
      update();
    } catch (err) { msg.textContent = err.message; }
  } },
    h("h3", { text: "Configure environment" }),
    h("p", { class: "hint", text: "Shared by repositories. Images are built with the deployment and cannot be added here." }),
    h("label", {}, "Name", f.name),
    h("label", {}, "Setup script ", h("small", { text: "bash, root in the VM, cwd /, right after the VM is created, before clone." }), f.setup),
    h("label", {}, "Maintenance script ", h("small", { text: "bash, root in the VM, cwd /workspace, at the start of every run after the repository setup, before the agent." }), f.maintenance),
    h("label", {}, "Environment variables ", h("small", { text: "KEY=value per line. Visible to the agent, never put secrets here. The repository overrides them." }), f.env),
    h("div", { class: "actions" }, msg, h("button", { class: "primary", type: "submit" }, "Save")));
  form.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) form.requestSubmit(); });
  function update() {
    const envs = state.cfg.environments;
    list.replaceChildren(...(envs.length ? envs.map((x) => {
      const users = state.cfg.repos.filter((r) => r.environment === x.name);
      return h("div", { class: "env-card" },
        h("div", { class: "nm", text: x.name }),
        h("div", { class: "sub" },
          h("span", { text: x.setup ? plural(x.setup.split("\n").length, "setup line") : "no setup" }),
          h("span", { text: x.maintenance ? plural(x.maintenance.split("\n").length, "maintenance line") : "no maintenance" }),
          h("span", { text: plural(Object.keys(x.env).length, "variable") }),
          h("span", { text: users.length ? `used by ${users.map((r) => r.repo).join(", ")}` : "unused" })),
        h("div", { class: "act" },
          h("button", { class: "btn sm", type: "button", onclick: () => edit(x) }, icon("edit"), "Edit"),
          h("button", { class: "btn sm danger", type: "button", onclick: async () => {
            if (!confirm(`Remove ${x.name}?`)) return;
            try { await api("DELETE", `/api/environments/${x.name}`); await loadCfg(); update(); } catch (err) { toast(err.message, true); }
          } }, icon("trash"), "Remove")));
    }) : [emptyBox("No environments yet", "")]));
  }
  update();
  el.append(h("div", { class: "page-head" }, h("h1", { text: "Environments" }), h("button", { class: "btn", type: "button", onclick: () => edit(null) }, icon("plus"), "New environment")), list, form);
  return { el, update: () => {} };
}


// ---------------------------------------------------------------- polling

async function tick() {
  try {
    const runs = await getJson("/api/runs");
    state.runs = runs;
    state.connected = true;
  } catch { state.connected = false; renderSide(); return; }
  renderSide();
  view?.update?.();
}

addEventListener("hashchange", navigate);
(async () => {
  try { await loadCfg(); } catch (err) { toast(`Cannot load the configuration: ${err.message}`, true); }
  await tick();
  await navigate();
  setInterval(tick, 3000);
})();
