// Unit tests of the sandbox actions API, no deployment needed: node --test yfactory/tests/actions.test.ts
// Covers the schema validator, the rules of every action, the diff anchors, the forge requests of the three providers
// (against a local stub, so they show what we send, not what GitHub, Forgejo or GitLab accept) and a real git review repository.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const O = path.join(HERE, "..", "orchestrator");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yf-actions-"));
fs.mkdirSync(path.join(tmp, "config"));
fs.writeFileSync(path.join(tmp, "config/yfactory.json"), "{}");
fs.writeFileSync(path.join(tmp, "config/opencode.json"), JSON.stringify({ provider: { litellm: { models: { m: {} } } } }));
Object.assign(process.env, { YF_CONFIG: path.join(tmp, "config"), YF_DATA: path.join(tmp, "data"), LITELLM_MASTER_KEY: "x", S3_ACCESS_KEY: "x", S3_SECRET_KEY: "x", SANDBOX_TOKEN: "x" });

const schema = await import(path.join(O, "schema.ts"));
const act = await import(path.join(O, "actions.ts"));
const rev = await import(path.join(O, "review.ts"));
const svc = await import(path.join(O, "services.ts"));
const git = await import(path.join(O, "git.ts"));
const yf = await import(path.join(O, "yf.ts"));
const runs = await import(path.join(O, "runs.ts"));
const examples = JSON.parse(fs.readFileSync(path.join(O, "api/examples.json"), "utf8"));

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@
 one
-two
+two changed
+two more
 three
 four
`;
const lines = act.parseDiff(DIFF);
const deps = (over: Record<string, unknown> = {}) => ({
  diff: async () => lines, fetch: async () => ({ ok: true }), putArtifact: async (_r: unknown, n: string) => `k/${n}`,
  pullFile: async () => Buffer.from("x"), publish: async () => "https://forge/r/1", autoPublish: () => false, ...over,
});
const mkRun = (kind?: string, extra: Record<string, unknown> = {}): any => ({ id: "r1", repo: "o/r", kind, vm: "yf-r1", target: kind === "review" ? { id: "1", title: "t", body: "b", author: "a", url: "u", baseRef: "main", headRef: "f", baseSha: "a".repeat(40), headSha: "b".repeat(40), files: ["src/a.ts"], threads: [] } : null, ...extra });
let n = 0;
const A = (type: string, payload: object, id = `act${String(++n).padStart(6, "0")}x`) => ({ id, type, payload });
const RC = { path: "src/a.ts", line: 2, severity: "major", category: "bug", body: "x is wrong" };

describe("schema validator", () => {
  it("accepts the valid examples and rejects the invalid ones", () => {
    for (const a of examples.valid) assert.equal(schema.validate("Action", a), null, a.id);
    for (const i of examples.invalid) assert.notEqual(schema.validate("Action", i.action), null, i.why);
  });
  it("reports the alternative of the given type, not the first one", () => {
    assert.match(schema.validate("Action", A("finish", { verdict: "approve" })), /outcome is required/);
  });
  it("checks results, events and context", () => {
    assert.equal(schema.validate("ActionResult", { id: "a0000001", status: "rejected", code: "invalid_anchor", message: "m" }), null);
    assert.notEqual(schema.validate("ActionResult", { id: "a0000001", status: "rejected" }), null); // rejected needs code and message
    assert.equal(schema.validate("Event", { seq: 1, type: "comment", thread_id: "t", author: "a", body: "b", untrusted: true }), null);
    assert.notEqual(schema.validate("Event", { seq: 1, type: "comment", thread_id: "t", author: "a", body: "b" }), null); // untrusted is required
  });
  it("what the orchestrator sends validates against its own schema", () => {
    assert.equal(schema.validate("Context", act.context(mkRun("review"))), null);
    for (const k of ["implement", "revise", "inspect", "verify"]) assert.equal(schema.validate("Context", act.context(mkRun(k === "implement" ? undefined : k))), null, k);
  });
});

describe("diff anchors", () => {
  it("lists added and context lines of the new file and removed and context lines of the old one", () => {
    assert.deepEqual([...lines.get("src/a.ts").RIGHT], [1, 2, 3, 4, 5]);
    assert.deepEqual([...lines.get("src/a.ts").LEFT], [1, 2, 3, 4]);
  });
  it("does not take a removed line that starts with -- for a file header", () => {
    const m = act.parseDiff("--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1,2 @@\n--- old comment\n+-- new\n b\n");
    assert.deepEqual([...m.get("q.sql").LEFT], [1, 2]);
    assert.deepEqual([...m.get("q.sql").RIGHT], [1, 2]);
    assert.equal(m.size, 1);
  });
  it("keeps the old path for a deleted file", () => {
    const m = act.parseDiff("--- a/gone.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n");
    assert.deepEqual([...m.get("gone.txt").LEFT], [1, 2]);
  });
});

describe("sanitising", () => {
  it("removes what a forge would render or notify", () => {
    const t = act.clean("![x](http://evil/p.png) [link](https://evil/x) ping @alice <img src=x> see https://evil.example/a?b=1");
    assert.doesNotMatch(t, /!\[|\]\(|<img|https?:\/\//);
    assert.match(t, /@​alice/);
  });
  it("redacts tokens and private keys", () => {
    const t = act.clean(`ghp_${"a".repeat(36)} glpat-${"b".repeat(20)} AKIAABCDEFGHIJKLMNOP -----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY----- Bearer ${"c".repeat(30)}`);
    assert.doesNotMatch(t, /ghp_|glpat-|AKIA|MIIE|Bearer c/);
    assert.equal((t.match(/\[redacted\]/g) ?? []).length, 5);
  });
  it("keeps code", () => assert.equal(act.clean("use `a == b` and\n```ts\nx\n```"), "use `a == b` and\n```ts\nx\n```"));
});

describe("actions", () => {
  it("allows per run kind only what ACTIONS.md lists", async () => {
    const matrix: Record<string, string[]> = {
      review: ["review_comment", "review_submit"], inspect: ["propose_environment"], verify: ["artifact"], revise: ["thread_resolve"],
    };
    for (const [kind, ok] of Object.entries(matrix)) assert.ok(ok.every((t) => act.CAPS[kind].includes(t)), kind);
    const r = await act.handle(mkRun("verify"), A("review_comment", RC), deps());
    assert.equal(r.code, "not_allowed_for_kind");
    assert.equal((await act.handle(mkRun(), A("review_submit", { verdict: "comment", summary: "s" }), deps())).code, "not_allowed_for_kind");
    assert.equal((await act.handle(mkRun("review"), A("propose_environment", {}), deps())).code, "not_allowed_for_kind");
  });
  it("is idempotent by action id", async () => {
    const run = mkRun("review"), a = A("progress", { phase: "reviewing", message: "m" });
    assert.equal((await act.handle(run, a, deps())).status, "accepted");
    const again = await act.handle(run, a, deps());
    assert.equal(again.status, "duplicate");
    assert.equal(again.result.status, "accepted");
    assert.equal(run.acts.count, 1);
  });
  it("returns invalid_payload with the reason instead of throwing", async () => {
    const r = await act.handle(mkRun("review"), A("review_comment", { ...RC, line: 0 }), deps());
    assert.equal(r.status, "rejected"); assert.equal(r.code, "invalid_payload"); assert.match(r.message, /line/);
    assert.equal((await act.handle(mkRun("review"), { type: "x" }, deps())).code, "invalid_payload");
  });
  it("stages an inline finding on a line of the diff and rejects other anchors", async () => {
    const run = mkRun("review");
    assert.equal((await act.handle(run, A("review_comment", RC), deps())).status, "accepted");
    assert.equal((await act.handle(run, A("review_comment", { ...RC, line: 99, body: "other" }), deps())).code, "invalid_anchor");
    assert.equal((await act.handle(run, A("review_comment", { ...RC, path: "nope.ts", body: "other" }), deps())).code, "invalid_anchor");
    assert.equal((await act.handle(run, A("review_comment", { ...RC, side: "LEFT", line: 2, body: "removed line" }), deps())).status, "accepted");
    assert.equal((await act.handle(run, A("review_comment", { ...RC, start_line: 5, line: 3, body: "range" }), deps())).code, "invalid_payload");
    assert.equal(run.review.findings.length, 2);
  });
  it("rejects the same finding twice but not after the first was deleted", async () => {
    const run = mkRun("review");
    await act.handle(run, A("review_comment", RC), deps());
    const dup = await act.handle(run, A("review_comment", { ...RC, body: "X is wrong!" }), deps());
    assert.equal(dup.code, "conflict");
    run.review.findings[0].deleted = true;
    assert.equal((await act.handle(run, A("review_comment", RC), deps())).status, "accepted");
  });
  it("limits the review comments", async () => {
    const run = mkRun("review");
    for (let i = 0; i < act.LIMITS.max_review_comments; i++) assert.equal((await act.handle(run, A("review_comment", { ...RC, body: `problem number ${i} here` }), deps())).status, "accepted");
    assert.equal((await act.handle(run, A("review_comment", { ...RC, body: "one too many" }), deps())).code, "limit_exceeded");
  });
  it("limits the number of actions per run", async () => {
    const run = mkRun("review");
    run.acts = { seq: 0, count: act.LIMITS.max_actions, events: [], seen: {}, questions: [], domains: [], followups: [], resolves: [], artifacts: [] };
    assert.equal((await act.handle(run, A("progress", { phase: "setup", message: "m" }), deps())).code, "limit_exceeded");
  });
  it("sanitises what it stages", async () => {
    const run = mkRun("review");
    await act.handle(run, A("review_comment", { ...RC, body: `![x](http://e/p.png) token ghp_${"a".repeat(36)}` }), deps());
    assert.doesNotMatch(run.review.findings[0].body, /http|ghp_/);
  });
  it("draft: review_submit waits for a person, once; auto: publishes at once", async () => {
    const run = mkRun("review"), s = { verdict: "request_changes", summary: "see inline" };
    const r = await act.handle(run, A("review_submit", s), deps());
    assert.equal(r.status, "pending");
    assert.equal(run.review.submitted.verdict, "request_changes");
    assert.equal((await act.handle(run, A("review_submit", s), deps())).code, "already_submitted");
    assert.equal((await act.handle(run, A("review_comment", RC), deps())).code, "already_submitted");
    const auto = mkRun("review");
    const ar = await act.handle(auto, A("review_submit", s), deps({ autoPublish: () => true }));
    assert.equal(ar.status, "accepted"); assert.equal(ar.result.url, "https://forge/r/1");
  });
  it("a failing dependency is not remembered, so the same id can be retried", async () => {
    const run = mkRun("review"), a = A("fetch_context", { what: "pull_request", ref: "1" });
    await assert.rejects(act.handle(run, a, deps({ fetch: async () => { throw new Error("forge down"); } })));
    assert.equal(run.acts.count, 0);
    assert.equal((await act.handle(run, a, deps())).status, "accepted");
  });
  it("fetch_context: NotFound becomes not_found, too large becomes limit_exceeded", async () => {
    const nf = Object.assign(new Error("nope"), { name: "NotFound" });
    assert.equal((await act.handle(mkRun("review"), A("fetch_context", { what: "ticket", ref: "1" }), deps({ fetch: async () => { throw nf; } }))).code, "not_found");
    assert.equal((await act.handle(mkRun("review"), A("fetch_context", { what: "comments", ref: "1" }), deps({ fetch: async () => ({ x: "y".repeat(300_000) }) }))).code, "limit_exceeded");
    assert.equal((await act.handle(mkRun("review"), A("fetch_context", { what: "file_at_ref", ref: "head" }), deps())).code, "invalid_payload");
  });
  it("artifact: inline limit, base64, vm_path pulled, missing file", async () => {
    const run = mkRun("review");
    assert.equal((await act.handle(run, A("artifact", { name: "a.txt", media_type: "text/plain", content: "hi" }), deps())).result.key, "k/a.txt");
    assert.equal((await act.handle(run, A("artifact", { name: "b.txt", media_type: "text/plain", content: "x".repeat(262_145) }), deps())).code, "limit_exceeded");
    assert.equal((await act.handle(run, A("artifact", { name: "c.bin", media_type: "application/octet-stream", encoding: "base64", content: "not base64!" }), deps())).code, "invalid_payload");
    assert.equal((await act.handle(run, A("artifact", { name: "d.txt", media_type: "text/plain", vm_path: "/workspace/a/../../etc/x" }), deps())).code, "invalid_payload");
    const nf = Object.assign(new Error("gone"), { name: "NotFound" });
    assert.equal((await act.handle(run, A("artifact", { name: "e.txt", media_type: "text/plain", vm_path: "/workspace/e" }), deps({ pullFile: async () => { throw nf; } }))).code, "not_found");
    assert.equal((await act.handle(run, A("artifact", { name: "f.txt", media_type: "text/plain", vm_path: "/workspace/f" }), deps({ pullFile: async () => Buffer.alloc(act.LIMITS.max_artifact_pull_bytes + 1) }))).code, "limit_exceeded");
    assert.deepEqual(run.acts.artifacts, ["k/a.txt"]);
  });
  it("inspect: propose_environment replaces the proposal file and keeps its checks", async () => {
    const run = mkRun("inspect");
    const ok = { summary: "node missing", repository: { setup: "npm ci", env: { CI: "1" } }, environment: null, allowlist: ["registry.npmjs.org"] };
    assert.equal((await act.handle(run, A("propose_environment", ok), deps())).status, "accepted");
    assert.equal(run.proposal.repository.setup, "npm ci");
    const r = await act.handle(run, A("propose_environment", { ...ok, repository: { setup: "x", env: { GIT_DIR: "/x" } } }), deps());
    assert.equal(r.status, "accepted"); // reserved names are checked again when a part is applied, as before
  });
  it("question: the answer comes back as an event, once, only for a known option", async () => {
    const run = mkRun("review"), q = A("question", { question: "retry on 429?", options: [{ id: "y", label: "yes" }, { id: "n", label: "no" }] });
    assert.equal((await act.handle(run, q, deps())).status, "pending");
    assert.equal(act.answer(run, q.id, { option_id: "z" }), "unknown option");
    assert.equal(act.answer(run, q.id, {}), "an option or a text is required");
    assert.equal(act.answer(run, q.id, { option_id: "y" }), null);
    assert.equal(act.answer(run, q.id, { option_id: "y" }), "already answered");
    const [ev] = await act.events(run, 0, 0);
    assert.equal(ev.type, "answer"); assert.equal(ev.untrusted, true);
    assert.equal(schema.validate("Event", ev), null);
    assert.equal(act.answer(run, "nonexistent", { text: "x" }), "no such question");
  });
  it("question: an expired question cannot be answered", async () => {
    const run = mkRun("review"), q = A("question", { question: "q" });
    await act.handle(run, q, deps());
    run.acts.questions[0].expiresAt = Date.now() - 1;
    assert.equal(act.answer(run, q.id, { text: "late" }), "the question expired");
  });
  it("request_domain and propose_followup are kept, never applied", async () => {
    const run = mkRun("revise");
    const d = await act.handle(run, A("request_domain", { domains: ["registry.npmjs.org"], reason: "needs it" }), deps());
    assert.equal(d.status, "pending"); assert.match(d.message, /changed by an operator/);
    assert.equal((await act.handle(run, A("propose_followup", { title: "t", body: "b", kind: "bug" }), deps())).status, "pending");
    assert.equal(run.acts.domains.length, 1); assert.equal(run.acts.followups.length, 1);
  });
});

describe("decisions of a person on pending actions", () => {
  it("approve runs the effect, keeps its url and tells the VM; reject only tells the VM", async () => {
    const run = mkRun("revise");
    const c = A("comment", { target: "pull_request", body: "Fixed in the last commit @bob", in_reply_to: "501" });
    assert.equal((await act.handle(run, c, deps())).status, "pending");
    const f = A("propose_followup", { title: "t", body: "b", kind: "bug" });
    await act.handle(run, f, deps());
    assert.deepEqual(act.requests(run).map((x: any) => x.type), ["propose_followup", "comment"]);
    assert.match(run.acts.comments[0].body, /@​bob/, "kept sanitised");
    const seen: string[] = [];
    assert.equal(await act.decide(run, c.id, true, " ok ", async (t: string, item: any) => { seen.push(`${t}:${item.inReplyTo}`); return "https://forge/c/1"; }), null);
    assert.deepEqual(seen, ["comment:501"]);
    assert.equal(run.acts.comments[0].decision.status, "approved"); assert.equal(run.acts.comments[0].decision.url, "https://forge/c/1"); assert.equal(run.acts.comments[0].decision.note, "ok");
    assert.equal(await act.decide(run, f.id, false, "not now", async () => { throw new Error("must not run"); }), null);
    const ev = run.acts.events.filter((e: any) => e.type === "action_result");
    assert.deepEqual(ev.map((e: any) => [e.action_id, e.status]), [[c.id, "accepted"], [f.id, "rejected"]]);
    assert.match(ev[0].message, /done: https:\/\/forge\/c\/1: ok/); assert.match(ev[1].message, /rejected: not now/);
  });
  it("a second decision, an unknown id and a failing effect change nothing", async () => {
    const run = mkRun("revise"), d = A("request_domain", { domains: ["example.org"], reason: "r" });
    await act.handle(run, d, deps());
    await assert.rejects(act.decide(run, d.id, true, undefined, async () => { throw new Error("forge down"); }), /forge down/);
    assert.equal(run.acts.domains[0].decision, undefined); assert.equal(run.acts.events.length, 0);
    assert.equal(await act.decide(run, d.id, true, undefined, async () => undefined), null);
    assert.equal(await act.decide(run, d.id, false, undefined, async () => undefined), "already decided");
    assert.equal(await act.decide(run, "nosuchaction", true, undefined, async () => undefined), "no such request");
    assert.equal(run.acts.events.length, 1);
  });
  it("runs saved before comments were kept still load", () => {
    const run = mkRun("implement", { acts: { seq: 0, count: 0, events: [], seen: {}, questions: [], domains: [], followups: [], resolves: [], artifacts: [] } });
    assert.deepEqual(act.requests(run), []);
  });
});

describe("events", () => {
  it("long poll returns at once when there is something, waits otherwise, wakes on a new event", async () => {
    const run = mkRun("review");
    assert.deepEqual(await act.events(run, 0, 0), []);
    const t0 = Date.now();
    assert.deepEqual(await act.events(run, 0, 60), []);
    assert.ok(Date.now() - t0 >= 50);
    const waiting = act.events(run, 0, 5000);
    setTimeout(() => act.pushEvent(run, { type: "cancel", reason: "stop" }), 20);
    const got = await waiting;
    assert.equal(got.length, 1); assert.equal(got[0].seq, 1);
    assert.deepEqual(await act.events(run, 1, 0), []);
  });
  it("keeps the last 200 events", () => {
    const run = mkRun("review");
    for (let i = 0; i < 250; i++) act.pushEvent(run, { type: "cancel" });
    assert.equal(run.acts.events.length, 200); assert.equal(run.acts.events[0].seq, 51);
  });
});

describe("the review as published", () => {
  const github = { id: "gh", kind: "github", url: "https://github.com", api: "", user: "", tokenEnv: "GITHUB_TOKEN", token: "t" };
  const seed = async (publish = false) => {
    const run = mkRun("review");
    await act.handle(run, A("review_comment", { ...RC, suggestion: "fixed" }), deps());
    await act.handle(run, A("review_comment", { ...RC, line: 3, body: "dropped later" }), deps());
    run.review.findings[1].deleted = true;
    await act.handle(run, A("review_submit", { verdict: "approve", summary: "looks fine" }), deps());
    return run;
  };
  it("leaves out deleted findings and never approves on its own", async () => {
    const run = await seed();
    const auto = rev.build(run, github, { manual: false });
    assert.equal(auto.verdict, "comment"); assert.equal(auto.comments.length, 1);
    assert.match(auto.summary, /looks fine/); assert.match(auto.summary, /run `r1`/);
    assert.equal(rev.build(run, github, { manual: true }).verdict, "approve");
    assert.equal(rev.build(run, github, { manual: true, verdict: "request_changes", summary: "edited" }).summary.startsWith("edited"), true);
  });
  it("renders a suggestion per provider", async () => {
    const run = await seed();
    assert.match(rev.build(run, github, { manual: true }).comments[0].body, /```suggestion\nfixed\n```/);
    assert.match(rev.build(run, { ...github, kind: "gitlab" }, { manual: true }).comments[0].body, /```suggestion\nfixed\n```/);
    const fj = rev.build(run, { ...github, kind: "forgejo" }, { manual: true }).comments[0].body;
    assert.match(fj, /Suggested change/); assert.doesNotMatch(fj, /```suggestion/);
  });
  it("a review without submit still builds from the finish summary", () => {
    const run = mkRun("review", { acts: { finish: { summary: "all good" } }, review: { findings: [], comments: [], submitted: null, published: null } });
    assert.match(rev.build(run, github, { manual: false }).summary, /all good/);
  });
});

describe("forge requests", () => {
  let server: http.Server, base: string;
  const seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: any }[] = [];
  const answers: Record<string, unknown> = {};
  before(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (d) => chunks.push(d));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : null });
        const key = Object.keys(answers).sort((x, y) => y.length - x.length).find((k) => `${req.method} ${req.url}`.startsWith(k));
        if (!key) return void res.writeHead(404).end();
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(answers[key]));
      });
    }).listen(0);
    await new Promise((r) => server.on("listening", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(() => server.close());
  const prov = (kind: string, api = "") => ({ id: kind, kind, url: "http://x", api: base + api, user: "", tokenEnv: "GITHUB_TOKEN", token: "tok" });
  const out = { verdict: "request_changes", summary: "s", commitSha: "b".repeat(40), baseSha: "a".repeat(40),
    comments: [{ path: "src/a.ts", line: 3, startLine: 2, side: "RIGHT", body: "b1" }, { path: "src/a.ts", line: 1, side: "LEFT", body: "b2" }] };

  it("GitHub: one review with the comments, event and commit", async () => {
    seen.length = 0; answers["POST /repos/o/r/pulls/7/reviews"] = { html_url: "https://github.com/o/r/pull/7#review-1" };
    const url = await svc.forge.publishReview(prov("github"), "o/r", "7", out);
    assert.equal(url, "https://github.com/o/r/pull/7#review-1");
    assert.equal(seen.length, 1);
    const b = seen[0].body;
    assert.equal(b.event, "REQUEST_CHANGES"); assert.equal(b.commit_id, "b".repeat(40));
    assert.deepEqual(b.comments[0], { path: "src/a.ts", line: 3, side: "RIGHT", start_line: 2, start_side: "RIGHT", body: "b1" });
    assert.deepEqual(b.comments[1], { path: "src/a.ts", line: 1, side: "LEFT", body: "b2" });
    assert.equal(seen[0].headers.authorization, "Bearer tok");
  });
  it("Forgejo: new_position for the new file, old_position for the old one", async () => {
    seen.length = 0; answers["POST /repos/o/r/pulls/7/reviews"] = { html_url: "http://forge/o/r/pulls/7#r" };
    await svc.forge.publishReview(prov("forgejo"), "o/r", "7", { ...out, verdict: "approve" });
    const b = seen[0].body;
    assert.equal(b.event, "APPROVED");
    assert.deepEqual(b.comments, [{ path: "src/a.ts", body: "b1", new_position: 3 }, { path: "src/a.ts", body: "b2", old_position: 1 }]);
  });
  it("GitLab: draft notes with the diff refs, then one bulk publish, approve only for approve", async () => {
    seen.length = 0;
    answers["GET /projects/o%2Fr/merge_requests/7"] = { web_url: "http://gl/o/r/-/merge_requests/7", diff_refs: { base_sha: "1", start_sha: "2", head_sha: "3" } };
    answers["POST /projects/o%2Fr/merge_requests/7/"] = {};
    const url = await svc.forge.publishReview(prov("gitlab"), "o/r", "7", out);
    assert.equal(url, "http://gl/o/r/-/merge_requests/7");
    const notes = seen.filter((s) => s.url.endsWith("/draft_notes"));
    assert.equal(notes.length, 3);
    assert.deepEqual(notes[0].body.position, { position_type: "text", base_sha: "1", start_sha: "2", head_sha: "3", new_path: "src/a.ts", old_path: "src/a.ts", new_line: 3 });
    assert.equal(notes[1].body.position.old_line, 1);
    assert.match(notes[2].body.note, /Changes requested/);
    assert.ok(seen.some((s) => s.url.endsWith("/draft_notes/bulk_publish")));
    assert.ok(!seen.some((s) => s.url.endsWith("/approve")));
    assert.equal(seen[0].headers["private-token"], "tok");
    seen.length = 0;
    await svc.forge.publishReview(prov("gitlab"), "o/r", "7", { ...out, verdict: "approve" });
    assert.ok(seen.some((s) => s.url.endsWith("/approve")));
  });
  it("GitHub: pull request with threads grouped by the root comment", async () => {
    answers["GET /repos/o/r/pulls/7"] = { title: "T", body: "B", user: { login: "jana" }, html_url: "u", base: { ref: "main" }, head: { ref: "f", sha: "c".repeat(40) } };
    answers["GET /repos/o/r/pulls/7/comments"] = [
      { id: 1, path: "a.ts", line: 4, body: "why?", user: { login: "x" } }, { id: 2, in_reply_to_id: 1, path: "a.ts", line: 4, body: "because", user: { login: "y" } }, { id: 3, path: "b.ts", original_line: 9, body: "n", user: { login: "x" } },
    ];
    const pr = await svc.forge.pr(prov("github"), "o/r", "7");
    assert.equal(pr.headSha, "c".repeat(40)); assert.equal(pr.baseRef, "main"); assert.equal(pr.author, "jana");
    assert.equal(pr.threads.length, 2);
    assert.deepEqual(pr.threads[0], { thread_id: "1", resolved: false, path: "a.ts", line: 4, comments: [{ author: "x", body: "why?" }, { author: "y", body: "because" }] });
    assert.equal(pr.threads[1].line, 9);
  });
  it("GitLab: merge request with discussions and resolved state", async () => {
    answers["GET /projects/o%2Fr/merge_requests/7/discussions"] = [
      { id: "d1", notes: [{ author: { username: "u" }, body: "fix", resolved: true, position: { new_path: "a.ts", new_line: 2 } }, { system: true, author: { username: "s" }, body: "changed" }] },
      { id: "d2", individual_note: true, notes: [{ author: { username: "u" }, body: "general" }] },
    ];
    answers["GET /projects/o%2Fr/merge_requests/7"] = { title: "T", description: "D", author: { username: "ann" }, web_url: "w", target_branch: "main", source_branch: "f", sha: "d".repeat(40) };
    const pr = await svc.forge.pr(prov("gitlab"), "o/r", "7");
    assert.equal(pr.threads.length, 1); assert.equal(pr.threads[0].resolved, true);
    assert.deepEqual(pr.threads[0].comments, [{ author: "u", body: "fix" }]);
    assert.equal(pr.headSha, "d".repeat(40));
  });
  it("approved requests: issue, comment, reply and resolved thread on each forge", async () => {
    seen.length = 0;
    answers["POST /repos/o/r/issues"] = { html_url: "https://github.com/o/r/issues/9" };
    answers["POST /repos/o/r/issues/7/comments"] = { html_url: "https://github.com/o/r/pull/7#c1" };
    answers["POST /repos/o/r/pulls/7/comments/501/replies"] = { html_url: "https://github.com/o/r/pull/7#r501" };
    assert.equal(await svc.forge.createIssue(prov("github"), "o/r", { title: "t", body: "b" }), "https://github.com/o/r/issues/9");
    assert.equal(await svc.forge.comment(prov("github"), "o/r", "7", "hi"), "https://github.com/o/r/pull/7#c1");
    assert.equal(await svc.forge.comment(prov("github"), "o/r", "7", "re", "501"), "https://github.com/o/r/pull/7#r501");
    assert.equal(await svc.forge.comment(prov("forgejo"), "o/r", "7", "re", "501"), "https://github.com/o/r/pull/7#c1", "Forgejo has no replies: a PR comment");
    assert.deepEqual(seen.map((s) => `${s.method} ${s.url}`), ["POST /repos/o/r/issues", "POST /repos/o/r/issues/7/comments", "POST /repos/o/r/pulls/7/comments/501/replies", "POST /repos/o/r/issues/7/comments"]);
    assert.deepEqual(seen[2].body, { body: "re" });

    seen.length = 0;
    answers["POST /api/graphql"] = { data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: "T0", isResolved: false, comments: { nodes: [{ databaseId: 400 }] } }, { id: "T1", isResolved: false, comments: { nodes: [{ databaseId: 501 }] } }] } } } } };
    await svc.forge.resolveThread(prov("github", "/api/v3"), "o/r", "7", "501");
    assert.equal(seen.length, 2, "a query, then the mutation");
    assert.deepEqual(seen[0].body.variables, { o: "o", n: "r", pr: 7 });
    assert.match(seen[1].body.query, /resolveReviewThread/); assert.deepEqual(seen[1].body.variables, { t: "T1" });
    await assert.rejects(svc.forge.resolveThread(prov("github", "/api/v3"), "o/r", "7", "999"), (e: Error) => e.name === "NotFound");
    await assert.rejects(svc.forge.resolveThread(prov("forgejo"), "o/r", "7", "501"), (e: Error) => e.name === "Unsupported");

    seen.length = 0;
    answers["PUT /projects/o%2Fr/merge_requests/7/discussions/d1"] = {};
    answers["POST /projects/o%2Fr/issues"] = { web_url: "http://gl/o/r/-/issues/3" };
    await svc.forge.resolveThread(prov("gitlab"), "o/r", "7", "d1");
    assert.equal(seen[0].url, "/projects/o%2Fr/merge_requests/7/discussions/d1?resolved=true");
    assert.equal(await svc.forge.createIssue(prov("gitlab"), "o/r", { title: "t", body: "b" }), "http://gl/o/r/-/issues/3");
    assert.deepEqual(seen[1].body, { title: "t", description: "b" });
    await svc.forge.comment(prov("gitlab"), "o/r", "7", "re", "d1");
    assert.equal(seen[2].url, "/projects/o%2Fr/merge_requests/7/discussions/d1/notes");
  });
  it("a PR from a fork is told apart from one in the repository", async () => {
    answers["GET /repos/o/r/pulls/8"] = { title: "T", body: "", user: { login: "x" }, html_url: "u", base: { ref: "main" }, head: { ref: "f", sha: "c".repeat(40), repo: { full_name: "someone/r" } } };
    answers["GET /repos/o/r/pulls/8/comments"] = [];
    assert.equal((await svc.forge.pr(prov("github"), "o/r", "8")).sameRepo, false);
    answers["GET /repos/o/r/pulls/8"] = { ...answers["GET /repos/o/r/pulls/8"] as object, head: { ref: "f", sha: "c".repeat(40), repo: { full_name: "O/r" } } };
    assert.equal((await svc.forge.pr(prov("github"), "o/r", "8")).sameRepo, true);
  });
  it("a missing pull request is NotFound; ids and refs are checked", async () => {
    await assert.rejects(svc.forge.pr(prov("github"), "o/r", "999"), (e: Error) => e.name === "NotFound");
    await assert.rejects(svc.forge.pr(prov("github"), "o/r", "1/../2"), (e: Error) => e.name === "NotFound");
    assert.equal(svc.forge.prRef(prov("github"), "7"), "refs/pull/7/head");
    assert.equal(svc.forge.prRef(prov("forgejo"), "7"), "refs/pull/7/head");
    assert.equal(svc.forge.prRef(prov("gitlab"), "7"), "refs/merge-requests/7/head");
    assert.throws(() => svc.forge.prRef(prov("github"), "x y"));
  });
});

describe("review repository (real git)", () => {
  const g = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
  it("holds base and PR head, computes the merge base, the diff and file contents, and refuses pushes", async () => {
    const work = path.join(tmp, "work"), mirror = path.join(tmp, "mirror.git");
    fs.mkdirSync(work);
    g(work, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(work, "a.ts"), "one\ntwo\nthree\n"); g(work, "add", "."); g(work, "commit", "-qm", "base");
    const fork = g(work, "rev-parse", "HEAD");
    g(work, "checkout", "-qb", "feature");
    fs.writeFileSync(path.join(work, "a.ts"), "one\nTWO\nthree\nfour\n"); fs.writeFileSync(path.join(work, "new.ts"), "n\n");
    g(work, "add", "."); g(work, "commit", "-qm", "pr");
    const head = g(work, "rev-parse", "HEAD");
    g(work, "checkout", "-q", "main");
    fs.writeFileSync(path.join(work, "other.ts"), "o\n"); g(work, "add", "."); g(work, "commit", "-qm", "main moved");
    g(tmp, "clone", "-q", "--mirror", work, mirror);
    g(mirror, "update-ref", "refs/pull/5/head", head); // what a forge adds to a mirror
    const r = await git.createReviewRepo("rv1", mirror, "main", "refs/pull/5/head");
    assert.equal(r.headSha, head);
    assert.equal(r.baseSha, fork, "the merge base, not the moved tip of main");
    assert.deepEqual(r.files.sort(), ["a.ts", "new.ts"]);
    const diff = await git.diffOf("rv1", r.baseSha, r.headSha);
    assert.doesNotMatch(diff, /other\.ts/);
    const m = act.parseDiff(diff);
    assert.ok(m.get("a.ts").RIGHT.has(2) && m.get("a.ts").RIGHT.has(4) && m.get("new.ts").RIGHT.has(1));
    assert.equal(await git.fileAt("rv1", head, "a.ts"), "one\nTWO\nthree\nfour\n");
    assert.equal(await git.fileAt("rv1", head, "missing.ts"), null);
    assert.equal(await git.fileAt("rv1", "--output=x", "a.ts"), null);
    // The hook refuses every push.
    const clone = path.join(tmp, "vm");
    g(tmp, "clone", "-q", "-b", "yf-head", r.path, clone);
    assert.equal(g(clone, "rev-parse", "HEAD"), head);
    fs.writeFileSync(path.join(clone, "x"), "x"); g(clone, "add", "."); g(clone, "commit", "-qm", "x");
    assert.throws(() => execFileSync("git", ["push", "-q", "origin", "HEAD:refs/heads/yfactory/rv1"], { cwd: clone, stdio: "pipe" }), /cannot push/);
  });
  it("a PR ref that does not exist fails the run early", async () => {
    await assert.rejects(git.createReviewRepo("rv2", path.join(tmp, "mirror.git"), "main", "refs/pull/99/head"));
  });
});

describe("task API /yf over HTTP, with the yf-act helper of the VM", () => {
  let server: http.Server, url: string, home: string, run: any;
  const token = "run-token-for-test";
  const seenReq: string[] = [];
  const results: Record<string, unknown>[] = [];
  const call = (method: string, p: string, body?: unknown, auth = `Bearer ${token}`) =>
    fetch(url + p, { method, headers: { Authorization: auth, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  // Async: the server runs in this process, a blocking exec would wait for an answer it cannot give.
  const actAs = (...args: string[]): Promise<string> => new Promise((resolve, reject) => {
    const c = execFile(path.join(home, "yf-act"), args, { encoding: "utf8", env: { PATH: process.env.PATH!, HOME: home }, timeout: 20_000 }, (e, out, err) => (e ? reject(Object.assign(e, { stderr: err })) : resolve(out)));
    c.stdin!.end(actStdin); actStdin = "";
  });
  let actStdin = "";

  before(async () => {
    fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
    run = runs.add({ repo: "o/r", base: "main", prompt: "Review #1", model: null, keep: false, kind: "review", environment: "d", envSetup: "", maintenance: "", setup: "", env: {}, target: mkRun("review").target });
    runs.update(run, { vm: "yf-x", status: "running" });
    const d = deps();
    server = http.createServer((req, res) => {
      seenReq.push(`${req.method} ${req.url}`);
      if (req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401).end();
      yf.serve(req, res, run, d).catch(() => res.writeHead(500).end());
    }).listen(0);
    await new Promise((r) => server.on("listening", r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    home = path.join(tmp, "vmhome");
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, "yf-act"), rev.ACT, { mode: 0o755 });
    fs.writeFileSync(path.join(home, ".yf-env"), `export YF_TOKEN=${token}\nexport TASK_API_URL=${url}\n`);
  });
  after(() => { server.closeAllConnections(); server.close(); });

  it("GET /yf/context tells the run what it is and may do", async () => {
    const c = await (await call("GET", "/yf/context")).json();
    assert.equal(schema.validate("Context", c), null);
    assert.equal(c.run.kind, "review"); assert.ok(c.capabilities.includes("review_comment")); assert.ok(!c.capabilities.includes("propose_environment"));
  });
  it("POST /yf/actions: 200 with the result even for a rejected action; 400 for broken JSON", async () => {
    const ok = await call("POST", "/yf/actions", A("progress", { phase: "reviewing", message: "m" }));
    assert.equal(ok.status, 200); assert.equal((await ok.json()).status, "accepted");
    const rej = await call("POST", "/yf/actions", A("review_comment", { ...RC, line: 77 }));
    assert.equal(rej.status, 200);
    const j = await rej.json();
    assert.equal(j.code, "invalid_anchor"); assert.equal(schema.validate("ActionResult", j), null);
    const bad = await fetch(url + "/yf/actions", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{nope" });
    assert.equal(bad.status, 400);
  });
  it("a wrong token gets 401 and a body over 512 KiB gets 413", async () => {
    assert.equal((await call("GET", "/yf/context", undefined, "Bearer other")).status, 401);
    assert.equal((await call("POST", "/yf/actions", { pad: "x".repeat(600 * 1024) })).status, 413);
  });
  it("GET /yf/events long-polls and returns what happened after `after`", async () => {
    const t0 = Date.now();
    const empty = await (await call("GET", `/yf/events?after=${run.acts.seq}&wait=1`)).json();
    assert.deepEqual(empty, { events: [] }); assert.ok(Date.now() - t0 >= 900);
    const pending = call("GET", `/yf/events?after=${run.acts.seq}&wait=10`);
    setTimeout(() => act.pushEvent(run, { type: "head_changed", head_sha: "e".repeat(40) }), 50);
    const got = await (await pending).json();
    assert.equal(got.events.length, 1); assert.equal(schema.validate("Event", got.events[0]), null);
  });
  it("unknown /yf paths are 404", async () => assert.equal((await call("GET", "/yf/nothing")).status, 404));

  it("yf-act: context, an action from argv, from stdin, and events", async () => {
    assert.equal(JSON.parse(await actAs("context")).run.id, run.id);
    const r = JSON.parse(await actAs("progress", '{"phase":"testing","message":"via helper"}'));
    assert.equal(r.status, "accepted"); assert.match(r.id, /^[0-9a-f]{24}$/);
    assert.equal(run.acts.progress.message, "via helper");
    actStdin = JSON.stringify({ ...RC, body: "from stdin with 'quotes' and \"double\"" });
    assert.equal(JSON.parse(await actAs("review_comment", "-")).status, "accepted");
    assert.match(run.review.findings.at(-1).body, /from stdin with 'quotes'/);
    assert.ok(Array.isArray(JSON.parse(await actAs("events", "0", "0")).events));
    await assert.rejects(actAs(), /usage/);
  });
  it("yf-act shows a rejection to the agent instead of failing", async () => {
    const r = JSON.parse(await actAs("review_comment", JSON.stringify({ ...RC, line: 500, body: "far away" })));
    assert.equal(r.status, "rejected"); assert.equal(r.code, "invalid_anchor");
  });
  it("floods get 429 after 30 actions in 10 seconds", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 40; i++) codes.push((await call("POST", "/yf/actions", A("progress", { phase: "setup", message: `m${i}` }))).status);
    assert.ok(codes.includes(429)); assert.equal(codes[0], 200);
  });
});
