// Registr providerů a projektů z projects.json. Tokeny v souboru nejsou, jen jména promennych z .env.
import fs from "node:fs";
import { createProvider, type GitProvider } from "./providers/index.ts";

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,30}$/;
const PROJECT_ID = /^[\w][\w./-]{0,100}$/;

export type Project = { id: string; repo: string; providerId: string; provider: GitProvider };
export type StagingConfig = { url: string; user: string; token: string; adminToken: string };
export type Registry = {
  defaultProvider: string; // prvni v souboru, bere ho starsi cesta /webhook bez id
  providers: Map<string, GitProvider>;
  projects: Map<string, Project>;
  staging: StagingConfig;
  byRepo(providerId: string, repo: string): Project | undefined;
};

type Obj = Record<string, unknown>;

function obj(v: unknown, where: string): Obj {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${where}: ocekavam objekt`);
  return v as Obj;
}

function only(o: Obj, allowed: string[], where: string) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new Error(`${where}: neznamy klic ${k}`);
}

function str(o: Obj, key: string, where: string, optional = false): string {
  const v = o[key];
  if (v === undefined && optional) return "";
  if (typeof v !== "string" || !v) throw new Error(`${where}: ${key} musi byt neprazdny retezec`);
  return v;
}

// Hodnotu tajemstvi bereme z .env, do chyby jde jen jmeno promenne.
function secret(env: Record<string, string>, o: Obj, key: string, where: string, optional = false): string {
  const name = str(o, key, where, optional);
  if (!name) return "";
  if (!env[name]) throw new Error(`${where}: promenna ${name} chybi v .env`);
  return env[name];
}

function url(o: Obj, where: string) {
  const u = str(o, "url", where).replace(/\/+$/, "");
  if (!/^https?:\/\/[^/\s]+$/.test(u)) throw new Error(`${where}: url musi byt http(s)://host[:port] bez cesty`);
  return u;
}

export function loadRegistry(file: string, env: Record<string, string>): Registry {
  let root: Obj;
  try {
    root = obj(JSON.parse(fs.readFileSync(file, "utf8")), file);
  } catch (e) {
    throw new Error(`registr ${file}: ${(e as Error).message}`);
  }
  only(root, ["providers", "staging", "projects"], file);

  const providers = new Map<string, GitProvider>();
  for (const [id, raw] of Object.entries(obj(root.providers, "providers"))) {
    const where = `providers.${id}`;
    if (!PROVIDER_ID.test(id)) throw new Error(`${where}: id musi byt [a-z0-9-]`);
    const d = obj(raw, where);
    only(d, ["kind", "url", "user", "tokenEnv", "adminTokenEnv", "webhookSecretEnv", "label"], where);
    providers.set(id, createProvider(str(d, "kind", where), {
      url: url(d, where), user: str(d, "user", where), token: secret(env, d, "tokenEnv", where),
      adminToken: secret(env, d, "adminTokenEnv", where, true), webhookSecret: secret(env, d, "webhookSecretEnv", where),
      label: str(d, "label", where, true) || undefined,
    }));
  }
  if (!providers.size) throw new Error("providers: aspon jeden provider");

  const s = obj(root.staging, "staging");
  only(s, ["url", "user", "tokenEnv", "adminTokenEnv"], "staging");
  const staging = {
    url: url(s, "staging"), user: str(s, "user", "staging"),
    token: secret(env, s, "tokenEnv", "staging"), adminToken: secret(env, s, "adminTokenEnv", "staging"),
  };

  const projects = new Map<string, Project>();
  const repos = new Set<string>();
  if (!Array.isArray(root.projects) || !root.projects.length) throw new Error("projects: aspon jeden projekt");
  root.projects.forEach((raw: unknown, i: number) => {
    const where = `projects[${i}]`;
    const p = obj(raw, where);
    only(p, ["id", "repo", "provider"], where);
    const repo = str(p, "repo", where);
    const providerId = str(p, "provider", where);
    const provider = providers.get(providerId);
    if (!provider) throw new Error(`${where}: provider ${providerId} neni definovany`);
    const id = str(p, "id", where, true) || repo;
    if (!PROJECT_ID.test(id)) throw new Error(`${where}: neplatne id`);
    if (projects.has(id)) throw new Error(`${where}: id ${id} uz existuje`);
    if (repos.has(`${providerId}/${repo}`)) throw new Error(`${where}: repo ${repo} u ${providerId} uz je v registru`);
    repos.add(`${providerId}/${repo}`);
    projects.set(id, { id, repo, providerId, provider });
  });

  const byKey = new Map([...projects.values()].map((p) => [`${p.providerId}/${p.repo}`, p]));
  return { defaultProvider: providers.keys().next().value!, providers, projects, staging, byRepo: (pid, repo) => byKey.get(`${pid}/${repo}`) };
}
