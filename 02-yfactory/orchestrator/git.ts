import { spawn } from "node:child_process";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { CFG } from "./config.ts";
import { run, sh } from "./proc.ts";

export const MIRRORS = path.join(CFG.data, "mirrors");
export const RUNS = path.join(CFG.data, "git");
const BLOCKED = new Set([".git", ".github", ".gitea", ".forgejo", ".gitlab-ci.yml", ".gitmodules", ".gitattributes"]);
const MAX_COMMITS = 200;

export function git(cwd: string, args: string[], auth?: string) {
  const extra = auth ? ["-c", `http.extraheader=Authorization: ${auth}`] : [];
  return sh("git", [...extra, "-c", "core.hooksPath=/dev/null", ...args], { cwd, timeout: 1800 });
}

const locks = new Map<string, Promise<unknown>>();
export function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  locks.set(key, next);
  return next;
}

export async function updateMirror(repo: string, url: string, auth: string) {
  const p = path.join(MIRRORS, `${repo}.git`);
  await locked(repo, async () => {
    if (fs.existsSync(p)) return git(p, ["fetch", "-q", "--prune", "origin"], auth);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    return git(path.dirname(p), ["clone", "-q", "--mirror", url, p], auth);
  });
  return p;
}

// Shares objects with the mirror. The pre-receive hook accepts only the run branch.
export async function createRunRepo(id: string, mirror: string, base: string, branch: string) {
  const p = path.join(RUNS, `${id}.git`);
  fs.mkdirSync(RUNS, { recursive: true });
  await git(RUNS, ["init", "-q", "--bare", p]);
  fs.writeFileSync(path.join(p, "objects/info/alternates"), path.join(mirror, "objects") + "\n");
  for (const [k, v] of [["http.receivepack", "true"], ["receive.fsckObjects", "true"], ["receive.maxInputSize", "500m"],
    ["receive.denyDeletes", "true"], ["uploadpack.allowFilter", "true"]]) await git(p, ["config", k, v]);
  await git(p, ["fetch", "-q", mirror, `+refs/heads/${base}:refs/heads/${base}`]);
  fs.writeFileSync(path.join(p, "hooks/pre-receive"),
    `#!/bin/sh\nwhile read old new ref; do [ "$ref" = "refs/heads/${branch}" ] || { echo "only ${branch} may be pushed" >&2; exit 1; }; done\n`, { mode: 0o755 });
  return { path: p, baseSha: await git(p, ["rev-parse", `refs/heads/${base}`]) };
}

export const removeRunRepo = (id: string) => fs.rmSync(path.join(RUNS, `${id}.git`), { recursive: true, force: true });

// The caller has already checked the token and the run id.
export function httpBackend(id: string, rest: string, req: http.IncomingMessage, res: http.ServerResponse) {
  const [pathInfo, query = ""] = rest.split("?");
  const p = spawn("git", ["http-backend"], {
    env: {
      PATH: process.env.PATH, GIT_PROJECT_ROOT: RUNS, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: `/${id}.git/${pathInfo}`,
      QUERY_STRING: query, REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers["content-type"] ?? "",
      HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "", GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
      REMOTE_USER: `run-${id}`, REMOTE_ADDR: "sandbox",
    },
  });
  req.pipe(p.stdin);
  let head = Buffer.alloc(0);
  let started = false;
  p.stdout.on("data", (d: Buffer) => {
    if (started) return void res.write(d);
    head = Buffer.concat([head, d]);
    const end = head.indexOf("\r\n\r\n");
    if (end < 0) return;
    started = true;
    let status = 200;
    const headers: Record<string, string> = {};
    for (const line of head.subarray(0, end).toString().split("\r\n")) {
      const i = line.indexOf(":");
      const [k, v] = [line.slice(0, i).trim(), line.slice(i + 1).trim()];
      if (k.toLowerCase() === "status") status = parseInt(v);
      else headers[k] = v;
    }
    res.writeHead(status, headers);
    res.write(head.subarray(end + 4));
  });
  p.stderr.on("data", (d: Buffer) => console.error(`[${id}] http-backend`, d.toString().trim().slice(0, 300)));
  p.on("close", () => { if (!started) res.writeHead(502); res.end(); });
  res.on("close", () => p.kill());
}

function checkRaw(out: string): string | null {
  const f = out.split("\0");
  for (let i = 0; i + 1 < f.length; i += 2) {
    const mode = f[i].split(" ")[1];
    const top = f[i + 1].split("/")[0];
    if (BLOCKED.has(top)) return `blocked path ${f[i + 1]}`;
    if (mode === "120000" || mode === "160000") return `forbidden mode ${mode}`;
  }
  return null;
}

// Every commit separately: an intermediate commit touching CI would trigger it in origin even if a later one reverts it.
export async function checkCommits(gitDir: string, base: string, tip: string): Promise<string | null> {
  const commits = (await git(gitDir, ["rev-list", "--reverse", `${base}..${tip}`])).split("\n").filter(Boolean);
  if (!commits.length) return "no new commit";
  if (commits.length > MAX_COMMITS) return `too many commits (${commits.length})`;
  for (const c of commits) {
    if ((await git(gitDir, ["rev-list", "--parents", "-n", "1", c])).split(" ").length > 2) return "merge commit";
    const reason = checkRaw(await git(gitDir, ["diff-tree", "--root", "--no-renames", "-r", "--raw", "-z", "--no-commit-id", c]));
    if (reason) return reason;
  }
  return checkRaw(await git(gitDir, ["diff", "--no-renames", "--raw", "-z", `${base}...${tip}`]));
}

// A review or revise run: the base branch and the PR head. The VM clones `yf-head` and diffs against baseSha, the merge base,
// which is also what a forge shows as the diff of the PR. A review may push nothing; a revise run only its own branch, which
// the orchestrator then pushes to the head branch of the PR.
export async function createReviewRepo(id: string, mirror: string, baseRef: string, prRef: string, pushBranch?: string) {
  const p = path.join(RUNS, `${id}.git`);
  fs.mkdirSync(RUNS, { recursive: true });
  await git(RUNS, ["init", "-q", "--bare", p]);
  fs.writeFileSync(path.join(p, "objects/info/alternates"), path.join(mirror, "objects") + "\n");
  for (const [k, v] of [["http.receivepack", "true"], ["uploadpack.allowFilter", "true"], ["receive.fsckObjects", "true"], ["receive.maxInputSize", "500m"], ["receive.denyDeletes", "true"]]) await git(p, ["config", k, v]);
  await git(p, ["fetch", "-q", mirror, `+refs/heads/${baseRef}:refs/heads/yf-base`, `+${prRef}:refs/heads/yf-head`]);
  fs.writeFileSync(path.join(p, "hooks/pre-receive"), pushBranch
    ? `#!/bin/sh\nwhile read old new ref; do [ "$ref" = "refs/heads/${pushBranch}" ] || { echo "only ${pushBranch} may be pushed" >&2; exit 1; }; done\n`
    : `#!/bin/sh\necho "a review run cannot push" >&2\nexit 1\n`, { mode: 0o755 });
  const headSha = await git(p, ["rev-parse", "refs/heads/yf-head"]);
  const baseSha = await git(p, ["merge-base", "refs/heads/yf-base", "refs/heads/yf-head"]);
  const files = (await git(p, ["diff", "--name-only", "-z", "--no-renames", baseSha, headSha])).split("\0").filter(Boolean);
  return { path: p, baseSha, headSha, files };
}

export async function diffOf(id: string, baseSha: string, headSha: string): Promise<string> {
  const r = await run("git", ["-c", "core.hooksPath=/dev/null", "diff", "--no-color", "--no-ext-diff", "--no-renames", "-U3", baseSha, headSha], { cwd: path.join(RUNS, `${id}.git`), timeout: 120 });
  if (r.code) throw new Error(`git diff exit ${r.code}`);
  return r.stdout.toString();
}

// A file at a ref of the run repository (ref: a sha or a branch name); null when it does not exist.
export async function fileAt(id: string, ref: string, file: string, max = 200_000): Promise<string | null> {
  if (!/^[\w][\w./-]{0,200}$/.test(ref) || ref.includes("..")) return null;
  const r = await run("git", ["-c", "core.hooksPath=/dev/null", "show", `${ref}:${file}`], { cwd: path.join(RUNS, `${id}.git`), timeout: 30 });
  return r.code ? null : r.stdout.subarray(0, max).toString();
}
