import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CFG } from "./config.ts";
import * as act from "./actions.ts";
import * as git from "./git.ts";
import * as ide from "./ide.ts";
import * as inspect from "./inspect.ts";
import * as mcpadmin from "./mcpadmin.ts";
import { inc, render, type Sample } from "./metrics.ts";
import * as rev from "./review.ts";
import * as repos from "./repos.ts";
import * as sandbox from "./sandbox.ts";
import * as terminal from "./terminal.ts";
import * as vmfiles from "./vmfiles.ts";
import * as yf from "./yf.ts";
import * as runs from "./runs.ts";
import type { Run } from "./runs.ts";
import { body, json } from "./httpx.ts";
import * as llm from "./llm.ts";
import { forge, litellm, NotFound, s3Get, s3Head, s3Put, Unsupported } from "./services.ts";

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui");
const MAX_PROMPT = 64 * 1024;

class RunError extends Error {
  name = "RunError";
}

// opencode.json from config/ wins over the one in the VM image, so a model or MCP change needs a restart, not a build.
const AGENT_CONFIG = path.join(CFG.config, "opencode.json");
const AGENT_CONFIG_VM = "/home/agent/.yf/opencode.json";

const TASK_PORT = Number(process.env.YF_TASK_LISTEN ?? 9001);
const hash = (t: string) => createHash("sha256").update(t).digest("hex");

function sandboxEnv(run: Run, token: string): Record<string, string> {
  const api = `http://${CFG.sandbox.api}:${TASK_PORT}`, host = CFG.sandbox.proxy, proxy = `http://${host}:3128`;
  return {
    LLM_BASE_URL: api, TASK_API_URL: api,
    HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, NO_PROXY: CFG.sandbox.api, no_proxy: CFG.sandbox.api, YF_PROXY_HOST: host,
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraheader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
    YF_TOKEN: token, YF_RUN: run.id, YF_REPO: run.repo, YF_BASE: run.base, YF_BRANCH: run.branch, YF_REMOTE: `${api}/git/${run.id}.git`, YF_KIND: act.kindOf(run),
    ...(run.target && { YF_PR: run.target.id, YF_BASE_SHA: run.target.baseSha, YF_HEAD_SHA: run.target.headSha }),
    GIT_AUTHOR_NAME: "yfactory", GIT_AUTHOR_EMAIL: "agent@yfactory.invalid", GIT_COMMITTER_NAME: "yfactory", GIT_COMMITTER_EMAIL: "agent@yfactory.invalid",
    ...(fs.existsSync(AGENT_CONFIG) && { OPENCODE_CONFIG: AGENT_CONFIG_VM }),
    ...run.env,
  };
}

const quote = (v: string) => `'${v.replaceAll("'", `'\\''`)}'`;

async function vm(run: Run, cmd: string, stdin?: string, timeout?: number) {
  const r = await sandbox.exec(run.vm!, `. ~/.yf-env && ${cmd}`, stdin, timeout);
  if (r.code) throw new RunError(`VM exit ${r.code}: ${r.stderr.toString().slice(-300)}`);
  return r.stdout.toString();
}

// Mirror of the repository the run repositories are cut from.
async function refresh(repo: string) {
  const p = repos.providerOf(repo);
  const mirror = await git.updateMirror(repo, forge.repoUrl(p, repo), forge.gitAuth(p));
  return mirror;
}

async function prepare(run: Run) {
  const mirror = await refresh(run.repo);
  const review = run.kind === "review" && run.target, revise = run.kind === "revise" && run.target, pr = review || revise;
  let baseSha: string;
  if (pr) {
    // The head of the PR comes from the mirror, the VM never fetches from the forge.
    const r = await git.createReviewRepo(run.id, mirror, pr.baseRef, forge.prRef(repos.providerOf(run.repo), pr.id), revise ? run.branch : undefined);
    if (r.headSha !== pr.headSha) console.log(`[${run.id}] PR head moved to ${r.headSha.slice(0, 12)}`);
    run.target = { ...pr, baseSha: r.baseSha, headSha: r.headSha, files: r.files };
    // revise: new commits are counted from the head the run started on, and only those are pushed.
    baseSha = revise ? r.headSha : r.baseSha;
  } else baseSha = (await git.createRunRepo(run.id, mirror, run.base, run.branch)).baseSha;
  const name = sandbox.PREFIX + run.id;
  const token = randomBytes(32).toString("base64url");
  runs.update(run, { vm: name, baseSha, tokenHash: hash(token), target: run.target });
  await sandbox.create(name);
  // The VM never sees this key: the task API swaps it in for the run token.
  runs.update(run, { llmKey: await litellm.grant(name, { run: run.id, repo: run.repo }, run.keep ? "24h" : "2h") });
  // env.d: image hooks that derive tool settings from the env, e.g. Maven proxy settings.
  const env = Object.entries(sandboxEnv(run, token)).map(([k, v]) => `export ${k}=${quote(v)}\n`).join("") +
    `export PATH="$HOME/.yf/bin:$PATH"\nfor f in /etc/yfactory/env.d/*.sh; do if [ -r "$f" ]; then . "$f"; fi; done\n`;
  // stdin, not argv: argv is visible in ps
  const r = await sandbox.exec(name, "umask 077 && cat > ~/.yf-env", env);
  if (r.code) throw new RunError("writing env to the VM failed");
  const helper = await sandbox.exec(name, "mkdir -p ~/.yf/bin && cat > ~/.yf/bin/yf-act && chmod 755 ~/.yf/bin/yf-act", rev.ACT);
  if (helper.code) throw new RunError("installing yf-act in the VM failed");
  const log: string[] = [];
  if (review) {
    // A review reads code: no setup scripts, no install, no build.
    await giveAgentConfig(run);
    await vm(run, `git clone -q -b yf-head "$YF_REMOTE" /workspace`, undefined, 1800);
    return "";
  }
  await script(run, log, "environment setup", run.envSetup, "/");
  await giveAgentConfig(run);
  await vm(run, `git clone -q --depth 50 --single-branch -b ${revise ? "yf-head" : '"$YF_BASE"'} "$YF_REMOTE" /workspace && cd /workspace && git checkout -q -b "$YF_BRANCH"`, undefined, 1800);
  const repoScript = run.setup || (await vm(run, "cat /workspace/.yfactory/setup.sh 2>/dev/null || true"));
  await script(run, log, `repository setup (${run.setup ? "repository settings" : ".yfactory/setup.sh"})`, repoScript, "/workspace");
  await script(run, log, "environment maintenance", run.maintenance, "/workspace");
  return log.join("\n");
}

async function giveAgentConfig(run: Run) {
  if (!fs.existsSync(AGENT_CONFIG)) return;
  JSON.parse(fs.readFileSync(AGENT_CONFIG, "utf8"));
  await vm(run, "mkdir -p ~/.yf && cat > ~/.yf/opencode.json", fs.readFileSync(AGENT_CONFIG, "utf8"));
}

// Root in the VM, the run env loaded, the output of all steps kept together in S3. /workspace goes back to agent afterwards.
async function script(run: Run, log: string[], label: string, body: string, cwd: string) {
  if (!body.trim()) return;
  const r = await sandbox.exec(run.vm!, `. /home/agent/.yf-env && cd ${cwd} && bash -e -s; c=$?; chown -R agent:agent /workspace 2>/dev/null; exit $c`,
    body, CFG.setupTimeout, "root");
  log.push(`$ ${label}, exit ${r.code}\n${r.stdout}${r.stderr}`);
  await s3Put(`runs/${run.id}/setup.log`, log.join("\n"), "text/plain").catch((e) => console.error(`[${run.id}] setup log`, e.message));
  // An inspect run goes on after a failing script: the failure is what the agent looks at.
  if (r.code && run.kind !== "inspect") throw new RunError(`${label} exit ${r.code}: ${r.stderr.toString().slice(-300)}`);
}

// The prompt goes in on stdin, not argv: the agent runs `pkill -f <tool>` and a prompt in argv made that kill opencode itself.
async function agent(run: Run, text = run.prompt) {
  const model = run.model ? `--model ${quote("litellm/" + run.model)}` : "";
  const out = await vm(run, `cd /workspace && opencode run ${model}`, text, CFG.runTimeout);
  const title = run.prompt.split("\n")[0].slice(0, 72) || "yfactory";
  await vm(run, `cd /workspace && git add -A && (git diff --cached --quiet || git commit -q -F -) && git push -q origin "HEAD:refs/heads/$YF_BRANCH"`, title);
  return out.slice(-4000);
}

async function inspectEnvironment(run: Run, log: string) {
  const repo = repos.get(run.repo), env = repo && repos.getEnv(repo.environment);
  if (!repo || !env) throw new RunError("repository or environment is no longer configured");
  const usedBy = repos.all().filter((r) => r.environment === env.name).map((r) => r.repo);
  const text = inspect.prompt(repo, env, usedBy, log);
  const model = run.model ? `--model ${quote("litellm/" + run.model)}` : "";
  // A failing agent may still have written a proposal.
  await vm(run, `cd /workspace && opencode run ${model}`, text, CFG.runTimeout).catch((e) => console.error(`[${run.id}] inspect agent`, e.message));
  if (run.proposal) return runs.save(); // sent with propose_environment
  const p = inspect.parse(await vm(run, `cat ${inspect.FILE} 2>/dev/null || true`));
  if (typeof p === "string") throw new RunError(p);
  runs.update(run, { proposal: p });
}

const publishing = new Set<string>();

// Posts the review of a run to the forge: one review with the inline comments that were not deleted. Never twice.
async function publishReview(run: Run, opts: { manual: boolean; verdict?: "approve" | "request_changes" | "comment"; summary?: string }): Promise<string> {
  const rv = act.review(run);
  if (!run.target) throw new RunError("not a review run");
  if (rv.published) throw new RunError("the review was already published");
  if (publishing.has(run.id)) throw new RunError("the review is being published");
  publishing.add(run.id);
  try {
    const prov = repos.providerOf(run.repo);
    const url = await forge.publishReview(prov, run.repo, run.target.id, rev.build(run, prov, opts));
    rv.published = { url, at: Date.now() };
    if (rv.submitted?.actionId) act.pushEvent(run, { type: "action_result", action_id: rv.submitted.actionId, status: "accepted" });
    runs.save();
    inc("yf_review_published_total", { mode: opts.manual ? "manual" : "auto" });
    return url;
  } finally { publishing.delete(run.id); }
}

async function reviewRun(run: Run) {
  const model = run.model ? `--model ${quote("litellm/" + run.model)}` : "";
  const failure = await vm(run, `cd /workspace && opencode run ${model}`, rev.prompt(run), CFG.runTimeout).then(() => "", (e: Error) => e.message);
  const rv = act.review(run), a = act.acts(run);
  const reported = rv.findings.some((f) => !f.deleted) || rv.submitted || rv.comments.length;
  // A failing agent may still have reported findings; with none, the run failed.
  if (failure && !reported) throw new RunError(failure);
  if (!reported && a.finish && a.finish.outcome !== "done" && a.finish.outcome !== "nothing_to_do") throw new RunError(`the agent reported ${a.finish.outcome}`);
  if (!rv.submitted && reported) rv.submitted = { actionId: null, verdict: "comment", summary: a.finish?.summary ?? "" };
  runs.save();
  if (rv.submitted && !rv.published && repos.get(run.repo)?.reviewPublish === "auto") await publishReview(run, { manual: false });
}

async function publish(run: Run, summary = "") {
  const p = path.join(git.RUNS, `${run.id}.git`);
  if (!fs.existsSync(p)) throw new RunError("run repository no longer exists");
  const tip = await git.git(p, ["rev-parse", "--verify", "-q", `refs/heads/${run.branch}`]).catch(() => "");
  if (!tip) throw new RunError("run branch does not exist, nothing was pushed");
  const reason = await git.checkCommits(p, run.baseSha!, tip);
  if (reason) throw new RunError(`branch rejected: ${reason}`);
  const prov = repos.providerOf(run.repo);
  const lease = run.pr ? (await git.git(p, ["config", "--get", "yfactory.published"]).catch(() => "")) : "";
  await git.git(p, ["push", "-q", `--force-with-lease=refs/heads/${run.branch}:${lease}`, forge.repoUrl(prov, run.repo), `${tip}:refs/heads/${run.branch}`], forge.gitAuth(prov));
  await git.git(p, ["config", "yfactory.published", tip]);
  if (!run.pr) {
    const title = run.prompt.split("\n")[0].slice(0, 72) || `yfactory ${run.id}`;
    const body = `${run.prompt}\n\n---\n${summary}\n\nyfactory run \`${run.id}\``.slice(0, 60_000);
    runs.update(run, { pr: await forge.openPr(prov, run.repo, { head: run.branch, base: run.base, title, body }) });
  }
}

const reviseLabel = (t: NonNullable<Run["target"]>) => `Revise #${t.id} ${t.title}`.slice(0, 120);

// Revise: the agent's commits on top of the PR head go to the head branch of the PR, after the same checks as a new PR.
// A plain push, no force: if someone pushed to the PR meanwhile, the forge refuses it and the run fails with that reason.
async function reviseRun(run: Run) {
  const t = run.target!;
  await agent(run, rev.revisePrompt(run, run.prompt === reviseLabel(t) ? "" : run.prompt));
  const p = path.join(git.RUNS, `${run.id}.git`);
  const tip = await git.git(p, ["rev-parse", "--verify", "-q", `refs/heads/${run.branch}`]).catch(() => "");
  if (!tip || tip === run.baseSha) {
    const a = act.acts(run);
    if (!a.resolves.length && !a.comments.length) throw new RunError("the agent made no commit and answered no thread");
    return; // only replies and resolutions, which wait for a person
  }
  const reason = await git.checkCommits(p, run.baseSha!, tip);
  if (reason) throw new RunError(`commits rejected: ${reason}`);
  const prov = repos.providerOf(run.repo);
  await git.git(p, ["push", "-q", forge.repoUrl(prov, run.repo), `${tip}:refs/heads/${t.headRef}`], forge.gitAuth(prov))
    .catch(() => { throw new RunError(`the push to ${t.headRef} was refused (did the pull request move?)`); });
  runs.update(run, { pr: t.url });
  inc("yf_publish_total", { result: "ok" });
}

// What approving a pending action does outside the orchestrator; the url is shown with the decision.
async function applyRequest(run: Run, type: act.Decidable, item: act.Request): Promise<string | undefined> {
  const prov = repos.providerOf(run.repo);
  // A PR of this run: the one it reviews or revises, or the one it opened.
  const prOf = () => run.target?.id ?? /\/(?:pull|pulls|merge_requests)\/(\d+)$/.exec(run.pr ?? "")?.[1];
  switch (type) {
    case "propose_followup": {
      const f = item as act.Acts["followups"][number];
      return forge.createIssue(prov, run.repo, { title: f.title, body: `${f.body}\n\n---\nSuggested by yfactory run \`${run.id}\`${f.path ? ` (${f.path})` : ""}.` });
    }
    case "comment": {
      const c = item as act.Acts["comments"][number], id = prOf();
      if (!id) throw new RunError("this run has no pull request to post to");
      return forge.comment(prov, run.repo, id, c.body, c.inReplyTo);
    }
    case "thread_resolve": {
      const r = item as act.Acts["resolves"][number], id = prOf();
      if (!id) throw new RunError("this run has no pull request");
      await forge.resolveThread(prov, run.repo, id, r.thread_id);
      return run.target?.url;
    }
    case "request_domain":
      return undefined; // the allowlist is changed by an operator; approving tells the agent it will be
  }
}

// To a file first: opencode exits before a pipe is drained, so a session of a few hundred KB came out cut off in the middle.
async function exportSession(run: Run, id: string): Promise<string> {
  const data = await vm(run, `f=$(mktemp) && opencode export ${id} > "$f"; rc=$?; cat "$f"; rm -f "$f"; exit $rc`);
  JSON.parse(data); // never store a truncated export
  return data;
}

async function exportSessions(run: Run) {
  if (!run.vm) return;
  const list: { id: string }[] = JSON.parse((await vm(run, "opencode session list --format json").catch(() => "[]")) || "[]");
  const day = new Date(run.createdAt).toISOString().slice(0, 10);
  for (const { id } of list) {
    if (!/^[\w-]+$/.test(id)) continue;
    const data = await exportSession(run, id);
    const key = `sessions/${run.repo}/${day}/${run.id}/${id}.json`;
    await s3Put(key, data);
    if (!run.sessions.includes(key)) run.sessions.push(key);
  }
  runs.save();
}

async function saveMeta(run: Run) {
  await s3Put(`runs/${run.id}.json`, JSON.stringify({ ...run, vm: undefined, tokenHash: undefined, llmKey: undefined }, null, 1)).catch((e) => console.error(`[${run.id}] meta`, e.message));
}

async function destroy(run: Run) {
  await exportSessions(run).catch((e) => console.error(`[${run.id}] export`, e.message));
  if (run.vm) {
    await litellm.revoke(run.vm).catch((e) => console.error(`[${run.id}] revoke`, e.message));
    await sandbox.remove(run.vm).catch((e) => console.error(`[${run.id}] remove`, e.message));
  }
  git.removeRunRepo(run.id);
  diffs.delete(run.id);
  runs.update(run, { vm: null, tokenHash: null, llmKey: null, status: run.status === "ready" ? "done" : run.status });
  await saveMeta(run);
}

async function work(run: Run) {
  runs.update(run, { status: "running", startedAt: Date.now() });
  try {
    const log = await prepare(run);
    if (run.kind === "review") await reviewRun(run);
    else if (run.kind === "revise") await reviseRun(run);
    else if (run.kind === "inspect") await inspectEnvironment(run, log);
    else if (run.prompt) {
      const summary = await agent(run);
      await publish(run, summary).then(() => inc("yf_publish_total", { result: "ok" }), (e) => { inc("yf_publish_total", { result: "error" }); throw e; });
    }
    runs.update(run, { status: run.keep ? "ready" : "done", finishedAt: Date.now() });
    console.log(`[${run.id}] ${run.status} ${run.pr ?? ""}`);
  } catch (e) {
    console.error(`[${run.id}]`, e);
    runs.update(run, { status: "failed", error: cancelled.has(run.id) ? "cancelled" : e instanceof Error ? `${e.name}: ${e.message.slice(0, 200)}` : "Error", finishedAt: Date.now() });
  } finally {
    inc("yf_runs_finished_total", { repo: run.repo, status: run.status, environment: run.environment });
    if (!run.keep || run.status === "failed") await destroy(run);
    else await saveMeta(run);
  }
}

// The list stays small: findings and events are served by /api/runs/<id>/review and /actions; `requests` counts what waits for a person.
function publicRun(run: Run) {
  const { llmKey, tokenHash, acts, review, ...r } = run, pending = acts ? pendingCount(run, acts) : 0;
  return {
    ...r,
    ...(acts?.progress && { progress: acts.progress }),
    ...(pending && { requests: pending }),
    ...(acts?.count && { actions: acts.count }),
    ...(review && { review: { findings: review.findings.filter((f) => !f.deleted).length, submitted: !!review.submitted, published: review.published } }),
  };
}

function pendingCount(run: Run, a: act.Acts) {
  return a.questions.filter((q) => !q.answered && Date.now() < q.expiresAt).length + act.requests(run).filter((x) => !x.decision).length;
}

// Everything the VM sent through the actions API, for any run kind. Events are the last ones the VM can still fetch.
function actionsView(run: Run) {
  const a = act.acts(run);
  return {
    kind: act.kindOf(run), status: run.status, capabilities: act.CAPS[act.kindOf(run)], count: a.count, progress: a.progress ?? null, finish: a.finish ?? null,
    questions: a.questions, requests: act.requests(run), artifacts: a.artifacts, events: a.events.slice(-50),
  };
}

// The opencode session n of a run: live from the VM while it exists, otherwise the export in S3.
async function transcript(run: Run, n: number): Promise<Buffer | null> {
  if (run.vm && (run.status === "running" || run.status === "ready")) {
    try {
      const list: { id: string; created?: number }[] = JSON.parse((await vm(run, "opencode session list --format json")) || "[]");
      const id = list.sort((a, b) => (a.created ?? 0) - (b.created ?? 0))[n]?.id;
      if (id && /^[\w-]+$/.test(id)) return Buffer.from(await exportSession(run, id));
    } catch { /* VM busy or gone: fall back to the export */ }
  }
  return run.sessions[n] ? s3Get(run.sessions[n]) : null;
}

const cancelled = new Set<string>();

// Queued: just dropped. Running: the agent process is killed so the normal failure path exports the sessions; before the agent
// starts (setup scripts) there is nothing to kill, so the VM goes.
async function cancel(run: Run): Promise<number> {
  if (run.status === "queued") {
    runs.dequeue(run.id);
    runs.update(run, { status: "failed", error: "cancelled", finishedAt: Date.now() });
    return 200;
  }
  if (run.status !== "running") return 409;
  cancelled.add(run.id);
  const killed = run.vm ? await sandbox.exec(run.vm, "pkill -f '[o]pencode run'", "", 30).catch(() => null) : null;
  if (run.vm && killed?.code !== 0) await sandbox.remove(run.vm).catch(() => {});
  return 200;
}

const live = () => runs.all().filter((r) => r.vm).length;

// Gauges from the run history (last 500 runs), so they survive a restart; counters only since the start.
function metrics() {
  const all = runs.all(), g: Sample[] = [];
  for (const s of ["queued", "running", "ready", "done", "failed"]) g.push(["yf_runs", { status: s }, all.filter((r) => r.status === s).length]);
  for (const s of ["ready", "done", "failed"]) {
    const d = all.filter((r) => r.status === s && r.startedAt && r.finishedAt).map((r) => (r.finishedAt! - r.startedAt!) / 1000);
    g.push(["yf_run_duration_seconds_sum", { status: s }, d.reduce((a, b) => a + b, 0)], ["yf_run_duration_seconds_count", { status: s }, d.length]);
  }
  const q = runs.queueState();
  g.push(["yf_runs_queue", {}, q.queued], ["yf_runs_active", {}, q.active], ["yf_vms", {}, live()], ["yf_repositories", {}, repos.all().length]);
  for (const p of repos.providerList()) g.push(["yf_provider_ready", { provider: p.id }, p.ready ? 1 : 0]);
  return render(g);
}

// Dependencies are named, the reason is only the error class or status, never a URL or a response body.
async function health() {
  const probe = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => (e as { status?: number }).status ? `status ${(e as { status?: number }).status}` : e.name === "TimeoutError" ? "timeout" : "unreachable");
  const get = async (url: string) => { const r = await fetch(url, { signal: AbortSignal.timeout(3000) }); if (!r.ok) throw Object.assign(new Error("status"), { status: r.status }); };
  const checks = {
    sandbox: await probe(get(`${CFG.sandbox.url}/health`)),
    s3: await probe(s3Head()),
    litellm: await probe(get(`${CFG.litellm.url}/health/liveliness`)),
  };
  return { ok: Object.values(checks).every((c) => c === "ok"), checks };
}

// A prompt run, a terminal-only run (no prompt, VM kept), an inspect run (proposal, no PR) or a verify run (setup only, VM removed).
async function createRun(input: any, kind?: Run["kind"]): Promise<{ code: number; body: any }> {
  const repo = repos.get(input.repo);
  if (!repo) return { code: 400, body: { error: "repository is not configured" } };
  const prov = repos.providerOf(repo.repo);
  if (!prov.token) return { code: 503, body: { error: `${prov.tokenEnv} is not set` } };
  let target: Run["target"] = null;
  if (kind === "review" || kind === "revise") {
    const id = String(input.pr ?? "");
    if (!/^\d{1,9}$/.test(id)) return { code: 400, body: { error: "pr must be the number of a pull request" } };
    if (runs.all().some((r) => r.kind === kind && r.repo === repo.repo && r.target?.id === id && (r.status === "queued" || r.status === "running"))) return { code: 409, body: { error: `this pull request already has a ${kind} run in progress` } };
    try {
      const pr = await forge.pr(prov, repo.repo, id);
      if (kind === "revise" && !pr.sameRepo) return { code: 422, body: { error: "the pull request comes from a fork; yfactory pushes only to branches of the repository" } };
      if (kind === "revise" && !/^[\w][\w./-]*$/.test(pr.headRef)) return { code: 422, body: { error: "the head branch of the pull request has an unusual name" } };
      target = { id, title: pr.title, body: pr.body, author: pr.author, url: pr.url, baseRef: pr.baseRef, headRef: pr.headRef, baseSha: "", headSha: pr.headSha, files: [], threads: pr.threads };
    } catch (e) { return e instanceof NotFound ? { code: 404, body: { error: e.message } } : { code: 502, body: { error: "the forge did not answer" } }; }
  }
  const instructions = String(input.prompt ?? "").trim();
  const prompt = kind === "inspect" ? inspect.LABEL : kind === "verify" ? "" : kind === "review" ? `Review #${target!.id} ${target!.title}`.slice(0, 120)
    : kind === "revise" ? instructions || reviseLabel(target!) : instructions;
  const keep = !kind && (!!input.keep || !prompt); // no prompt: only prepare a VM for the terminal
  if (keep && live() >= CFG.maxSandboxes) return { code: 429, body: { error: "too many running sandboxes" } };
  const allowed = repo.models.length ? repo.models : CFG.litellm.models;
  if (input.model && !allowed.includes(input.model)) return { code: 400, body: { error: `model ${input.model} is not available for this repository` } };
  const model = input.model || repo.model || null;
  // A review only reads and comments; a run that pushes needs a token that can push.
  const info = kind === "review" ? { defaultBranch: target!.baseRef } : await forge.repo(prov, repo.repo);
  if (kind !== "review" && !(info as { canPush: boolean }).canPush) return { code: 403, body: { error: "token cannot push to the repository" } };
  // revise works on the head branch of the PR.
  const base = String(kind === "review" ? target!.baseRef : kind === "revise" ? target!.headRef : input.base || repo.base || info.defaultBranch);
  if (!/^[\w][\w./-]*$/.test(base) || base.includes("..")) return { code: 400, body: { error: "invalid branch" } };
  const environment = repos.getEnv(repo.environment)!;
  const run = runs.add({ repo: repo.repo, base, prompt, model, keep, kind, target, environment: environment.name, envSetup: environment.setup, maintenance: environment.maintenance,
    setup: repo.setup, env: { ...environment.env, ...repo.env } });
  runs.enqueue(run);
  return { code: 202, body: run };
}

async function api(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = (req.url ?? "/").split("?")[0];
  if (req.method === "GET" && url === "/health") {
    const h = await health();
    return json(res, h.ok ? 200 : 503, h);
  }
  if (req.method === "GET" && url === "/metrics") return res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" }).end(metrics());
  if (req.method === "GET" && !url.startsWith("/api/")) {
    const file = { "/": "index.html", "/app.js": "app.js", "/style.css": "style.css" }[url] ?? (/^\/vendor\/[\w.-]+\.(js|css)$/.test(url) ? url.slice(1) : undefined);
    if (!file || !fs.existsSync(path.join(UI, file))) return res.writeHead(404).end();
    const type = { html: "text/html", js: "text/javascript", css: "text/css" }[file.split(".").pop()!];
    return res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` }).end(fs.readFileSync(path.join(UI, file)));
  }
  if (req.method === "GET" && url === "/api/runs") {
    const q = new URL(req.url!, "http://ui").searchParams;
    const limit = Math.min(Number(q.get("limit")) || 200, 500), repo = q.get("repo");
    return json(res, 200, runs.all().filter((r) => !repo || r.repo === repo).map(publicRun).reverse().slice(0, limit));
  }
  const one = /^\/api\/runs\/(\w+)$/.exec(url);
  if (req.method === "GET" && one) {
    const run = runs.get(one[1]);
    return run ? json(res, 200, publicRun(run)) : json(res, 404, { error: "not found" });
  }
  const tr = /^\/api\/runs\/(\w+)\/transcript$/.exec(url);
  if (req.method === "GET" && tr) {
    const run = runs.get(tr[1]);
    if (!run) return json(res, 404, { error: "not found" });
    const n = Math.max(0, Number(new URL(req.url!, "http://ui").searchParams.get("n")) || 0);
    const data = await transcript(run, n);
    if (!data) return json(res, 404, { error: "no session yet" });
    try { JSON.parse(data.toString()); } catch { return json(res, 422, { error: "the stored export is incomplete (older exports were cut off)" }); }
    return res.writeHead(200, { "Content-Type": "application/json", "Content-Length": data.length }).end(data);
  }
  const rg = /^\/api\/runs\/(\w+)\/review$/.exec(url);
  if (req.method === "GET" && rg) {
    const run = runs.get(rg[1]);
    if (!run || run.kind !== "review") return json(res, 404, { error: "not a review run" });
    const a = act.acts(run);
    return json(res, 200, {
      target: run.target, publish: repos.get(run.repo)?.reviewPublish ?? "draft", review: act.review(run), status: run.status, error: run.error,
      progress: a.progress, finish: a.finish, questions: a.questions, domains: a.domains, followups: a.followups, artifacts: a.artifacts,
    });
  }
  const ag = /^\/api\/runs\/(\w+)\/actions$/.exec(url);
  if (req.method === "GET" && ag) {
    const run = runs.get(ag[1]);
    return run ? json(res, 200, actionsView(run)) : json(res, 404, { error: "not found" });
  }
  if (req.method === "GET" && url === "/api/config") {
    return json(res, 200, { providers: repos.providerList(), models: CFG.litellm.models, limits: { maxRunning: CFG.maxRunning, maxVms: CFG.maxSandboxes, runTimeout: CFG.runTimeout } });
  }
  const fm = /^\/api\/runs\/(\w+)\/(files|file)$/.exec(url);
  if (req.method === "GET" && fm) {
    const run = runs.get(fm[1]);
    if (!run?.vm) return json(res, 404, { error: "no VM for this run" });
    const p = new URL(req.url!, "http://ui").searchParams.get("path") ?? "/workspace";
    try {
      if (fm[2] === "files") return json(res, 200, await vmfiles.list(run.vm, p));
      const f = await vmfiles.read(run.vm, p);
      return res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": f.text.length, ...(f.truncated && { "X-Truncated": "1" }) }).end(f.text);
    } catch (e) {
      if (e instanceof vmfiles.FileError) return json(res, e.code, { error: e.message });
      throw e;
    }
  }
  const lm = /^\/api\/runs\/(\w+)\/log$/.exec(url);
  if (req.method === "GET" && lm && runs.get(lm[1])) {
    const log = await s3Get(`runs/${lm[1]}/setup.log`);
    return res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end(log ?? "");
  }
  if (req.method === "GET" && url === "/api/repos") return json(res, 200, { repos: repos.all(), providers: repos.providerList(), models: CFG.litellm.models, environments: repos.environments() });
  const rm = /^\/api\/repos\/([\w.-]+\/[\w.-]+)$/.exec(url);
  if (req.method === "DELETE" && rm && repos.validName(rm[1])) { repos.remove(rm[1]); return json(res, 200, { removed: rm[1] }); }
  const em = /^\/api\/environments\/([a-z0-9][a-z0-9-]*)$/.exec(url);
  if (req.method === "DELETE" && em) {
    const error = repos.removeEnv(em[1]);
    return error ? json(res, 409, { error }) : json(res, 200, { removed: em[1] });
  }
  if (req.method === "GET" && url === "/api/environments") return json(res, 200, repos.environments());
  if (req.method !== "POST" && req.method !== "PUT") return json(res, 404, { error: "not found" });
  // JSON only: a cross-site form cannot send it without a CORS preflight.
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "json only" });
  if (url === "/mcp") {
    // The API has no login; a web page must not be able to drive it through the browser of someone on the LAN.
    if (req.headers.origin && !terminal.sameOrigin(req)) return json(res, 403, { error: "foreign origin" });
    return mcpadmin.handle(req, res, await body(req, MAX_PROMPT + 4096));
  }
  const input = JSON.parse((await body(req, MAX_PROMPT + 4096)).toString() || "{}");
  if (req.method === "PUT" && url === "/api/repos") {
    const error = repos.put(input);
    if (error) return json(res, 400, { error });
    refresh(input.repo).catch((e) => console.error(`[${input.repo}] refresh`, e.message));
    return json(res, 200, repos.get(input.repo));
  }
  if (req.method === "PUT" && url === "/api/environments") {
    const error = repos.putEnv(input);
    return error ? json(res, 400, { error }) : json(res, 200, repos.getEnv(input.name));
  }
  if (url === "/api/runs") {
    if (input.kind !== undefined && !["review", "revise"].includes(input.kind)) return json(res, 400, { error: "kind must be review or revise" });
    if (input.kind && input.pr === undefined) return json(res, 400, { error: `a ${input.kind} run needs pr` });
    const r = await createRun(input, input.pr !== undefined ? input.kind ?? "review" : undefined);
    return json(res, r.code, r.body);
  }
  const dc = /^\/api\/runs\/(\w+)\/actions\/([A-Za-z0-9_-]{8,64})\/decide$/.exec(url);
  if (req.method === "POST" && dc) {
    const run = runs.get(dc[1]);
    if (!run) return json(res, 404, { error: "not found" });
    if (input.decision !== "approve" && input.decision !== "reject") return json(res, 400, { error: "decision must be approve or reject" });
    if (input.note !== undefined && (typeof input.note !== "string" || input.note.length > 2000)) return json(res, 400, { error: "invalid note" });
    try {
      // One decision at a time per run, in the same queue as the actions of the VM.
      const error = await git.locked(`act:${run.id}`, () => act.decide(run, dc[2], input.decision === "approve", input.note, (t, item) => applyRequest(run, t, item)));
      if (error) return json(res, error === "no such request" ? 404 : 409, { error });
    } catch (e) {
      if (e instanceof RunError || e instanceof Unsupported) return json(res, 409, { error: e.message });
      if (e instanceof NotFound) return json(res, 404, { error: e.message });
      console.error(`[${run.id}] decide`, e instanceof Error ? e.message : e);
      return json(res, 502, { error: "the forge did not accept it" });
    }
    runs.save();
    inc("yf_action_decisions_total", { decision: input.decision });
    return json(res, 200, act.requests(run).find((x) => x.id === dc[2]));
  }
  const ri = /^\/api\/repos\/([\w.-]+\/[\w.-]+)\/inspect$/.exec(url);
  if (ri) {
    const r = await createRun({ repo: ri[1], model: input.model }, "inspect");
    return json(res, r.code, r.body);
  }
  const ap = /^\/api\/runs\/(\w+)\/apply$/.exec(url);
  if (ap) {
    const run = runs.get(ap[1]);
    const part = input.part === "repository" || input.part === "environment" ? input.part : null;
    const p = part && run?.proposal?.[part];
    if (!run || !part || !p) return json(res, 404, { error: "no such proposal" });
    const repo = repos.get(run.repo), env = repo && repos.getEnv(repo.environment);
    if (!repo || !env) return json(res, 409, { error: "repository or environment is no longer configured" });
    // env is merged: the proposal adds or changes variables, it never drops the ones set by a person.
    const error = part === "repository"
      ? repos.put({ ...repo, ...p, env: { ...repo.env, ...p.env } })
      : repos.putEnv({ ...env, ...p, env: { ...env.env, ...p.env }, name: env.name });
    if (error) return json(res, 400, { error });
    runs.update(run, { applied: [...new Set([...(run.applied ?? []), part])] });
    // Setup only, in a fresh VM: shows whether the applied scripts pass.
    const v = await createRun({ repo: run.repo }, "verify");
    return json(res, 200, { applied: part, verify: v.code === 202 ? v.body.id : null, error: v.code === 202 ? null : v.body.error });
  }
  const fe = /^\/api\/runs\/(\w+)\/review\/findings\/(\d+)$/.exec(url);
  if (req.method === "PUT" && fe) {
    const run = runs.get(fe[1]), f = run && act.review(run).findings.find((x) => x.n === Number(fe[2]));
    if (!run || !f) return json(res, 404, { error: "no such finding" });
    if (act.review(run).published) return json(res, 409, { error: "the review was already published" });
    if (input.body !== undefined) {
      if (typeof input.body !== "string" || !input.body.trim() || input.body.length > 20_000) return json(res, 400, { error: "invalid body" });
      f.body = input.body; f.edited = true;
    }
    if (input.severity !== undefined) {
      if (!["blocker", "major", "minor", "nit", "praise"].includes(input.severity)) return json(res, 400, { error: "invalid severity" });
      f.severity = input.severity; f.edited = true;
    }
    if (input.deleted !== undefined) f.deleted = !!input.deleted;
    runs.save();
    return json(res, 200, f);
  }
  const rp = /^\/api\/runs\/(\w+)\/review\/publish$/.exec(url);
  if (req.method === "POST" && rp) {
    const run = runs.get(rp[1]);
    if (!run || run.kind !== "review" || !run.target) return json(res, 404, { error: "not a review run" });
    if (run.status === "running" || run.status === "queued") return json(res, 409, { error: "the review run is still in progress" });
    if (input.verdict !== undefined && !["approve", "request_changes", "comment"].includes(input.verdict)) return json(res, 400, { error: "invalid verdict" });
    if (input.summary !== undefined && (typeof input.summary !== "string" || input.summary.length > 20_000)) return json(res, 400, { error: "invalid summary" });
    try {
      const url2 = await publishReview(run, { manual: true, verdict: input.verdict, summary: input.summary });
      await saveMeta(run);
      return json(res, 200, { url: url2 });
    } catch (e) {
      return json(res, e instanceof RunError ? 409 : 502, { error: e instanceof RunError ? e.message : "the forge did not accept the review" });
    }
  }
  const an = /^\/api\/runs\/(\w+)\/answer$/.exec(url);
  if (req.method === "POST" && an) {
    const run = runs.get(an[1]);
    if (!run) return json(res, 404, { error: "not found" });
    const error = act.answer(run, String(input.question_id ?? ""), { option_id: input.option_id, text: input.text });
    if (error) return json(res, 409, { error });
    runs.save();
    return json(res, 200, { answered: input.question_id });
  }
  const im = /^\/api\/runs\/(\w+)\/ide$/.exec(url);
  if (im) {
    const run = runs.get(im[1]);
    if (!run?.vm) return json(res, 404, { error: "no VM for this run" });
    await sandbox.start(run.vm).catch((e) => console.error(`[${run.id}] start`, e.message));
    const r = await sandbox.exec(run.vm, `. ~/.yf-env && ${ide.START}`, "", 60);
    if (r.code) return json(res, 502, { error: "code-server did not start in the VM" });
    inc("yf_ide_starts_total");
    return json(res, 200, { port: CFG.idePort, path: `/${run.id}/?folder=/workspace` });
  }
  const cn = /^\/api\/runs\/(\w+)\/cancel$/.exec(url);
  if (cn) {
    const run = runs.get(cn[1]);
    if (!run) return json(res, 404, { error: "not found" });
    const code = await cancel(run);
    return json(res, code, code === 200 ? { cancelled: run.id } : { error: "the session is not queued or running" });
  }
  const m = /^\/api\/runs\/(\w+)\/(publish|destroy)$/.exec(url);
  const run = m && runs.get(m[1]);
  if (!run) return json(res, 404, { error: "not found" });
  if (m![2] === "destroy") {
    if (!run.vm || run.status === "running") return json(res, 409, { error: "no VM, or the run is still in progress" });
    await destroy(run);
    return json(res, 200, run);
  }
  if (run.status !== "ready") return json(res, 409, { error: "only a ready VM can be published" });
  try {
    await publish(run);
    await saveMeta(run);
    return json(res, 200, run);
  } catch (e) {
    return json(res, 422, { error: e instanceof Error ? e.message.slice(0, 300) : "Error" });
  }
}

// What the actions need from the outside world (api/ACTIONS.md); the rules themselves are in actions.ts.
const diffs = new Map<string, Promise<ReturnType<typeof act.parseDiff>>>();
const actionDeps: act.Deps = {
  diff: async (run) => {
    const t = run.target;
    if (!t || !run.vm) return null;
    const d = diffs.get(run.id) ?? diffs.set(run.id, git.diffOf(run.id, t.baseSha, t.headSha).then(act.parseDiff)).get(run.id)!;
    return d.catch((e) => { diffs.delete(run.id); throw e; });
  },
  async fetch(run, q) {
    const prov = repos.providerOf(run.repo);
    const id = String(q.ref ?? run.target?.id ?? "");
    switch (q.what) {
      case "pull_request": { const { threads, ...pr } = await forge.pr(prov, run.repo, id); return { pull_request: pr, thread_count: threads.length }; }
      case "comments": return { threads: (await forge.pr(prov, run.repo, id)).threads };
      case "ci_status": return forge.ci(prov, run.repo, id, (await forge.pr(prov, run.repo, id)).headSha);
      case "file_at_ref": {
        const ref = q.ref === "head" ? run.target?.headSha : q.ref === "base" ? run.target?.baseSha : q.ref;
        const text = ref && await git.fileAt(run.id, ref, q.path);
        if (text === null || text === undefined || text === "") throw new NotFound(`${q.path} does not exist at ${q.ref}`);
        return { path: q.path, ref: q.ref, content: text };
      }
      default: throw new NotFound(`${q.what} is not available in this deployment`);
    }
  },
  async putArtifact(run, name, data, type) {
    const key = `runs/${run.id}/artifacts/${name}`;
    await s3Put(key, data, type);
    return key;
  },
  async pullFile(run, vmPath, max) {
    const r = await sandbox.exec(run.vm!, `test -f ${quote(vmPath)} && head -c ${max + 1} ${quote(vmPath)}`, "", 60);
    if (r.code) throw new NotFound(`${vmPath} is not a file in the VM`);
    return r.stdout;
  },
  publish: (run) => publishReview(run, { manual: false }),
  autoPublish: (run) => repos.get(run.repo)?.reviewPublish === "auto",
};

async function taskApi(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = req.url ?? "";
  const route = url.startsWith("/git/") ? "git" : url.startsWith("/yf/") ? "yf" : llm.isLlmRoute(url) ? "llm" : "other";
  const deny = (code: number) => { inc("yf_task_api_denied_total", { route, code }); req.resume(); res.writeHead(code).end(); };
  inc("yf_task_api_requests_total", { route });
  const m = /^\/git\/(\w+)\.git\/(info\/refs\?service=git-(?:upload|receive)-pack|git-upload-pack|git-receive-pack)$/.exec(url);
  if (route === "other" || (route === "git" && !m)) return deny(404);
  // Bearer for git, MCP and OpenAI-style clients; x-api-key for Anthropic-style ones.
  const h = hash((req.headers.authorization ?? "").replace(/^Bearer /, "") || String(req.headers["x-api-key"] ?? ""));
  const run = runs.all().find((r) => r.vm && r.tokenHash === h);
  if (!run) return deny(401);
  if (route === "yf") return yf.serve(req, res, run, actionDeps);
  if (route === "llm") {
    if (!run.llmKey || req.method !== (url.split("?")[0] === "/v1/models" ? "GET" : "POST")) return deny(run.llmKey ? 405 : 403);
    return llm.forward(req, res, run.llmKey);
  }
  const id = run.id;
  if (id !== m![1]) return deny(403);
  if (req.method !== (m![2].startsWith("info/refs") ? "GET" : "POST")) return deny(405);
  git.httpBackend(id, m![2], req, res);
}

const safe = (fn: (q: http.IncomingMessage, r: http.ServerResponse) => unknown) => (q: http.IncomingMessage, r: http.ServerResponse) =>
  Promise.resolve(fn(q, r)).catch((e) => { console.error(e); if (!r.headersSent) r.writeHead(500); r.end(); });

repos.load();
const alive = new Set(await sandbox.list());
runs.load(alive);
for (const run of runs.all()) if (run.vm && run.status !== "ready") await destroy(run);
const kept = new Set(runs.all().filter((r) => r.vm).map((r) => r.id));
for (const name of alive) if (!kept.has(name.slice(sandbox.PREFIX.length))) await sandbox.remove(name).catch(() => {});
for (const f of fs.existsSync(git.RUNS) ? fs.readdirSync(git.RUNS) : []) if (!kept.has(f.replace(/\.git$/, ""))) fs.rmSync(`${git.RUNS}/${f}`, { recursive: true, force: true });
runs.setWorker(work);
(async () => { for (const r of repos.all()) await refresh(r.repo).catch((e) => console.error(`[${r.repo}] refresh`, e.message)); })();
const ui = http.createServer(safe(api));
ui.on("upgrade", (req, socket, head) => {
  const m = /^\/api\/runs\/(\w+)\/terminal(\?|$)/.exec(req.url ?? "");
  const run = m && runs.get(m[1]);
  if (!run?.vm || !terminal.sameOrigin(req)) return socket.end(`HTTP/1.1 ${run?.vm ? 403 : 404} Not Found\r\nConnection: close\r\n\r\n`);
  terminal.accept(req, socket, head, run.vm).catch((e) => { console.error(`[${run.id}] terminal`, e.message); socket.destroy(); });
});
// Ports are fixed in the container; the variables exist so a test can run the orchestrator next to a deployment.
const UI_PORT = Number(process.env.YF_UI_LISTEN ?? 8080);
ui.listen(UI_PORT);
http.createServer(safe(taskApi)).listen(TASK_PORT);
ide.serve((id) => runs.get(id)?.vm);
console.log(`yfactory: ui :${UI_PORT}, task api :${TASK_PORT}, ide :${ide.PORT}, kept VMs ${[...kept].join(", ") || "-"}, repos ${repos.all().map((r) => r.repo).join(", ") || "-"}`);
