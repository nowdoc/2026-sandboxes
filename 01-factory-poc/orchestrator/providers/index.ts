import type { IncomingHttpHeaders } from "node:http";
import type { Job } from "../runs.ts";
import { ForgejoProvider } from "./forgejo.ts";

// Normalizovane typy: zbytek orchestratoru nezna rozdil mezi PR a MR ani mezi number a iid.
export type Issue = { number: number; title: string; body: string };
export type IssueInfo = Issue & { open: boolean; changeRequest: boolean };
export type Feedback = {
  comments: { author: string; body: string }[];
  reviews: { author: string; body: string; path: string }[];
};
export type CiStatus = {
  state: string;
  statuses: { context: string | null; status: string | null; description: string | null }[];
};

// Job bez projektu: id projektu zna registr, ne provider.
export type JobSpec = Omit<Job, "project">;

export type Trigger = {
  repo: string;
  sender: unknown;
  dedupe: string | null; // jeden beh na issue, jen pro spusteni labelem
  load(): Promise<JobSpec>; // az po kontrole opravneni, muze volat API
};

// Zpracovana konfigurace: tajemstvi uz jsou nactena z .env (registry.ts).
export type ProviderConfig = {
  url: string;
  user: string;
  token: string;
  adminToken?: string;
  webhookSecret: string;
  label?: string; // label, ktery spousti ulohu, vychozi "factory"
};

// Jediny kontrakt, ktery musi origin splnit. Sandbox a staging o nem nevi nic.
export interface GitProvider {
  kind: string;
  botName: string;
  webUrl: string;
  verifyWebhook(headers: IncomingHttpHeaders, body: Buffer): boolean;
  parseEvent(headers: IncomingHttpHeaders, payload: any): Trigger | null;
  mayTrigger(repo: string, user: unknown): Promise<boolean>;
  repoUrl(repo: string): string; // clone/push URL
  gitAuthHeader(): string; // hodnota hlavicky Authorization pro git
  defaultBranch(repo: string): Promise<string>;
  getIssue(repo: string, number: number): Promise<IssueInfo>;
  listIssues(repo: string): Promise<{ number: number; title: string; labels: string[] }[]>;
  openChange(repo: string, change: { head: string; base: string; title: string; body: string }): Promise<number>;
  comment(repo: string, number: number, body: string): Promise<void>; // issue i PR/MR
  feedback(repo: string, number: number, change: number | null): Promise<Feedback>;
  ci(repo: string, sha: string): Promise<CiStatus>;
}

const PROVIDERS: Record<string, (cfg: ProviderConfig) => GitProvider> = {
  forgejo: (cfg) => new ForgejoProvider(cfg),
};

export function createProvider(kind: string, cfg: ProviderConfig): GitProvider {
  const make = PROVIDERS[kind];
  if (!make) throw new Error(`neznamy druh provideru ${kind}`);
  return make(cfg);
}
