// Historie a fronta behu. Webhook i UI chodi pres submit(), takze se v UI ukazou oba.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type Job = {
  project: string; // id projektu z registru
  repo: string;
  issue: { number: number; title: string; body?: string; [k: string]: unknown };
  base: string;
  head: string | null;
  pr: number | null;
};

export type Run = {
  id: string;
  repo: string;
  issue: number;
  title: string;
  kind: "issue" | "iteration";
  runtime: string;
  source: "ui" | "webhook";
  status: "queued" | "running" | "done" | "failed";
  pr: number | null;
  error: string | null; // jen typ chyby, vystup sandboxu sem nepatri
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
};

export class ActiveError extends Error {
  name = "ActiveError";
}

export const MAX_RUNNING = 3;
const KEEP = 200;
let file = "";
let runs: Run[] = [];
let runner: (job: Job, runtime: string, taskId: string) => Promise<number | null>;
const jobs = new Map<string, Job>();
const queue: string[] = [];
let active = 0;

function save() {
  runs = runs.slice(-KEEP);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(runs), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function init(stateFile: string, fn: typeof runner) {
  file = stateFile;
  runner = fn;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { runs = JSON.parse(fs.readFileSync(file, "utf8")); } catch { runs = []; }
  for (const r of runs) {
    if (r.status === "queued" || r.status === "running") {
      Object.assign(r, { status: "failed", error: "Restart", finishedAt: Date.now() });
    }
  }
  save();
}

export const list = () => runs;

export function submit(job: Job, runtime: string, source: Run["source"]): Run {
  if (runs.some((r) => r.repo === job.project && r.issue === job.issue.number && (r.status === "queued" || r.status === "running"))) {
    throw new ActiveError(`${job.project}#${job.issue.number} uz bezi`);
  }
  const run: Run = {
    id: randomBytes(5).toString("hex"), repo: job.project, issue: job.issue.number, title: String(job.issue.title),
    kind: job.pr ? "iteration" : "issue", runtime, source, status: "queued", pr: job.pr, error: null,
    queuedAt: Date.now(), startedAt: null, finishedAt: null,
  };
  runs.push(run);
  jobs.set(run.id, job);
  queue.push(run.id);
  save();
  pump();
  return run;
}

function pump() {
  while (active < MAX_RUNNING && queue.length) void start(queue.shift()!);
}

async function start(id: string) {
  const run = runs.find((r) => r.id === id)!;
  const job = jobs.get(id)!;
  active++;
  Object.assign(run, { status: "running", startedAt: Date.now() });
  save();
  try {
    run.pr = await runner(job, run.runtime, id);
    run.status = "done";
  } catch (e) {
    run.status = "failed";
    run.error = e instanceof Error ? e.name : "Error";
  } finally {
    run.finishedAt = Date.now();
    jobs.delete(id);
    active--;
    save();
    pump();
  }
}
