import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "./config.ts";
import type { Proposal } from "./inspect.ts";
import type { Acts, PrTarget, Review } from "./actions.ts";

export type Run = {
  id: string;
  repo: string;
  base: string;
  branch: string;
  prompt: string;
  model: string | null;
  environment: string;
  envSetup: string; // environment scripts, copied so a run does not change when the environment is edited
  maintenance: string;
  setup: string;
  env: Record<string, string>;
  keep: boolean; // VM stays after the run for the terminal
  // inspect: the agent proposes environment changes; verify: setup only, after a proposal was applied; review: findings on a PR,
  // no push; revise: the agent addresses the review threads of a PR and its commits go to the head branch of that PR
  kind?: "inspect" | "verify" | "review" | "revise";
  target?: PrTarget | null; // review, revise: the PR
  review?: Review | null; // review: staged findings and the draft
  acts?: Acts; // actions the VM sent (api/actions.schema.json)
  proposal?: Proposal | null;
  applied?: ("repository" | "environment")[];
  status: "queued" | "running" | "ready" | "done" | "failed";
  vm: string | null;
  tokenHash: string | null;
  llmKey: string | null; // virtual LiteLLM key, only in runs.json, never sent to the UI, S3 or the VM
  baseSha: string | null;
  pr: string | null;
  error: string | null; // type and short reason only, never VM output
  sessions: string[]; // S3 keys
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
};

const FILE = path.join(CFG.data, "runs.json");
const KEEP = 500;
let runs: Run[] = [];

export function save() {
  runs = runs.slice(-KEEP);
  fs.writeFileSync(FILE + ".tmp", JSON.stringify(runs, null, 1), { mode: 0o600 });
  fs.renameSync(FILE + ".tmp", FILE);
}

// VMs live in the sandbox service and survive an orchestrator restart, an interrupted run does not.
export function load(alive: Set<string>) {
  fs.mkdirSync(CFG.data, { recursive: true });
  try { runs = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { runs = []; }
  for (const r of runs) {
    // Runs saved before the field was renamed.
    const old = r as Run & { sandbox?: string | null };
    if ("sandbox" in old) { r.vm = old.sandbox ?? null; delete old.sandbox; }
    if (r.vm && !alive.has(r.vm)) r.vm = null;
    if (r.status === "queued" || r.status === "running") Object.assign(r, { status: "failed", error: "restart", finishedAt: Date.now() });
    if (r.status === "ready" && !r.vm) r.status = "done";
  }
  save();
}

export const all = () => runs;
export const get = (id: string) => runs.find((r) => r.id === id);

export function add(fields: Pick<Run, "repo" | "base" | "prompt" | "model" | "keep" | "environment" | "envSetup" | "maintenance" | "setup" | "env"> & Pick<Run, "kind"> & Partial<Pick<Run, "target">>): Run {
  const id = randomBytes(4).toString("hex");
  const run: Run = {
    ...fields, id, branch: `yfactory/${id}`, status: "queued", vm: null, tokenHash: null, llmKey: null, baseSha: null, pr: null, error: null,
    sessions: [], createdAt: Date.now(), startedAt: null, finishedAt: null,
  };
  runs.push(run);
  save();
  return run;
}

export function update(run: Run, fields: Partial<Run>) {
  Object.assign(run, fields);
  save();
}

const queue: string[] = [];
let active = 0;
export const queueState = () => ({ queued: queue.length, active });
let worker: (run: Run) => Promise<void>;

export function setWorker(fn: typeof worker) {
  worker = fn;
}

export function dequeue(id: string) {
  const i = queue.indexOf(id);
  if (i >= 0) queue.splice(i, 1);
  return i >= 0;
}

export function enqueue(run: Run) {
  queue.push(run.id);
  pump();
}

function pump() {
  while (active < CFG.maxRunning && queue.length) {
    const run = get(queue.shift()!)!;
    active++;
    worker(run).finally(() => { active--; pump(); });
  }
}
