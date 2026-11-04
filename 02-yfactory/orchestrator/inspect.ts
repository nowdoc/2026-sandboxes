// Inspect environment: a run without a PR whose agent proposes changes to the repository setup and its environment.
// The proposal comes from an agent that read the repository, so it can carry a prompt injection: a person applies it.
import type { Environment, Repo } from "./repos.ts";

export const FILE = "/workspace/.yf-proposal.json";
export const LABEL = "Inspect environment";
const MAX_SCRIPT = 64 * 1024, MAX_LOG = 20_000;

export type Proposal = {
  summary: string;
  repository: { setup: string; env: Record<string, string> } | null;
  environment: { setup: string; maintenance: string; env: Record<string, string> } | null;
  allowlist: string[];
};

const block = (s: string) => "```\n" + s.replace(/```/g, "'''") + "\n```";

export function prompt(repo: Repo, env: Environment, usedBy: string[], log: string): string {
  const tail = log.length > MAX_LOG ? "...\n" + log.slice(-MAX_LOG) : log;
  return `Inspect how the development environment of ${repo.repo} is prepared. Do not change the project, do not commit, do not push.

How yfactory prepares a VM (Debian, the agent works as user \`agent\` without sudo):
1. environment setup: root, cwd /, before the clone
2. clone of the repository into /workspace
3. repository setup: root, cwd /workspace
4. environment maintenance: root, cwd /workspace, before the agent in every run
Scripts run with \`bash -e\`. The network allows only the domains of the package registries through a proxy (HTTP_PROXY is set; npm and pip use their default registries); other domains are blocked.

Current environment "${env.name}" (used by ${usedBy.join(", ")}):
${block(JSON.stringify({ setup: env.setup, maintenance: env.maintenance, env: env.env }, null, 1))}

Current repository settings (empty setup means .yfactory/setup.sh from the repository, if present):
${block(JSON.stringify({ setup: repo.setup, env: repo.env }, null, 1))}

Output of the setup steps in this run:
${block(tail || "(no output)")}

Task:
1. Find out what the project needs to install, build and test: package manifests and lock files, README, CI workflows, .devcontainer, Dockerfile, .tool-versions and similar.
2. Run the install, build and test commands as \`agent\` and see what fails. Root steps you cannot run yourself go into the setup scripts.
3. Send the proposal with \`yf-act propose_environment - <<'JSON'\` followed by the JSON and a line \`JSON\`:
{"summary": "what fails and why, and what the change does", "repository": {"setup": "...", "env": {}} or null, "environment": {"setup": "...", "maintenance": "...", "env": {}} or null, "allowlist": ["domains the proxy would have to allow"]}
It prints a JSON result: status "accepted" means it was stored; "rejected" has a message, fix the JSON and send it again. Only if yf-act is not available, write the same JSON to ${FILE}.

Rules: whole scripts, not diffs; null for a part that needs no change; repository-specific steps go into the repository setup; change the environment only for what every repository using it needs; maintenance is for quick per-run steps such as refreshing dependencies; scripts must be idempotent; env holds only variables to add or change (existing ones are kept); never put secrets into env; variable names must not start with LLM_, TASK_, GIT_, YF_ or OPENCODE_.`;
}

const str = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v.replace(/\r\n/g, "\n") : null);

function env(v: unknown): Record<string, string> | null {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) return null;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)]));
}

// Shape and size only; names and reserved variables are checked again when a part is applied.
export function parse(raw: string): Proposal | string {
  let p: any;
  try { p = JSON.parse(raw); } catch { return raw.trim() ? "the proposal is not valid JSON" : "the agent wrote no proposal"; }
  const summary = str(p?.summary, 8000);
  if (summary === null) return "the proposal has no summary";
  let repository: Proposal["repository"] = null, environment: Proposal["environment"] = null;
  if (p.repository) {
    const setup = str(p.repository.setup ?? "", MAX_SCRIPT), e = env(p.repository.env);
    if (setup === null || !e) return "invalid repository part";
    repository = { setup, env: e };
  }
  if (p.environment) {
    const setup = str(p.environment.setup ?? "", MAX_SCRIPT), maintenance = str(p.environment.maintenance ?? "", MAX_SCRIPT), e = env(p.environment.env);
    if (setup === null || maintenance === null || !e) return "invalid environment part";
    environment = { setup, maintenance, env: e };
  }
  const allowlist = (Array.isArray(p.allowlist) ? p.allowlist : []).map(String).filter((d: string) => /^[\w.-]{1,253}$/.test(d)).slice(0, 50);
  return { summary, repository, environment, allowlist };
}
