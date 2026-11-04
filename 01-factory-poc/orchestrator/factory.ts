// Webhook -> sandbox -> staging -> PR. Bezi v kontejneru, viz compose.yml.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CANDIDATES, RUNTIMES, type Sandbox, type SandboxRuntime } from "./adapters/index.ts";
import { api } from "./http.ts";
import { run, sh, CommandError, type Result } from "./proc.ts";
import type { GitProvider } from "./providers/index.ts";
import { loadRegistry, type Project } from "./registry.ts";
import * as runs from "./runs.ts";
import type { Job } from "./runs.ts";
import { Staging } from "./staging.ts";
import { startUi } from "./yfactory.ts";

export { RUNTIMES, api };
export const ALL_RUNTIMES = { ...CANDIDATES, ...RUNTIMES };
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FACTORY = path.dirname(ROOT);

function loadEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const l = raw.trim();
    if (!l.includes("=") || l.startsWith("#")) continue;
    out[l.slice(0, l.indexOf("="))] = l.slice(l.indexOf("=") + 1);
  }
  return out;
}

export const CFG = loadEnv(path.join(ROOT, ".env"));
export const LITELLM = loadEnv(path.join(FACTORY, "litellm/.env"));
const registry = loadRegistry(process.env.FACTORY_PROJECTS ?? path.join(ROOT, "projects.json"), CFG);
const defaultProvider = registry.providers.get(registry.defaultProvider)!;
export const BOT = defaultProvider.botName;
const staging = new Staging(registry.staging);
const DEFAULT_RUNTIME = process.env.FACTORY_RUNTIME ?? "runc";
const LLM_MODELS = ["mock", "GLM-5.3-Flash", "GLM-5.3"];
// FACTORY_AGENT=fake pusti skriptovaneho agenta bez LLM (rychle testy), jinak agent.py na FACTORY_MODEL.
const AGENT = process.env.FACTORY_AGENT ?? "llm";
const LLM_MODEL = process.env.FACTORY_MODEL ?? "GLM-5.3-Flash";

const BLOCKED_PATHS = new Set([".git", ".forgejo", ".gitea", ".github", ".gitmodules", ".gitattributes"]);
export const MAX_REPLY = 4000;
const MAX_REPLY_REQUEST = 64 * 1024;
const TASK_TTL = 2 * 3600;
const MIRRORS = path.join(FACTORY, "state/mirrors");
const TASKS = path.join(FACTORY, "state/tasks");
const CLONE_DEPTH = process.env.FACTORY_CLONE_DEPTH ?? "50";
const seen = new Set<string>(); // Forgejo posila k jednomu issue opened i labeled

class TaskError extends Error {
  name = "TaskError";
}

const litellm = (p: string, body: unknown) => api("POST", p, body, {
  base: `http://${process.env.FACTORY_BIND ?? "127.0.0.1"}:4000`,
  headers: { Authorization: "Bearer " + LITELLM.LITELLM_MASTER_KEY, "Content-Type": "application/json" },
});

// auth: hodnota hlavicky Authorization pro HTTP remote (origin nebo staging), bez ni se zadna hlavicka neposila.
function git(cwd: string, args: string[], input?: Buffer, auth?: string) {
  const extra = auth ? ["-c", `http.extraheader=Authorization: ${auth}`] : [];
  return sh("git", [...extra, "-c", "core.hooksPath=/dev/null", ...args], { cwd, input });
}

const SAFE_BRANCH = /^[\w][\w./-]*$/;

function safeBranch(name: string) {
  if (!SAFE_BRANCH.test(name) || name.includes("..") || name.endsWith(".lock") || name.endsWith("/")) throw new TaskError("nepovoleny nazev vetve");
  return name;
}

export async function grantKey(sb: Sandbox, taskId: string, meta: object) {
  // Virtualni klic v sandboxu je zamerny: plati jen po dobu ulohy, realne klice zustavaji v LiteLLM. Budget se neresi.
  const key = (await litellm("/key/generate", { duration: "2h", models: LLM_MODELS, metadata: { task: taskId, ...meta } })).key;
  sb.gatewayEnv.LLM_API_KEY = key;
  return key as string;
}

export const revokeKey = (key: string) => litellm("/key/delete", { keys: [key] });

const mirrorLocks = new Map<string, Promise<unknown>>();

function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (mirrorLocks.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  mirrorLocks.set(key, next);
  return next;
}

// Bare kopie repa na hostu. Z upstreamu se stahuje jen rozdil, vraci cestu k mirroru.
async function updateMirror(pj: Project) {
  if (!/^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(pj.repo)) throw new TaskError("neplatny nazev repa");
  const p = path.join(MIRRORS, pj.providerId, `${pj.repo}.git`);
  const auth = pj.provider.gitAuthHeader();
  await locked(pj.id, async () => {
    if (fs.existsSync(p)) {
      await git(p, ["fetch", "-q", "--prune", "origin"], undefined, auth);
    } else {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      await git(path.dirname(p), ["clone", "-q", "--mirror", pj.provider.repoUrl(pj.repo), p], undefined, auth);
    }
  });
  return p;
}

// Origin -> mirror -> staging. Staging dostane base a u iterace i head vetev, vzdy prepsane podle originu.
// Na integritu base na stagingu se nespolehame: do originu jde jen to, co projde kontrolou commitu.
async function syncStaging(pj: Project, mirror: string, branches: string[]) {
  const name = staging.name(`${pj.providerId}/${pj.repo}`);
  await locked(pj.id, async () => {
    await staging.ensureRepo(name);
    await git(mirror, ["push", "-q", "--force", staging.repoUrl(name), ...branches.map((b) => `refs/heads/${b}:refs/heads/${b}`)], undefined, staging.authHeader());
  });
  return name;
}

const taskPath = (token: string) => path.join(TASKS, createHash("sha256").update(token).digest("hex"));

export function saveTask(p: string, task: object) {
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(task), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, p);
}

export function grantTask(sb: Sandbox, repo: string, number: number, pr: number | null, sha: string, stagingName?: string, project?: string) {
  // Na disku je jen hash tokenu. Token smi cist pouze kontext teto jedne ulohy.
  fs.mkdirSync(TASKS, { recursive: true });
  const token = randomBytes(32).toString("base64url");
  const p = taskPath(token);
  saveTask(p, { repo, number, pr, sha, staging: stagingName, project, expires: Date.now() / 1000 + TASK_TTL });
  sb.gatewayEnv.TASK_TOKEN = token;
  return p;
}

export function loadTask(token: string): any {
  try {
    const task = JSON.parse(fs.readFileSync(taskPath(token), "utf8"));
    return task.expires > Date.now() / 1000 ? task : null;
  } catch {
    return null;
  }
}

// Starsi ulohy bez `project` (a testy) patri k repu u vychoziho provideru.
function projectOf(task: any): Project {
  const pj = (task.project && registry.projects.get(task.project))
    || [...registry.projects.values()].find((p) => p.providerId === registry.defaultProvider && p.repo === task.repo);
  if (!pj) throw new Error("projekt ulohy neni v registru");
  return pj;
}

async function taskComments(task: any) {
  const { comments, reviews } = await projectOf(task).provider.feedback(task.repo, task.number, task.pr);
  return { untrusted_content: true, number: task.number, comments, review_comments: reviews };
}

async function taskCi(task: any) {
  const { state, statuses } = await projectOf(task).provider.ci(task.repo, task.sha);
  return { untrusted_content: true, sha: task.sha, state, statuses };
}

// Odmitne zmeny CI, git metadat, symlinky a binarky. Vraci duvod, nebo null.
export function checkPatch(patch: Buffer | string): string | null {
  const text = typeof patch === "string" ? patch : patch.toString("utf8");
  // Deleni stejne jako Python splitlines/split: radku ma byt spis vic nez mene.
  for (const line of text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/)) {
    if (line.startsWith("diff --git ")) {
      for (let p of line.split(/[\s\x1c-\x1f\x85]+/).slice(2, 4)) {
        p = p.includes("/") ? p.slice(p.indexOf("/") + 1) : p;
        if (BLOCKED_PATHS.has(p.split("/")[0])) return `blokovana cesta ${p}`;
      }
    } else if (["new file mode 120000", "new mode 120000", "index "].some((s) => line.startsWith(s)) && line.includes("120000")) {
      return "symlink";
    } else if (line.startsWith("GIT binary patch")) {
      return "binarni soubor";
    }
  }
  return null;
}

// Vystup `git diff --raw -z`, nezavisly na parsovani textu patche (rename, mezery v nazvech).
function checkRaw(out: string): string | null {
  const fields = out.split("\0");
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [, mode] = fields[i].split(" ");
    if (BLOCKED_PATHS.has(fields[i + 1].split("/")[0])) return `blokovana cesta ${fields[i + 1]}`;
    if (mode === "120000" || mode === "160000") return `nepovoleny mode ${mode}`;
  }
  return null;
}

export async function checkTree(cwd: string, from: string): Promise<string | null> {
  return checkRaw(await git(cwd, ["diff", "--no-renames", "--raw", "-z", from, "HEAD"]));
}

const MAX_COMMITS = 200;

// Kazdy commit zvlast: mezilehly commit s workflow muze spustit CI v originu, i kdyz ho dalsi commit smaze.
// Nic se nechekautuje, cte se jen z objektu v gitDir.
export async function checkCommits(gitDir: string, base: string, tip: string): Promise<string | null> {
  const commits = (await git(gitDir, ["rev-list", "--reverse", `${base}..${tip}`])).split("\n").filter(Boolean);
  if (!commits.length) return "zadny novy commit";
  if (commits.length > MAX_COMMITS) return `prilis mnoho commitu (${commits.length})`;
  for (const c of commits) {
    if ((await git(gitDir, ["rev-list", "--parents", "-n", "1", c])).split(" ").length > 2) return "merge commit";
    const reason = checkRaw(await git(gitDir, ["diff-tree", "--root", "--no-renames", "-r", "--raw", "-z", "--no-commit-id", c]));
    if (reason) return reason;
  }
  return checkRaw(await git(gitDir, ["diff", "--no-renames", "--raw", "-z", `${base}...${tip}`]));
}

export const mayTrigger = (repo: string, user: unknown): Promise<boolean> => defaultProvider.mayTrigger(repo, user);

function check(result: Result) {
  if (result.code) throw new TaskError(`sandbox exit ${result.code}: ${result.stderr.subarray(-2000).toString()}`);
  return result;
}

async function tarDir(dir: string) {
  const r = await run("tar", ["-cf", "-", "-C", dir, "."]);
  if (r.code) throw new CommandError("tar exit " + r.code);
  return r.stdout;
}

async function runTask(job: Job, runtimeName: string, taskId: string): Promise<number | null> {
  const { repo, issue, base: baseBranch, head: headBranch, pr: existingPr } = job;
  const pj = registry.projects.get(job.project);
  if (!pj) throw new TaskError("projekt neni v registru");
  const provider: GitProvider = pj.provider;
  const rt: SandboxRuntime = ALL_RUNTIMES[runtimeName]();
  const url = provider.repoUrl(repo);
  const number = issue.number;
  const branch = safeBranch(headBranch || `factory/issue-${number}-${taskId}`);
  safeBranch(baseBranch);
  let sb: Sandbox | undefined, key: string | undefined, taskFile: string | undefined;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "factory-"));
  try {
    sb = await rt.create(taskId);
    key = await grantKey(sb, taskId, { repo, issue: number });
    const mirror = await updateMirror(pj);
    const stagingName = await syncStaging(pj, mirror, headBranch ? [baseBranch, headBranch] : [baseBranch]);
    const src = `${tmp}/src`;
    // file:// a jedna vetev: do sandboxu nejdou objekty jinych vetvi ani PR.
    await git(tmp, ["clone", "-q", "--single-branch", ...(CLONE_DEPTH ? ["--depth", CLONE_DEPTH] : []), "-b", headBranch || baseBranch, `file://${mirror}`, src]);
    const baseSha = await git(src, ["rev-parse", "HEAD"]);
    await git(src, ["remote", "remove", "origin"]);
    if (!headBranch) await git(src, ["checkout", "-q", "-b", branch]);
    taskFile = grantTask(sb, repo, number, existingPr, baseSha, stagingName, pj.id);
    // Agent pushuje na staging pres task API gateway. Identita je TASK_TOKEN, ne token stagingu.
    Object.assign(sb.gatewayEnv, {
      STAGING_URL: `${sb.gatewayEnv.TASK_API_URL}/git/${stagingName}.git`,
      FACTORY_BRANCH: branch, FACTORY_BASE: baseBranch,
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraheader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${sb.gatewayEnv.TASK_TOKEN}`,
    });
    check(await rt.exec(sb, "tar -xf - -C /workspace", await tarDir(src)));
    check(await rt.exec(sb, 'cd /workspace && git remote add origin "$STAGING_URL"'));
    // Komentare si agent cte zive pres task API, zapisuje jen orchestrator.
    const taskDir = `${tmp}/task`;
    fs.mkdirSync(taskDir);
    fs.writeFileSync(`${taskDir}/issue.json`, JSON.stringify({ number, title: issue.title, body: issue.body ?? "" }));
    fs.copyFileSync(path.join(ROOT, AGENT === "fake" ? "fake_agent.py" : "agent.py"), `${taskDir}/agent.py`);
    sb.gatewayEnv.LLM_MODEL = LLM_MODEL;
    check(await rt.exec(sb, "tar -xf - -C /task", await tarDir(taskDir)));
    check(await rt.exec(sb, "cd /workspace && python3 /task/agent.py"));
    // Ze sandboxu bereme jen sha HEAD. Vsechno ostatni se cte ze stagingu a jeho .git se na hostiteli nikdy nepouzije.
    const head = check(await rt.exec(sb, "cd /workspace && git rev-parse HEAD")).stdout.toString().trim();
    if (!/^[0-9a-f]{40,64}$/.test(head)) throw new TaskError("neplatny HEAD");
    // Vetev ze stagingu do docasneho bare repa. Objekty z mirroru jsou sdilene (alternates), nic se nechekautuje.
    const fetched = `${tmp}/fetched.git`;
    await git(tmp, ["init", "-q", "--bare", fetched]);
    fs.writeFileSync(`${fetched}/objects/info/alternates`, path.join(mirror, "objects") + "\n");
    const originBase = await git(mirror, ["rev-parse", `refs/heads/${baseBranch}`]);
    await git(fetched, ["update-ref", "refs/factory/base", originBase]); // aby fetch stahl jen rozdil
    try {
      await git(fetched, ["-c", "transfer.fsckObjects=true", "fetch", "-q", staging.repoUrl(stagingName), `+refs/heads/${branch}:refs/factory/tip`], undefined, staging.authHeader());
    } catch {
      throw new TaskError("vetev na stagingu neexistuje, agent nepushnul");
    }
    const tip = await git(fetched, ["rev-parse", "refs/factory/tip"]);
    if (tip === baseSha) throw new TaskError("agent nevytvoril zadnou zmenu");
    if (tip !== head) throw new TaskError("agent nepushnul HEAD");
    const reason = await checkCommits(fetched, originBase, tip);
    if (reason) throw new TaskError(`vetev odmitnuta: ${reason}`);
    const reply: string = JSON.parse(fs.readFileSync(taskFile, "utf8")).reply ?? "";
    // Force je nutny kvuli rebase, lease ale nepusti pres commity, ktere na vetev mezitim pridal clovek.
    await git(fetched, ["push", "-q", `--force-with-lease=refs/heads/${branch}:${existingPr ? baseSha : ""}`, url, `${tip}:refs/heads/${branch}`], undefined, provider.gitAuthHeader());
    let prNumber = existingPr;
    if (existingPr) {
      await provider.comment(repo, existingPr, reply || `Iterace hotova, runtime \`${rt.runtime}\`, uloha \`${taskId}\`.`);
    } else {
      prNumber = await provider.openChange(repo, {
        head: branch, base: baseBranch, title: `Resolve #${number}: ${issue.title}`,
        body: `Closes #${number}\n\n${reply}\n\nRuntime: \`${rt.runtime}\`, uloha: \`${taskId}\``,
      });
      await provider.comment(repo, number, `PR: #${prNumber}`);
    }
    console.log(`[${taskId}] done`);
    return prNumber;
  } catch (e) {
    console.error(`[${taskId}]`, e);
    // Do komentare jde jen typ chyby, vystup sandboxu muze obsahovat cokoli.
    const name = e instanceof Error ? e.name : "Error";
    await provider.comment(repo, number, `Uloha \`${taskId}\` selhala: \`${name}\`. Detail je v logu orchestratoru.`).catch(() => {});
    throw e;
  } finally {
    if (taskFile) fs.rmSync(taskFile, { force: true });
    if (key) await revokeKey(key).catch((e) => console.error(`[${taskId}] revoke`, e.name));
    if (sb) await rt.destroy(sb).catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Vraci ulohu k provedeni, nebo null.
async function route(providerId: string, headers: http.IncomingHttpHeaders, payload: unknown): Promise<Job | null> {
  const provider = registry.providers.get(providerId)!;
  const trigger = provider.parseEvent(headers, payload);
  if (!trigger) return null;
  const pj = registry.byRepo(providerId, trigger.repo);
  if (!pj) {
    console.error(`webhook: repo ${JSON.stringify(trigger.repo)} neni v registru providera ${providerId}`);
    return null;
  }
  if (!(await provider.mayTrigger(trigger.repo, trigger.sender))) return null;
  if (trigger.dedupe) {
    const k = `${pj.id}:${trigger.dedupe}`;
    if (seen.has(k)) return null;
    seen.add(k);
  }
  return { ...(await trigger.load()), project: pj.id };
}

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (d: Buffer) => {
      size += d.length;
      if (size > limit) { reject(new Error("too large")); req.destroy(); } else chunks.push(d);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function hook(req: http.IncomingMessage, res: http.ServerResponse) {
  const done = (code: number) => { res.writeHead(code).end(); };
  if (req.method !== "POST") return done(405);
  // /webhook/<id providera>; holy /webhook patri prvnimu provideru v registru (puvodni nastaveni hooku).
  const m = /^\/webhook(?:\/([a-z0-9-]+))?$/.exec((req.url ?? "").split("?")[0]);
  const providerId = m?.[1] ?? registry.defaultProvider;
  const provider = m && registry.providers.get(providerId);
  if (!provider) return done(404);
  let body: Buffer;
  try { body = await readBody(req, 25 * 1024 * 1024); } catch { return done(413); }
  if (!provider.verifyWebhook(req.headers, body)) return done(401);
  try {
    const job = await route(providerId, req.headers, JSON.parse(body.toString()));
    if (job) {
      try { runs.submit(job, DEFAULT_RUNTIME, "webhook"); } catch (e) { console.error("webhook:", (e as Error).message); }
    }
  } catch (e) {
    console.error("webhook", e);
    return done(500);
  }
  done(202);
}

// API pro sandbox, dostupne jen pres gateway. Uloha vychazi z tokenu, klient nevybira repo ani issue.
// Git smart HTTP pro staging. Identita je TASK_TOKEN a ulohu omezuje na jeji staging repo.
function gitProxy(req: http.IncomingMessage, res: http.ServerResponse) {
  const deny = (code: number) => { req.resume(); res.writeHead(code).end(); };
  const m = /^\/git\/([\w.-]+)\.git\/(info\/refs\?service=git-(?:upload|receive)-pack|git-upload-pack|git-receive-pack)$/.exec(req.url ?? "");
  if (!m) return deny(404);
  const task = loadTask((req.headers.authorization ?? "").replace(/^Bearer /, ""));
  if (!task) return deny(401);
  if (task.staging !== m[1]) return deny(403);
  if (req.method !== (m[2].startsWith("info/refs") ? "GET" : "POST")) return deny(405);
  staging.proxy(m[1], m[2], req, res);
}

async function taskApi(req: http.IncomingMessage, res: http.ServerResponse) {
  if ((req.url ?? "").startsWith("/git/")) return gitProxy(req, res);
  const respond = (code: number, data: object) => {
    const raw = Buffer.from(JSON.stringify(data));
    res.writeHead(code, { "Content-Type": "application/json", "Content-Length": raw.length }).end(raw);
  };
  const reject = (code: number, data: object) => { req.resume(); respond(code, data); };
  const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  const task = loadTask(token);
  if (!task) return reject(401, { error: "unauthorized" });
  if (req.method === "GET") {
    if (req.url === "/task/slack") return respond(501, { error: "slack not configured" });
    const handler = ({ "/task/comments": taskComments, "/task/ci": taskCi } as Record<string, (t: any) => Promise<object>>)[req.url ?? ""];
    if (!handler) return respond(404, { error: "not found" });
    try {
      respond(200, await handler(task));
    } catch (e) {
      console.error(e);
      respond(502, { error: "upstream failed" });
    }
  } else if (req.method === "POST") {
    if (req.url !== "/task/reply") return reject(404, { error: "not found" });
    const length = req.headers["content-length"] ?? "";
    if (!/^\d+$/.test(length) || Number(length) > MAX_REPLY_REQUEST) return reject(413, { error: "too large" });
    // Text jen ulozime. Do Forgeja ho posle orchestrator az po prijeti patche.
    const raw = await readBody(req, MAX_REPLY_REQUEST).catch(() => null);
    if (!raw) return respond(413, { error: "too large" });
    task.reply = [...raw.toString()].slice(0, MAX_REPLY).join("").trim();
    saveTask(taskPath(token), task);
    respond(202, { stored: true });
  } else {
    reject(404, { error: "not found" });
  }
}

// Po restartu zadna uloha neprezila: uklid kontejneru, siti a tokenu z prerusenych behu.
async function cleanupOrphans() {
  for (const kind of ["container", "network"]) {
    const list = await sh("docker", [kind, "ls", ...(kind === "container" ? ["-a"] : []), "--filter", "name=factory-task-", "--format", kind === "container" ? "{{.Names}}" : "{{.Name}}"]).catch(() => "");
    for (const name of list.split("\n").filter((n) => n.startsWith("factory-task-"))) {
      if (kind === "network") for (const gw of ["factory-llm-gw", "factory-pkg-gw"]) await run("docker", ["network", "disconnect", "-f", name, gw]);
      await run("docker", kind === "container" ? ["rm", "-f", name] : ["network", "rm", name]);
    }
  }
  for (const make of Object.values(ALL_RUNTIMES)) await make().cleanup?.().catch((e) => console.error("cleanup", e.message));
  for (const f of fs.existsSync(TASKS) ? fs.readdirSync(TASKS) : []) fs.rmSync(path.join(TASKS, f), { force: true });
}

if (import.meta.main) {
  if (!ALL_RUNTIMES[DEFAULT_RUNTIME]) throw new Error(`neznamy FACTORY_RUNTIME ${DEFAULT_RUNTIME}`);
  await cleanupOrphans();
  runs.init(path.join(FACTORY, "state/runs.json"), runTask);
  const safe = (fn: (q: http.IncomingMessage, r: http.ServerResponse) => Promise<unknown>) => (q: http.IncomingMessage, r: http.ServerResponse) =>
    fn(q, r).catch((e) => { console.error(e); if (!r.headersSent) r.writeHead(500); r.end(); });
  http.createServer(safe(taskApi)).listen(9001, CFG.WEBHOOK_BIND);
  http.createServer(safe(hook)).listen(9000, CFG.WEBHOOK_BIND);
  startUi({ cfg: CFG, projects: [...registry.projects.values()], runtimes: [...Object.keys(RUNTIMES), ...(process.env.FACTORY_CANDIDATES?.split(",").filter((n) => n in CANDIDATES) ?? [])], defaultRuntime: DEFAULT_RUNTIME });
  console.log(`listening on ${CFG.WEBHOOK_BIND}:9000 and :9001 runtime=${DEFAULT_RUNTIME}`);
}
