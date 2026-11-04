import { createHash, createHmac } from "node:crypto";
import { CFG } from "./config.ts";
import type { Thread } from "./actions.ts";
import type { Provider } from "./repos.ts";

export class HttpError extends Error {
  name = "HttpError";
  status: number;
  constructor(msg: string, status: number) {
    super(msg);
    this.status = status;
  }
}

async function call(method: string, url: string, headers: Record<string, string>, body?: unknown) {
  const res = await fetch(url, {
    method, headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000),
  });
  // The body may contain anything, so the error carries only method, path and status.
  if (!res.ok) throw new HttpError(`${method} ${new URL(url).pathname} -> ${res.status}`, res.status);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// GitHub and Forgejo share these calls: repository with permissions, pull request, Basic auth for git.
const api = (p: Provider, method: string, path: string, body?: unknown) => call(method, p.api + path, {
  Authorization: `Bearer ${p.token}`, Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "yfactory",
}, body);

// GitLab: PRIVATE-TOKEN, project by url-encoded path, merge requests by iid.
const gl = (p: Provider, method: string, path: string, body?: unknown) => call(method, p.api + path, { "PRIVATE-TOKEN": p.token, "User-Agent": "yfactory" }, body);
const proj = (repo: string) => `/projects/${encodeURIComponent(repo)}`;

export type PrInfo = {
  id: string; title: string; body: string; author: string; url: string; baseRef: string; headRef: string; headSha: string;
  sameRepo: boolean; // false: the head branch is in a fork, yfactory cannot push to it
  threads: Thread[];
};
export type ReviewOut = {
  verdict: "approve" | "request_changes" | "comment"; summary: string; commitSha: string; baseSha: string;
  comments: { path: string; line: number; startLine?: number; side: "RIGHT" | "LEFT"; body: string }[];
};

export class NotFound extends Error {
  name = "NotFound";
}

const MAX_THREADS = 100, MAX_COMMENTS = 20, MAX_TEXT = 4000;
const clip = (t: unknown, n = MAX_TEXT) => String(t ?? "").slice(0, n);
const login = (u: any) => clip(u?.login ?? u?.username ?? u?.name ?? "unknown", 100);
const prId = (id: string) => { if (!/^\d{1,9}$/.test(id)) throw new NotFound("invalid pull request id"); return id; };

// GitHub and Forgejo review comments are flat; a reply points at the root through in_reply_to_id (GitHub only).
function groupThreads(items: any[]): Thread[] {
  const roots = new Map<string, Thread>();
  for (const c of items) {
    const root = String(c.in_reply_to_id ?? c.id);
    let t = roots.get(root);
    if (!t) roots.set(root, t = { thread_id: root, resolved: false, ...(c.path && { path: clip(c.path, 1024) }), ...((c.line ?? c.original_line ?? c.position) && { line: Number(c.line ?? c.original_line ?? c.position) }), comments: [] });
    if (t.comments.length < MAX_COMMENTS) t.comments.push({ author: login(c.user), body: clip(c.body) });
  }
  return [...roots.values()].slice(0, MAX_THREADS);
}

const suggestion = (kind: Provider["kind"], text: string) =>
  kind === "forgejo" ? `\n\nSuggested change:\n\`\`\`\n${text}\n\`\`\`` : `\n\n\`\`\`suggestion\n${text}\n\`\`\``;

// The comment as the forge shows it. `suggestion` only for a single replaced block; Forgejo has no suggestion syntax.
export function renderFinding(kind: Provider["kind"], f: { severity: string; category: string; body: string; suggestion?: string }) {
  return `**${f.severity} · ${f.category}**\n\n${f.body}${f.suggestion !== undefined ? suggestion(kind, f.suggestion) : ""}`;
}

export const forge = {
  repoUrl: (p: Provider, repo: string) => `${p.url}/${repo}.git`,
  gitAuth: (p: Provider) => p.token ? "Basic " + Buffer.from(`${p.user || (p.kind === "gitlab" ? "oauth2" : "x-access-token")}:${p.token}`).toString("base64") : "",
  async repo(p: Provider, repo: string): Promise<{ defaultBranch: string; canPush: boolean }> {
    if (p.kind === "gitlab") {
      const r = await gl(p, "GET", proj(repo));
      const level = Math.max(r.permissions?.project_access?.access_level ?? 0, r.permissions?.group_access?.access_level ?? 0);
      return { defaultBranch: r.default_branch, canPush: level >= 30 };
    }
    const r = await api(p, "GET", `/repos/${repo}`);
    return { defaultBranch: r.default_branch, canPush: !!r.permissions?.push };
  },
  async openPr(p: Provider, repo: string, pr: { head: string; base: string; title: string; body: string }): Promise<string> {
    if (p.kind === "gitlab") return (await gl(p, "POST", `${proj(repo)}/merge_requests`, { source_branch: pr.head, target_branch: pr.base, title: pr.title, description: pr.body })).web_url;
    return (await api(p, "POST", `/repos/${repo}/pulls`, { ...pr, draft: false })).html_url;
  },

  // The ref of the PR head in a mirror of the repository (git clone --mirror keeps all refs of the forge).
  prRef: (p: Provider, id: string) => p.kind === "gitlab" ? `refs/merge-requests/${prId(id)}/head` : `refs/pull/${prId(id)}/head`,

  async pr(p: Provider, repo: string, id: string): Promise<PrInfo> {
    prId(id);
    try {
      if (p.kind === "gitlab") {
        const m = await gl(p, "GET", `${proj(repo)}/merge_requests/${id}`);
        const d = await gl(p, "GET", `${proj(repo)}/merge_requests/${id}/discussions?per_page=${MAX_THREADS}`);
        const threads: Thread[] = d.filter((x: any) => !x.individual_note || x.notes?.[0]?.position).slice(0, MAX_THREADS).map((x: any) => ({
          thread_id: String(x.id), resolved: !!x.notes?.[0]?.resolved,
          ...(x.notes?.[0]?.position?.new_path && { path: clip(x.notes[0].position.new_path, 1024) }),
          ...(x.notes?.[0]?.position?.new_line && { line: Number(x.notes[0].position.new_line) }),
          comments: x.notes.filter((n: any) => !n.system).slice(0, MAX_COMMENTS).map((n: any) => ({ author: login(n.author), body: clip(n.body) })),
        }));
        return { id, title: clip(m.title, 500), body: clip(m.description, 20_000), author: login(m.author), url: m.web_url, baseRef: m.target_branch, headRef: m.source_branch, headSha: m.sha, sameRepo: m.source_project_id === m.target_project_id, threads };
      }
      const r = await api(p, "GET", `/repos/${repo}/pulls/${id}`);
      let items: any[] = [];
      if (p.kind === "github") items = await api(p, "GET", `/repos/${repo}/pulls/${id}/comments?per_page=100`);
      else {
        // Forgejo lists the inline comments per review.
        const reviews: any[] = await api(p, "GET", `/repos/${repo}/pulls/${id}/reviews`);
        for (const rv of reviews.slice(0, 20)) items.push(...(await api(p, "GET", `/repos/${repo}/pulls/${id}/reviews/${rv.id}/comments`)));
      }
      return { id, title: clip(r.title, 500), body: clip(r.body, 20_000), author: login(r.user), url: r.html_url, baseRef: r.base.ref, headRef: r.head.ref, headSha: r.head.sha,
        sameRepo: String(r.head.repo?.full_name ?? "").toLowerCase() === repo.toLowerCase(), threads: groupThreads(items) };
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) throw new NotFound(`pull request ${id} not found`);
      throw e;
    }
  },

  async ci(p: Provider, repo: string, id: string, sha: string): Promise<object> {
    if (p.kind === "gitlab") {
      const pl: any[] = await gl(p, "GET", `${proj(repo)}/merge_requests/${prId(id)}/pipelines`);
      return { state: pl[0]?.status ?? "none", checks: pl.slice(0, 10).map((x) => ({ name: `pipeline ${x.id}`, state: x.status })) };
    }
    const st = await api(p, "GET", `/repos/${repo}/commits/${sha}/status`);
    const checks = (st.statuses ?? []).slice(0, 50).map((x: any) => ({ name: clip(x.context, 200), state: x.status ?? x.state }));
    if (p.kind === "github") {
      const cr = await api(p, "GET", `/repos/${repo}/commits/${sha}/check-runs?per_page=50`).catch(() => ({ check_runs: [] }));
      for (const c of cr.check_runs ?? []) checks.push({ name: clip(c.name, 200), state: c.conclusion ?? c.status });
    }
    return { state: st.state ?? "unknown", checks };
  },

  // One review: summary and inline comments together. Returns the url. The caller has already sanitised and limited the text.
  async publishReview(p: Provider, repo: string, id: string, rv: ReviewOut): Promise<string> {
    prId(id);
    if (p.kind === "github") {
      const event = { approve: "APPROVE", request_changes: "REQUEST_CHANGES", comment: "COMMENT" }[rv.verdict];
      const r = await api(p, "POST", `/repos/${repo}/pulls/${id}/reviews`, {
        commit_id: rv.commitSha, body: rv.summary, event,
        comments: rv.comments.map((c) => ({ path: c.path, line: c.line, side: c.side, ...(c.startLine !== undefined && c.startLine !== c.line && { start_line: c.startLine, start_side: c.side }), body: c.body })),
      });
      return r.html_url;
    }
    if (p.kind === "forgejo") {
      const event = { approve: "APPROVED", request_changes: "REQUEST_CHANGES", comment: "COMMENT" }[rv.verdict];
      // Forgejo anchors a comment on one line: the end of a range.
      const r = await api(p, "POST", `/repos/${repo}/pulls/${id}/reviews`, {
        commit_id: rv.commitSha, body: rv.summary, event,
        comments: rv.comments.map((c) => ({ path: c.path, body: c.body, ...(c.side === "RIGHT" ? { new_position: c.line } : { old_position: c.line }) })),
      });
      return r.html_url ?? `${p.url}/${repo}/pulls/${id}`;
    }
    // GitLab: draft notes, then one bulk publish. A MR has no "request changes" in every edition: it is stated in the summary.
    const diff = await gl(p, "GET", `${proj(repo)}/merge_requests/${id}`);
    const refs = diff.diff_refs ?? {};
    for (const c of rv.comments) {
      await gl(p, "POST", `${proj(repo)}/merge_requests/${id}/draft_notes`, {
        note: c.body,
        position: { position_type: "text", base_sha: refs.base_sha, start_sha: refs.start_sha, head_sha: refs.head_sha, new_path: c.path, old_path: c.path, ...(c.side === "RIGHT" ? { new_line: c.line } : { old_line: c.line }) },
      });
    }
    const label = { approve: "Approve", request_changes: "Changes requested", comment: "Comment" }[rv.verdict];
    await gl(p, "POST", `${proj(repo)}/merge_requests/${id}/draft_notes`, { note: `**${label}**\n\n${rv.summary}` });
    await gl(p, "POST", `${proj(repo)}/merge_requests/${id}/draft_notes/bulk_publish`);
    if (rv.verdict === "approve") await gl(p, "POST", `${proj(repo)}/merge_requests/${id}/approve`);
    return diff.web_url;
  },

  async createIssue(p: Provider, repo: string, issue: { title: string; body: string }): Promise<string> {
    if (p.kind === "gitlab") return (await gl(p, "POST", `${proj(repo)}/issues`, { title: issue.title, description: issue.body })).web_url;
    return (await api(p, "POST", `/repos/${repo}/issues`, issue)).html_url;
  },

  // A comment on the PR, or a reply in a review thread where the forge has one (GitHub, GitLab; Forgejo gets a PR comment).
  async comment(p: Provider, repo: string, id: string, body: string, thread?: string): Promise<string> {
    prId(id);
    if (p.kind === "gitlab") {
      const path = thread ? `/discussions/${encodeURIComponent(thread)}/notes` : "/notes";
      await gl(p, "POST", `${proj(repo)}/merge_requests/${id}${path}`, { body });
      return (await gl(p, "GET", `${proj(repo)}/merge_requests/${id}`)).web_url;
    }
    if (p.kind === "github" && thread && /^\d{1,20}$/.test(thread)) return (await api(p, "POST", `/repos/${repo}/pulls/${id}/comments/${thread}/replies`, { body })).html_url;
    return (await api(p, "POST", `/repos/${repo}/issues/${id}/comments`, { body })).html_url;
  },

  // thread: the id from PrInfo.threads (GitHub: the REST id of the first comment, GitLab: the discussion id).
  async resolveThread(p: Provider, repo: string, id: string, thread: string): Promise<void> {
    prId(id);
    if (p.kind === "gitlab") return void await gl(p, "PUT", `${proj(repo)}/merge_requests/${id}/discussions/${encodeURIComponent(thread)}?resolved=true`);
    if (p.kind === "forgejo") throw new Unsupported("Forgejo has no API to resolve a review thread");
    // REST has no resolve: find the GraphQL thread whose first comment is this one.
    const gql = async (query: string, variables: object) => {
      const r = await call("POST", p.api.replace(/\/v3\/?$/, "") + "/graphql", { Authorization: `Bearer ${p.token}`, "User-Agent": "yfactory" }, { query, variables });
      if (r?.errors?.length) throw new HttpError("POST /graphql -> errors", 502);
      return r.data;
    };
    const [owner, name] = repo.split("/");
    const d = await gql("query($o:String!,$n:String!,$pr:Int!){repository(owner:$o,name:$n){pullRequest(number:$pr){reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{databaseId}}}}}}}", { o: owner, n: name, pr: Number(id) });
    const t = (d?.repository?.pullRequest?.reviewThreads?.nodes ?? []).find((x: any) => String(x.comments?.nodes?.[0]?.databaseId) === thread);
    if (!t) throw new NotFound(`review thread ${thread} not found`);
    if (!t.isResolved) await gql("mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{id}}}", { t: t.id });
  },
};

export class Unsupported extends Error {
  name = "Unsupported";
}

const ll = (p: string, body: unknown) => call("POST", CFG.litellm.url + p, { Authorization: `Bearer ${CFG.litellm.masterKey}` }, body);

export const litellm = {
  // The alias lets the orchestrator revoke the key after a restart without storing it.
  async grant(alias: string, meta: object, duration = "2h"): Promise<string> {
    return (await ll("/key/generate", { key_alias: alias, duration, models: CFG.litellm.models, metadata: meta })).key;
  },
  revoke: (alias: string) => ll("/key/delete", { key_aliases: [alias] }),
};

const sha = (d: Buffer | string) => createHash("sha256").update(d).digest("hex");
const hmac = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d).digest();

async function s3Request(method: string, key: string, body: Buffer | string, type: string, timeout: number) {
  const { endpoint, region, bucket, accessKey, secretKey } = CFG.s3;
  const url = new URL(`${endpoint}/${bucket}${key ? "/" + key.split("/").map(encodeURIComponent).join("/") : ""}`);
  const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const payload = sha(body);
  const signed: Record<string, string> = { host: url.host, "x-amz-content-sha256": payload, "x-amz-date": amzDate };
  const names = Object.keys(signed).sort();
  const canonical = [method, url.pathname, "", ...names.map((n) => `${n}:${signed[n]}`), "", names.join(";"), payload].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha(canonical)].join("\n");
  const kSign = ["s3", "aws4_request"].reduce((k, d) => hmac(k, d), hmac(hmac("AWS4" + secretKey, day), region));
  const auth = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${createHmac("sha256", kSign).update(toSign).digest("hex")}`;
  return fetch(url, {
    method, body: body.length ? body : undefined,
    headers: { "x-amz-content-sha256": payload, "x-amz-date": amzDate, "Content-Type": type, Authorization: auth },
    signal: AbortSignal.timeout(timeout),
  });
}

export async function s3Put(key: string, body: Buffer | string, type = "application/json") {
  const res = await s3Request("PUT", key, body, type, 60_000);
  if (!res.ok) throw new HttpError(`S3 PUT ${key} -> ${res.status}`, res.status);
}

export async function s3Get(key: string): Promise<Buffer | null> {
  const res = await s3Request("GET", key, "", "application/octet-stream", 30_000);
  if (res.status === 404) return null;
  if (!res.ok) throw new HttpError(`S3 GET ${key} -> ${res.status}`, res.status);
  return Buffer.from(await res.arrayBuffer());
}

// HEAD on the bucket: needs working credentials, writes nothing.
export async function s3Head() {
  const res = await s3Request("HEAD", "", "", "application/json", 3000);
  if (!res.ok) throw new HttpError(`S3 HEAD bucket -> ${res.status}`, res.status);
}
