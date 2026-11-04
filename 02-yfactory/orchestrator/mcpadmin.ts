// Management MCP server on the UI port: every tool is one call of the HTTP API, so the API stays the only way to change anything.
import type http from "node:http";
import { serve, type Backend } from "./mcp.ts";

const MAX_OUT = 60_000;
const str = { type: "string" };
const repo = { type: "string", description: "owner/name" };
const id = { type: "string", description: "session (run) id" };
const obj = (properties: object, required: string[] = []) => ({ type: "object", properties, required });

type Def = { name: string; description: string; inputSchema: object; run: (a: any) => Promise<unknown> };

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${process.env.YF_UI_LISTEN ?? 8080}${path}`, {
    method, headers: { "Content-Type": "application/json" }, body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data;
}

const q = (o: Record<string, unknown>) => {
  const p = new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));
  return p.size ? `?${p}` : "";
};
const need = (a: any, k: string) => { if (!a?.[k]) throw new Error(`${k} is required`); return String(a[k]); };
const rpath = (r: string) => r.split("/").map(encodeURIComponent).join("/");

// A transcript as readable text: the JSON of a long session is mostly noise for an agent.
function readable(t: any): string {
  const out = [`# ${t.info?.title ?? "session"} (${t.info?.model?.id ?? "?"})`];
  for (const m of t.messages ?? []) {
    for (const p of m.parts ?? []) {
      if (p.type === "text" && p.text) out.push(`${m.info?.role === "user" ? "USER" : "ASSISTANT"}: ${p.text}`);
      else if (p.type === "tool") out.push(`TOOL ${p.tool} ${JSON.stringify(p.state?.input ?? {}).slice(0, 300)}\n  -> ${String(p.state?.output ?? "").slice(0, 600)}`);
    }
  }
  return out.join("\n\n");
}

const DEFS: Def[] = [
  { name: "list_repositories", description: "Configured repositories with their settings (environment, default and allowed models, base branch), plus providers, models and environments.", inputSchema: obj({}), run: () => api("GET", "/api/repos") },
  {
    name: "put_repository", description: "Create or update a repository. Fields not given reset to their defaults, so read the repository first when changing one field.",
    inputSchema: obj({ repo, provider: str, base: str, environment: str, model: str, models: { type: "array", items: str }, setup: str, env: { type: "object", additionalProperties: str } }, ["repo"]),
    run: (a) => api("PUT", "/api/repos", a),
  },
  { name: "delete_repository", description: "Remove a repository (its past sessions stay in the history).", inputSchema: obj({ repo }, ["repo"]), run: (a) => api("DELETE", `/api/repos/${rpath(need(a, "repo"))}`) },
  { name: "inspect_repository", description: "Start an inspect session: the agent tries the setup and proposes repository and environment settings. No pull request.", inputSchema: obj({ repo, model: str }, ["repo"]), run: (a) => api("POST", `/api/repos/${rpath(need(a, "repo"))}/inspect`, { model: a.model }) },
  { name: "list_environments", description: "Environments (setup and maintenance scripts, env).", inputSchema: obj({}), run: () => api("GET", "/api/environments") },
  { name: "put_environment", description: "Create or update an environment.", inputSchema: obj({ name: str, setup: str, maintenance: str, env: { type: "object", additionalProperties: str } }, ["name"]), run: (a) => api("PUT", "/api/environments", a) },
  { name: "delete_environment", description: "Remove an unused environment.", inputSchema: obj({ name: str }, ["name"]), run: (a) => api("DELETE", `/api/environments/${encodeURIComponent(need(a, "name"))}`) },
  {
    name: "create_session", description: "Start a session: the agent works on the prompt in a VM and its branch becomes a pull request. Without a prompt only a VM for the terminal is prepared. Returns the session; poll get_session.",
    inputSchema: obj({ repo, prompt: str, model: str, base: str, keep: { type: "boolean", description: "keep the VM after the run" } }, ["repo"]),
    run: (a) => api("POST", "/api/runs", a),
  },
  { name: "list_sessions", description: "Sessions (runs), newest first, optionally of one repository.", inputSchema: obj({ repo, limit: { type: "integer" } }), run: (a) => api("GET", `/api/runs${q({ repo: a?.repo, limit: a?.limit })}`) },
  { name: "get_session", description: "One session: status, branch, pull request, error, proposal.", inputSchema: obj({ id }, ["id"]), run: (a) => api("GET", `/api/runs/${encodeURIComponent(need(a, "id"))}`) },
  {
    name: "get_transcript", description: "What the agent said and did in a session (opencode export), as readable text by default.",
    inputSchema: obj({ id, n: { type: "integer", description: "which opencode session of the run, default 0" }, format: { type: "string", enum: ["text", "json"] } }, ["id"]),
    run: async (a) => {
      const t = await api("GET", `/api/runs/${encodeURIComponent(need(a, "id"))}/transcript${q({ n: a.n })}`);
      return a.format === "json" ? t : readable(t);
    },
  },
  { name: "cancel_session", description: "Stop a queued or running session.", inputSchema: obj({ id }, ["id"]), run: (a) => api("POST", `/api/runs/${encodeURIComponent(need(a, "id"))}/cancel`) },
  { name: "publish_session", description: "Push the branch of a ready session and open the pull request.", inputSchema: obj({ id }, ["id"]), run: (a) => api("POST", `/api/runs/${encodeURIComponent(need(a, "id"))}/publish`) },
  { name: "delete_session_vm", description: "Export the sessions to S3 and remove the VM of a session.", inputSchema: obj({ id }, ["id"]), run: (a) => api("POST", `/api/runs/${encodeURIComponent(need(a, "id"))}/destroy`) },
  { name: "apply_proposal", description: "Apply the repository or environment part of an inspect proposal and start a verify run.", inputSchema: obj({ id, part: { type: "string", enum: ["repository", "environment"] } }, ["id", "part"]), run: (a) => api("POST", `/api/runs/${encodeURIComponent(need(a, "id"))}/apply`, { part: a.part }) },
  {
    name: "review_pull_request", description: "Start a review session of a pull request: the agent only reads the code and reports findings, which wait as a draft (or publish at once, per repository). Poll get_review.",
    inputSchema: obj({ repo, pr: { type: "string", description: "number of the pull request" }, model: str }, ["repo", "pr"]),
    run: (a) => api("POST", "/api/runs", { repo: a.repo, pr: String(need(a, "pr")), model: a.model, kind: "review" }),
  },
  {
    name: "revise_pull_request", description: "Start a revise session: the agent addresses the unresolved review threads of a pull request and its commits are pushed to the head branch of that pull request (not for forks). Its replies and thread resolutions wait for decide_action.",
    inputSchema: obj({ repo, pr: { type: "string", description: "number of the pull request" }, prompt: { type: "string", description: "optional extra instructions" }, model: str }, ["repo", "pr"]),
    run: (a) => api("POST", "/api/runs", { repo: a.repo, pr: String(need(a, "pr")), prompt: a.prompt, model: a.model, kind: "revise" }),
  },
  { name: "get_review", description: "The review of a review session: findings, verdict and summary of the agent, published or draft, questions.", inputSchema: obj({ id }, ["id"]), run: (a) => api("GET", `/api/runs/${encodeURIComponent(need(a, "id"))}/review`) },
  {
    name: "edit_finding", description: "Change or delete a finding of a draft review before it is published.",
    inputSchema: obj({ id, n: { type: "integer", description: "finding number" }, body: str, severity: { type: "string", enum: ["blocker", "major", "minor", "nit", "praise"] }, deleted: { type: "boolean" } }, ["id", "n"]),
    run: (a) => api("PUT", `/api/runs/${encodeURIComponent(need(a, "id"))}/review/findings/${Number(a.n)}`, { body: a.body, severity: a.severity, deleted: a.deleted }),
  },
  {
    name: "publish_review", description: "Post the draft review to the forge as one review (never twice). verdict and summary override the agent's.",
    inputSchema: obj({ id, verdict: { type: "string", enum: ["approve", "request_changes", "comment"] }, summary: str }, ["id"]),
    run: (a) => api("POST", `/api/runs/${encodeURIComponent(need(a, "id"))}/review/publish`, { verdict: a.verdict, summary: a.summary }),
  },
  {
    name: "get_actions", description: "What the agent of a session sent through the actions API: progress, finish, questions, requests waiting for a decision (comment, thread_resolve, request_domain, propose_followup) and recent events.",
    inputSchema: obj({ id }, ["id"]), run: (a) => api("GET", `/api/runs/${encodeURIComponent(need(a, "id"))}/actions`),
  },
  {
    name: "decide_action", description: "Approve or reject a pending request of the agent. Approving posts a comment or reply to the pull request, resolves a review thread, or creates an issue from a follow-up; a domain request is only acknowledged (the allowlist is changed by an operator). The agent is told the outcome.",
    inputSchema: obj({ id, action_id: str, decision: { type: "string", enum: ["approve", "reject"] }, note: { type: "string", description: "optional, sent to the agent" } }, ["id", "action_id", "decision"]),
    run: (a) => api("POST", `/api/runs/${encodeURIComponent(need(a, "id"))}/actions/${encodeURIComponent(need(a, "action_id"))}/decide`, { decision: a.decision, note: a.note }),
  },
  {
    name: "answer_question", description: "Answer a question of the agent (an option id or a text); the agent gets it as an event.",
    inputSchema: obj({ id, question_id: str, option_id: str, text: str }, ["id", "question_id"]),
    run: (a) => api("POST", `/api/runs/${encodeURIComponent(need(a, "id"))}/answer`, { question_id: a.question_id, option_id: a.option_id, text: a.text }),
  },
  { name: "get_config", description: "Providers (no tokens), models and limits.", inputSchema: obj({}), run: () => api("GET", "/api/config") },
  { name: "health", description: "Health of yfactory, the sandbox service, S3 and LiteLLM.", inputSchema: obj({}), run: () => api("GET", "/health").catch((e) => ({ ok: false, error: e.message })) },
];

const backend: Backend = {
  tools: DEFS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  async call(name, args) {
    const d = DEFS.find((t) => t.name === name);
    if (!d) throw new Error(`unknown tool ${name}`);
    const r = await d.run(args ?? {});
    const text = typeof r === "string" ? r : JSON.stringify(r, null, 1);
    return text.length > MAX_OUT ? text.slice(0, MAX_OUT) + "\n[truncated]" : text;
  },
};

export const handle = (req: http.IncomingMessage, res: http.ServerResponse, raw: Buffer) => serve(req, res, raw, backend);
