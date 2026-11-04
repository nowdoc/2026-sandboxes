// What a VM may tell the orchestrator (api/actions.schema.json, api/ACTIONS.md). The VM proposes; this module validates,
// stages and records. Anything that leaves the orchestrator (a forge, S3, the VM) is done through `Deps`, so the rules here
// can be tested without a VM or a forge.
import { createHash } from "node:crypto";
import * as inspect from "./inspect.ts";
import { validate } from "./schema.ts";
import type { Run } from "./runs.ts";

export type ActionType = "comment" | "review_comment" | "review_submit" | "thread_resolve" | "progress" | "artifact" | "finish" |
  "question" | "fetch_context" | "request_domain" | "propose_environment" | "propose_followup";
export type RunKind = "implement" | "review" | "revise" | "inspect" | "verify";
export type Status = "accepted" | "pending" | "rejected" | "duplicate";
export type Result = { id: string; status: Status; code?: string; message?: string; result?: object };
export type Event = { seq: number; type: "action_result" | "answer" | "comment" | "head_changed" | "cancel"; [k: string]: unknown };

export type Thread = { thread_id: string; resolved: boolean; path?: string; line?: number; comments: { author: string; body: string }[] };
export type PrTarget = {
  id: string; title: string; body: string; author: string; url: string;
  baseRef: string; headRef: string; baseSha: string; headSha: string; // baseSha: merge base, the diff is baseSha..headSha
  files: string[]; threads: Thread[];
};

export type Finding = {
  n: number; actionId: string; path: string; line: number; startLine?: number; side: "RIGHT" | "LEFT";
  severity: string; category: string; confidence?: number; body: string; suggestion?: string; fingerprint: string;
  deleted?: boolean; edited?: boolean;
};
export type Review = {
  findings: Finding[];
  comments: { actionId: string; body: string; inReplyTo?: string }[];
  submitted: { actionId: string | null; verdict: "approve" | "request_changes" | "comment"; summary: string } | null;
  published: { url: string; at: number } | null;
};
export type Question = { id: string; question: string; options?: { id: string; label: string }[]; blocking: boolean; expiresAt: number; answered: boolean };
// What a person decided about a pending action; url: what the approval created on the forge.
export type Decision = { status: "approved" | "rejected"; note?: string; url?: string; at: number };
export type Acts = {
  seq: number; count: number; events: Event[]; seen: Record<string, Result>;
  progress?: { phase: string; message: string; percent?: number; at: number };
  finish?: { outcome: string; summary: string; pull_request?: { title: string; body: string }; blocked_on?: string };
  questions: Question[];
  domains: { id: string; domains: string[]; reason: string; decision?: Decision }[];
  followups: { id: string; title: string; body: string; kind: string; path?: string; decision?: Decision }[];
  resolves: { id: string; thread_id: string; resolution: string; commit_sha?: string; note?: string; decision?: Decision }[];
  comments: { id: string; body: string; inReplyTo?: string; decision?: Decision }[]; // runs other than review; a review keeps them in its draft
  artifacts: string[]; // S3 keys
};

// Pending actions a person approves or rejects, and where each kind is kept.
const DECIDABLE = { request_domain: "domains", propose_followup: "followups", thread_resolve: "resolves", comment: "comments" } as const;
export type Decidable = keyof typeof DECIDABLE;
export type Request = Acts[(typeof DECIDABLE)[Decidable]][number];

// Which action types a run kind may send. `capabilities` of GET /yf/context is this list.
const BASIC: ActionType[] = ["progress", "finish"];
export const CAPS: Record<RunKind, ActionType[]> = {
  implement: [...BASIC, "comment", "artifact", "question", "fetch_context", "request_domain", "propose_followup"],
  review: [...BASIC, "comment", "review_comment", "review_submit", "artifact", "question", "fetch_context", "propose_followup"],
  revise: [...BASIC, "comment", "thread_resolve", "artifact", "question", "fetch_context", "request_domain", "propose_followup"],
  inspect: [...BASIC, "question", "request_domain", "propose_environment"],
  verify: [...BASIC, "artifact"],
};
const ALL = [...new Set(Object.values(CAPS).flat())];
export const LIMITS = { max_actions: 200, max_review_comments: 50, max_body_chars: 20_000, max_artifact_bytes: 262_144, max_artifact_pull_bytes: 10 * 1024 * 1024 };
const MAX_EVENTS = 200, MAX_QUESTIONS = 10, MAX_CONTEXT_BYTES = 200_000;

export const kindOf = (run: Run): RunKind => run.kind ?? "implement";

export type Deps = {
  // Lines that are part of the diff of the run, per path and side; null: no diff for this run.
  diff: (run: Run) => Promise<Map<string, { RIGHT: Set<number>; LEFT: Set<number> }> | null>;
  fetch: (run: Run, q: any) => Promise<object>;
  putArtifact: (run: Run, name: string, data: Buffer, type: string) => Promise<string>;
  pullFile: (run: Run, vmPath: string, max: number) => Promise<Buffer>;
  publish: (run: Run) => Promise<string>; // review, auto mode
  autoPublish: (run: Run) => boolean;
};

export function acts(run: Run): Acts {
  const a = run.acts ??= { seq: 0, count: 0, events: [], seen: {}, questions: [], domains: [], followups: [], resolves: [], comments: [], artifacts: [] };
  a.comments ??= []; // runs saved before comments were kept
  return a;
}
export const review = (run: Run): Review => run.review ??= { findings: [], comments: [], submitted: null, published: null };

// --- sanitising: everything the VM writes is untrusted text that ends up on a forge ---
const SECRETS = [
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g, /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g, /\bsk-[A-Za-z0-9_-]{20,}\b/g, /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{24,}/g,
];
export function clean(text: string): string {
  let t = text.replace(/\r\n/g, "\n");
  for (const r of SECRETS) t = t.replace(r, "[redacted]");
  return t
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")                       // images load remote content when rendered
    .replace(/\[([^\]]*)\]\(\s*[a-z][a-z0-9+.-]*:[^)]*\)/gi, "$1")  // links with a scheme: keep the text only
    .replace(/<(\/?[a-z!][^>]*)>/gi, "&lt;$1&gt;")                  // raw html
    .replace(/(^|[^\w`])@([A-Za-z0-9_-]+)/g, "$1@​$2")         // no mentions
    .replace(/\bhttps?:\/\/\S+/gi, (u) => u.replace(/^https?:\/\//i, "").replace(/\./g, ".​")); // bare URLs do not become links
}

// --- diff anchors ---
export function parseDiff(diff: string): Map<string, { RIGHT: Set<number>; LEFT: Set<number> }> {
  type Lines = { RIGHT: Set<number>; LEFT: Set<number> };
  const out = new Map<string, Lines>();
  const entry = (p: string) => out.get(p) ?? out.set(p, { RIGHT: new Set(), LEFT: new Set() }).get(p)!;
  let cur: Lines | null = null, oldPath = "", l = 0, r = 0, lLeft = 0, rLeft = 0;
  for (const line of diff.split("\n")) {
    // Inside a hunk the counts of the @@ header decide what a line is: a deleted "-- x" looks like a file header.
    if (lLeft > 0 || rLeft > 0) {
      if (line.startsWith("+")) { cur?.RIGHT.add(r); r++; rLeft--; }
      else if (line.startsWith("-")) { cur?.LEFT.add(l); l++; lLeft--; }
      else if (line.startsWith(" ") || line === "") { cur?.RIGHT.add(r); cur?.LEFT.add(l); r++; l++; rLeft--; lLeft--; }
      continue; // "\ No newline at end of file" is not counted
    }
    if (line.startsWith("--- ")) { oldPath = line.slice(4).replace(/^a\//, ""); cur = null; continue; }
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).replace(/^b\//, "");
      cur = p === "/dev/null" ? (oldPath && oldPath !== "/dev/null" ? entry(oldPath) : null) : entry(p);
      continue;
    }
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) { l = Number(h[1]); lLeft = h[2] === undefined ? 1 : Number(h[2]); r = Number(h[3]); rLeft = h[4] === undefined ? 1 : Number(h[4]); }
  }
  return out;
}

const fp = (f: { path: string; side: string; category: string; body: string }) =>
  createHash("sha256").update([f.path, f.side, f.category, f.body.toLowerCase().replace(/\W+/g, " ").trim().slice(0, 120)].join("\0")).digest("hex").slice(0, 16);

export function pushEvent(run: Run, ev: Omit<Event, "seq">) {
  const a = acts(run);
  a.events.push({ ...ev, seq: ++a.seq } as Event);
  if (a.events.length > MAX_EVENTS) a.events.splice(0, a.events.length - MAX_EVENTS);
  for (const w of waiters.get(run.id) ?? []) w();
}

const waiters = new Map<string, Set<() => void>>();

// Long poll: events after `after`, waiting up to `waitMs` for the first one.
export async function events(run: Run, after: number, waitMs: number): Promise<Event[]> {
  const get = () => acts(run).events.filter((e) => e.seq > after);
  if (get().length || waitMs <= 0) return get();
  await new Promise<void>((resolve) => {
    const set = waiters.get(run.id) ?? waiters.set(run.id, new Set()).get(run.id)!;
    const done = () => { clearTimeout(t); set.delete(done); resolve(); };
    const t = setTimeout(done, waitMs);
    set.add(done);
  });
  return get();
}

export function context(run: Run) {
  const kind = kindOf(run), t = run.target;
  return {
    run: { id: run.id, kind, repo: run.repo, ...(run.baseSha && { base_sha: run.baseSha }), ...(t && { head_sha: t.headSha }) },
    ...(t && {
      input: {
        pull_request: {
          id: t.id, title: t.title, body: t.body, author: t.author, url: t.url, base_ref: t.baseRef, head_ref: t.headRef,
          changed_files: t.files, threads: t.threads,
        },
      },
    }),
    capabilities: CAPS[kind],
    limits: LIMITS,
  };
}

const done = (id: string, status: Status, extra: Partial<Result> = {}): Result => ({ id, status, ...extra });
const reject = (id: string, code: string, message: string): Result => ({ id, status: "rejected", code, message });

// Returns the result of one action. Never throws for a bad action; a failing dependency is the caller's error.
export async function handle(run: Run, raw: unknown, d: Deps): Promise<Result> {
  const id = typeof (raw as any)?.id === "string" ? (raw as any).id : "";
  const idOk = /^[A-Za-z0-9_-]{8,64}$/.test(id), a = acts(run);
  if (idOk && a.seen[id]) return done(id, "duplicate", { result: a.seen[id] });
  const remember = (r: Result) => { a.seen[id] = r; return r; };
  // A type the run may not send is refused before its payload is looked at: the payload would be checked against a schema that does not apply.
  const t = (raw as any)?.type;
  if (idOk && ALL.includes(t) && !CAPS[kindOf(run)].includes(t)) return remember(reject(id, "not_allowed_for_kind", `${t} is not allowed in a ${kindOf(run)} run`));
  const bad = validate("Action", raw);
  if (bad) return reject(idOk ? id : "invalid00", "invalid_payload", bad);
  const { type, payload } = raw as { type: ActionType; payload: any };
  if (a.count >= LIMITS.max_actions) return reject(id, "limit_exceeded", `at most ${LIMITS.max_actions} actions per run`);
  a.count++;
  let r: Result;
  try { r = await dispatch(run, id, type, payload, d); } catch (e) {
    // A failing dependency (forge, S3, VM) is not the agent's fault and the action may be retried: not remembered.
    a.count--;
    throw e;
  }
  return remember(r);
}

async function dispatch(run: Run, id: string, type: ActionType, p: any, d: Deps): Promise<Result> {
  const a = acts(run), rv = review(run);
  switch (type) {
    case "progress":
      a.progress = { phase: p.phase, message: clean(p.message).slice(0, 500), ...(p.percent !== undefined && { percent: p.percent }), at: Date.now() };
      return done(id, "accepted");

    case "finish":
      a.finish = { outcome: p.outcome, summary: clean(p.summary), ...(p.pull_request && { pull_request: { title: clean(p.pull_request.title), body: clean(p.pull_request.body) } }), ...(p.blocked_on && { blocked_on: clean(p.blocked_on) }) };
      return done(id, "accepted");

    case "review_comment": {
      if (rv.submitted) return reject(id, "already_submitted", "the review was already submitted");
      if (rv.findings.filter((f) => !f.deleted).length >= LIMITS.max_review_comments) return reject(id, "limit_exceeded", `at most ${LIMITS.max_review_comments} review comments`);
      const side: "RIGHT" | "LEFT" = p.side ?? "RIGHT";
      if (p.start_line !== undefined && p.start_line > p.line) return reject(id, "invalid_payload", "start_line must be <= line");
      const lines = (await d.diff(run))?.get(p.path)?.[side];
      if (!lines) return reject(id, "invalid_anchor", `${p.path} has no ${side} lines in the diff`);
      for (const n of [p.start_line ?? p.line, p.line]) if (!lines.has(n)) return reject(id, "invalid_anchor", `line ${n} of ${p.path} (${side}) is not part of the diff`);
      const body = clean(p.body);
      const f: Finding = { n: Math.max(0, ...rv.findings.map((x) => x.n)) + 1, actionId: id, path: p.path, line: p.line, ...(p.start_line !== undefined && { startLine: p.start_line }), side,
        severity: p.severity, category: p.category, ...(p.confidence !== undefined && { confidence: p.confidence }), body, ...(p.suggestion !== undefined && { suggestion: p.suggestion.replace(/\r\n/g, "\n") }), fingerprint: "" };
      f.fingerprint = fp({ path: f.path, side, category: f.category, body });
      const same = rv.findings.find((x) => x.fingerprint === f.fingerprint && !x.deleted);
      if (same) return reject(id, "conflict", `the same finding is already staged (#${same.n})`);
      rv.findings.push(f);
      return done(id, "accepted", { result: { finding: f.n } });
    }

    case "comment":
      if (p.target === "ticket") return reject(id, "invalid_payload", "this run has no ticket");
      if (kindOf(run) === "review") {
        if (rv.submitted) return reject(id, "already_submitted", "the review was already submitted");
        rv.comments.push({ actionId: id, body: clean(p.body), ...(p.in_reply_to && { inReplyTo: p.in_reply_to }) });
        return done(id, d.autoPublish(run) ? "accepted" : "pending");
      }
      a.comments.push({ id, body: clean(p.body), ...(p.in_reply_to && { inReplyTo: p.in_reply_to }) });
      return done(id, "pending", { message: "waits for a person to post it" });

    case "review_submit": {
      if (rv.submitted) return reject(id, "already_submitted", "review_submit was already sent");
      rv.submitted = { actionId: id, verdict: p.verdict, summary: clean(p.summary) };
      if (!d.autoPublish(run)) return done(id, "pending", { message: "waiting for a person to publish the draft" });
      return done(id, "accepted", { result: { url: await d.publish(run) } });
    }

    case "thread_resolve":
      a.resolves.push({ id, thread_id: p.thread_id, resolution: p.resolution, ...(p.commit_sha && { commit_sha: p.commit_sha }), ...(p.note && { note: clean(p.note) }) });
      return done(id, "pending");

    case "artifact": {
      let data: Buffer;
      if (p.vm_path !== undefined) {
        if (/(^|\/)\.\.(\/|$)/.test(p.vm_path)) return reject(id, "invalid_payload", "vm_path must not contain ..");
        try { data = await d.pullFile(run, p.vm_path, LIMITS.max_artifact_pull_bytes); } catch (e: any) {
          if (e?.name === "NotFound") return reject(id, "not_found", String(e.message).slice(0, 300));
          throw e;
        }
        if (data.length > LIMITS.max_artifact_pull_bytes) return reject(id, "limit_exceeded", `file is larger than ${LIMITS.max_artifact_pull_bytes} bytes`);
      } else {
        if (p.encoding === "base64" && !/^[A-Za-z0-9+/]*={0,2}$/.test(p.content)) return reject(id, "invalid_payload", "content is not valid base64");
        data = Buffer.from(p.content, p.encoding === "base64" ? "base64" : "utf8");
        if (data.length > LIMITS.max_artifact_bytes) return reject(id, "limit_exceeded", `inline content is larger than ${LIMITS.max_artifact_bytes} bytes, use vm_path`);
      }
      const key = await d.putArtifact(run, p.name, data, p.media_type);
      if (!a.artifacts.includes(key)) a.artifacts.push(key);
      return done(id, "accepted", { result: { key } });
    }

    case "question": {
      if (a.questions.filter((q) => !q.answered).length >= MAX_QUESTIONS) return reject(id, "limit_exceeded", `at most ${MAX_QUESTIONS} open questions`);
      if (p.options && new Set(p.options.map((o: any) => o.id)).size !== p.options.length) return reject(id, "invalid_payload", "option ids must be unique");
      a.questions.push({ id, question: clean(p.question), ...(p.options && { options: p.options.map((o: any) => ({ id: o.id, label: clean(o.label) })) }), blocking: p.blocking ?? true, expiresAt: Date.now() + (p.timeout_s ?? 3600) * 1000, answered: false });
      return done(id, "pending");
    }

    case "fetch_context": {
      if (p.what === "file_at_ref" && (!p.path || !p.ref)) return reject(id, "invalid_payload", "file_at_ref needs ref and path");
      if ((p.what === "pull_request" || p.what === "ticket" || p.what === "ci_status") && !p.ref && !run.target) return reject(id, "invalid_payload", `${p.what} needs ref`);
      let data: object;
      try { data = await d.fetch(run, p); } catch (e: any) {
        if (e?.name === "NotFound") return reject(id, "not_found", String(e.message).slice(0, 300));
        throw e;
      }
      if (JSON.stringify(data).length > MAX_CONTEXT_BYTES) return reject(id, "limit_exceeded", "the answer is too large, ask for less");
      return done(id, "accepted", { result: data });
    }

    case "request_domain":
      a.domains.push({ id, domains: p.domains, reason: clean(p.reason) });
      return done(id, "pending", { message: "needs a person; the allowlist is changed by an operator, not during this run" });

    case "propose_environment": {
      const parsed = inspect.parse(JSON.stringify(p));
      if (typeof parsed === "string") return reject(id, "invalid_payload", parsed);
      run.proposal = parsed;
      return done(id, "accepted");
    }

    case "propose_followup":
      a.followups.push({ id, title: clean(p.title).slice(0, 200), body: clean(p.body), kind: p.kind, ...(p.path && { path: p.path }) });
      return done(id, "pending", { message: "kept as a suggestion; a ticket is created only if a person approves it" });
  }
}

export function requests(run: Run): (Request & { type: Decidable })[] {
  const a = acts(run);
  return (Object.entries(DECIDABLE) as [Decidable, (typeof DECIDABLE)[Decidable]][]).flatMap(([type, k]) => (a[k] as Request[]).map((x) => ({ type, ...x })));
}

// A person approves or rejects a pending action. `effect` runs first on approval (it may post to the forge) and may return
// the url of what it created; if it throws, nothing is recorded and the person can try again. The VM gets an action_result event.
export async function decide(run: Run, actionId: string, approve: boolean, note: string | undefined, effect: (type: Decidable, item: Request) => Promise<string | undefined>): Promise<string | null> {
  const a = acts(run);
  for (const [type, k] of Object.entries(DECIDABLE) as [Decidable, (typeof DECIDABLE)[Decidable]][]) {
    const item = (a[k] as Request[]).find((x) => x.id === actionId);
    if (!item) continue;
    if (item.decision) return "already decided";
    const url = approve ? await effect(type, item) : undefined;
    const text = note?.trim().slice(0, 2000);
    item.decision = { status: approve ? "approved" : "rejected", ...(text && { note: text }), ...(url && { url }), at: Date.now() };
    const message = [approve ? (url ? `done: ${url}` : "approved") : "rejected", text].filter(Boolean).join(": ").slice(0, 500);
    pushEvent(run, { type: "action_result", action_id: actionId, status: approve ? "accepted" : "rejected", message });
    return null;
  }
  return "no such request";
}

// A person answers a question of the VM; the answer goes out as an event.
export function answer(run: Run, questionId: string, input: { option_id?: string; text?: string }): string | null {
  const q = acts(run).questions.find((x) => x.id === questionId);
  if (!q) return "no such question";
  if (q.answered) return "already answered";
  if (Date.now() > q.expiresAt) return "the question expired";
  if (input.option_id !== undefined && !q.options?.some((o) => o.id === input.option_id)) return "unknown option";
  if (input.option_id === undefined && !input.text?.trim()) return "an option or a text is required";
  q.answered = true;
  pushEvent(run, { type: "answer", question_id: questionId, ...(input.option_id !== undefined && { option_id: input.option_id }), ...(input.text && { text: input.text.slice(0, 5000) }), untrusted: true });
  return null;
}
