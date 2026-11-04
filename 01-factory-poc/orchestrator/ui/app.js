const $ = (id) => document.getElementById(id);
let forgejo = "";

function cell(tr, text, link) {
  const td = tr.insertCell();
  if (link) {
    const a = document.createElement("a");
    a.textContent = text;
    a.href = link;
    td.append(a);
  } else td.textContent = text;
  return td;
}

const fmt = (ms) => (ms ? new Date(ms).toLocaleString("cs-CZ") : "");
const dur = (s) => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`);

async function get(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(path + " " + r.status);
  return r.json();
}

async function start(issue) {
  $("msg").textContent = "";
  const r = await fetch("/api/runs", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo: issue.repo, issue: issue.number, runtime: $("runtime").value }),
  });
  const data = await r.json().catch(() => ({}));
  $("msg").textContent = r.ok ? `Spusteno (${data.status})` : data.error || "Chyba " + r.status;
  refresh();
}

function renderIssues(list) {
  const body = $("issues");
  body.replaceChildren();
  for (const i of list) {
    const tr = body.insertRow();
    cell(tr, "#" + i.number, `${forgejo}/${i.repo}/issues/${i.number}`);
    cell(tr, i.title);
    cell(tr, i.labels.join(", "));
    const b = document.createElement("button");
    b.textContent = i.active ? "Bezi" : "Implementuj";
    b.disabled = i.active;
    b.onclick = () => start(i);
    tr.insertCell().append(b);
  }
}

function renderRuns(list) {
  const body = $("runs");
  body.replaceChildren();
  for (const r of list) {
    const tr = body.insertRow();
    const st = cell(tr, r.status + (r.error ? ` (${r.error})` : ""));
    st.className = "s-" + r.status;
    cell(tr, r.runtime + (r.source === "webhook" ? " / webhook" : ""));
    cell(tr, `${r.kind === "iteration" ? "PR " : ""}#${r.issue} ${r.title}`, `${forgejo}/${r.repo}/${r.kind === "iteration" ? "pulls" : "issues"}/${r.issue}`);
    if (r.pr) cell(tr, "#" + r.pr, `${forgejo}/${r.repo}/pulls/${r.pr}`); else cell(tr, "");
    cell(tr, fmt(r.startedAt));
    cell(tr, r.startedAt ? dur(Math.round(((r.finishedAt || Date.now()) - r.startedAt) / 1000)) : "");
  }
}

async function refresh() {
  try {
    const [runs, issues] = await Promise.all([get("/api/runs"), get("/api/issues")]);
    forgejo = runs.forgejo;
    renderRuns(runs.runs);
    renderIssues(issues);
    $("info").textContent = "max " + runs.maxRunning + " soubezne";
  } catch (e) {
    $("info").textContent = "chyba nacteni: " + e.message;
  }
}

(async () => {
  const cfg = await get("/api/config");
  $("repo").textContent = cfg.repos.join(", ");
  for (const name of cfg.runtimes) {
    const o = new Option(name, name, false, name === cfg.defaultRuntime);
    $("runtime").add(o);
  }
  refresh();
  setInterval(refresh, 3000);
})();
