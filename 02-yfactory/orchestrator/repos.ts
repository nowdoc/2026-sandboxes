// Providers from config/yfactory/providers.json, which only the operator edits. Environments and repositories are state
// edited in the UI, in projects.json in the data volume, scripts next to it: setup/<owner>/<repo>.sh and
// environments/<name>/{setup,maintenance}.sh.
// Env values reach an untrusted VM, so they must not be secrets.
import fs from "node:fs";
import path from "node:path";
import { CFG } from "./config.ts";

export type Provider = { id: string; kind: "github" | "forgejo" | "gitlab"; url: string; api: string; user: string; tokenEnv: string; token: string };

export type Environment = {
  name: string;
  setup: string; // shell script, root in the VM, right after create, before clone
  maintenance: string; // shell script, root in the VM, cwd /workspace, every run after the repository setup
  env: Record<string, string>; // overridden by the repository env
};

export type Repo = {
  repo: string;
  provider: string;
  base: string | null; // null: the provider's default branch
  environment: string;
  setup: string; // shell script, root in the VM, after clone; empty: .yfactory/setup.sh from the repository if present
  env: Record<string, string>;
  model: string | null; // default model of new sessions, null: the first available
  models: string[]; // models a session may use, empty: all
  reviewPublish: "draft" | "auto"; // review runs: findings wait in the UI for a person (draft) or go to the forge at once (auto)
};

const PROVIDERS = path.join(CFG.config, "providers.json");
const FILE = path.join(CFG.projects, "projects.json");
const SETUP = path.join(CFG.projects, "setup");
const RESERVED = /^(LLM_|TASK_|GIT_|YF_|OPENCODE_)|^(HTTPS?_PROXY|NO_PROXY|HOME|PATH|USER)$/i;
const NAME = /^[\w.-]+\/[\w.-]+$/;
const ENV_NAME = /^[a-z0-9][a-z0-9-]*$/;
const ENVS = path.join(CFG.projects, "environments");
const MAX_SCRIPT = 64 * 1024;
// A provider token is read from the orchestrator's own env, which also holds the LiteLLM master key and the S3 keys,
// so a typo in providers.json must not send one of those to a provider.
const TOKEN_ENV = /^(GITHUB|FORGEJO|GITLAB)_TOKEN(_[A-Z0-9]+)*$/;
const KINDS = { github: (url: string) => url === "https://github.com" ? "https://api.github.com" : `${url}/api/v3`, forgejo: (url: string) => `${url}/api/v1`, gitlab: (url: string) => `${url}/api/v4` };

let providers = new Map<string, Provider>();
let repos: Repo[] = [];
let envs: Environment[] = [];

export const validName = (repo: string) => NAME.test(repo) && !repo.split("/").some((p) => p === "." || p === "..");
const setupFile = (repo: string) => path.join(SETUP, `${repo}.sh`);
const envFile = (name: string, kind: "setup" | "maintenance") => path.join(ENVS, name, `${kind}.sh`);
const readScript = (f: string) => fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
const read = () => fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : {};

// Throws on an invalid file: a broken deployment config should stop the orchestrator, not run with half of it.
export function load() {
  const raw = read();
  providers = new Map();
  for (const [id, p] of Object.entries<any>(JSON.parse(fs.readFileSync(PROVIDERS, "utf8")))) {
    const api = KINDS[p.kind as keyof typeof KINDS];
    if (!api) throw new Error(`provider ${id}: unknown kind ${p.kind}`);
    const url = String(p.url ?? "").replace(/\/+$/, "");
    if (!/^https?:\/\//.test(url)) throw new Error(`provider ${id}: url must be http(s)`);
    if (!TOKEN_ENV.test(p.tokenEnv ?? "")) throw new Error(`provider ${id}: tokenEnv must match ${TOKEN_ENV.source}, e.g. GITHUB_TOKEN_ACME`);
    providers.set(id, { id, kind: p.kind, url, api: p.api ?? api(url), user: p.user ?? "", tokenEnv: p.tokenEnv, token: process.env[p.tokenEnv] ?? "" });
  }
  if (!providers.size) throw new Error(`${PROVIDERS}: no providers`);
  for (const p of providers.values()) if (!p.token) console.warn(`provider ${p.id}: ${p.tokenEnv} is not set, its repositories cannot run`);
  envs = Object.entries<any>(raw.environments ?? {}).map(([name, e]) => {
    if (!ENV_NAME.test(name)) throw new Error(`environment ${name}: invalid name`);
    return { name, setup: readScript(envFile(name, "setup")), maintenance: readScript(envFile(name, "maintenance")), env: e.env ?? {} };
  }).sort((a, b) => a.name.localeCompare(b.name));
  repos = Object.entries<any>(raw.repositories ?? {}).map(([repo, r]) => {
    if (!validName(repo)) throw new Error(`repository ${repo}: must be owner/name`);
    if (!providers.has(r.provider)) throw new Error(`repository ${repo}: unknown provider ${r.provider}`);
    const f = setupFile(repo);
    const environment = r.environment ?? r.profile ?? "default"; // profile: the old name
    if (!getEnv(environment)) throw new Error(`repository ${repo}: unknown environment ${environment}`);
    return { repo, provider: r.provider, base: r.base ?? null, environment, setup: readScript(f), env: r.env ?? {}, model: r.model ?? null, models: r.models ?? [], reviewPublish: r.reviewPublish === "auto" ? "auto" : "draft" };
  }).sort((a, b) => a.repo.localeCompare(b.repo));
}

// Only non-default fields, so the file stays readable.
function save() {
  const raw: any = {};
  raw.environments = Object.fromEntries(envs.map((e) => [e.name, Object.keys(e.env).length ? { env: e.env } : {}]));
  raw.repositories = Object.fromEntries(repos.map((r) => [r.repo, {
    provider: r.provider, ...(r.base && { base: r.base }), ...(r.environment !== "default" && { environment: r.environment }),
    ...(Object.keys(r.env).length && { env: r.env }),
    ...(r.model && { model: r.model }), ...(r.models.length && { models: r.models }), ...(r.reviewPublish === "auto" && { reviewPublish: "auto" }),
  }]));
  fs.mkdirSync(CFG.projects, { recursive: true });
  fs.writeFileSync(FILE + ".tmp", JSON.stringify(raw, null, 2) + "\n");
  fs.renameSync(FILE + ".tmp", FILE);
}

function saveScript(f: string, script: string) {
  if (!script.trim()) return fs.rmSync(f, { force: true });
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, script.endsWith("\n") ? script : script + "\n");
}

export const all = () => repos;
export const environments = () => envs;
export const getEnv = (name: string) => envs.find((e) => e.name === name);
export const get = (repo: string) => repos.find((r) => r.repo === repo);
export const providerList = () => [...providers.values()].map(({ id, kind, url, tokenEnv, token }) => ({ id, kind, url, tokenEnv, ready: !!token }));

export function providerOf(repo: string): Provider {
  const r = get(repo);
  if (!r) throw new Error(`repository ${repo} is not configured`);
  return providers.get(r.provider)!;
}

function parseEnv(input: any): Record<string, string> | string {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return `invalid variable name ${k}`;
    if (RESERVED.test(k)) return `variable ${k} is reserved`;
    env[k] = String(v);
  }
  return env;
}

const text = (v: unknown) => String(v ?? "").replace(/\r\n/g, "\n");

// Returns an error message, or null when saved.
export function put(input: any): string | null {
  const repo = String(input.repo ?? "");
  if (!validName(repo)) return "repository must be owner/name";
  const provider = String(input.provider || providers.keys().next().value);
  if (!providers.has(provider)) return `unknown provider ${provider}`;
  const base = input.base ? String(input.base) : null;
  if (base && (!/^[\w][\w./-]*$/.test(base) || base.includes(".."))) return "invalid branch";
  const environment = String(input.environment || "default");
  if (!getEnv(environment)) return `unknown environment ${environment}`;
  const setup = text(input.setup);
  if (setup.length > MAX_SCRIPT) return "setup script is too long";
  const env = parseEnv(input.env);
  if (typeof env === "string") return env;
  const models = [...new Set((Array.isArray(input.models) ? input.models : []).map(String))] as string[];
  for (const m of models) if (!CFG.litellm.models.includes(m)) return `unknown model ${m}`;
  const model = input.model ? String(input.model) : null;
  if (model && !(models.length ? models : CFG.litellm.models).includes(model)) return `default model ${model} is not among the allowed models`;
  repos = [...repos.filter((r) => r.repo !== repo), { repo, provider, base, environment, setup, env, model, models, reviewPublish: input.reviewPublish === "auto" ? "auto" : "draft" }].sort((a, b) => a.repo.localeCompare(b.repo));
  saveScript(setupFile(repo), setup);
  save();
  return null;
}

export function remove(repo: string) {
  if (!get(repo)) return;
  repos = repos.filter((r) => r.repo !== repo);
  saveScript(setupFile(repo), "");
  save();
}

export function putEnv(input: any): string | null {
  const name = String(input.name ?? "");
  if (!ENV_NAME.test(name)) return "name must be lowercase letters, digits and dashes";
  const setup = text(input.setup), maintenance = text(input.maintenance);
  if (setup.length > MAX_SCRIPT || maintenance.length > MAX_SCRIPT) return "script is too long";
  const env = parseEnv(input.env);
  if (typeof env === "string") return env;
  envs = [...envs.filter((e) => e.name !== name), { name, setup, maintenance, env }].sort((a, b) => a.name.localeCompare(b.name));
  saveScript(envFile(name, "setup"), setup);
  saveScript(envFile(name, "maintenance"), maintenance);
  save();
  return null;
}

export function removeEnv(name: string): string | null {
  if (!getEnv(name)) return null;
  const used = repos.filter((r) => r.environment === name).map((r) => r.repo);
  if (used.length) return `environment ${name} is used by ${used.join(", ")}`;
  envs = envs.filter((e) => e.name !== name);
  fs.rmSync(path.join(ENVS, name), { recursive: true, force: true });
  save();
  return null;
}
