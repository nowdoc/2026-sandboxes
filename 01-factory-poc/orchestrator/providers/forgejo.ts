import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { api } from "../http.ts";
import type { CiStatus, Feedback, GitProvider, IssueInfo, ProviderConfig, Trigger } from "./index.ts";

export class ForgejoProvider implements GitProvider {
  kind = "forgejo";
  botName: string;
  webUrl: string;
  label: string;
  #cfg: ProviderConfig;

  constructor(cfg: ProviderConfig) {
    if (!cfg.adminToken) throw new Error("forgejo provider potrebuje adminTokenEnv (kontrola prav odesilatele)");
    this.#cfg = cfg;
    this.webUrl = cfg.url;
    this.botName = cfg.user;
    this.label = cfg.label ?? "factory";
  }

  #call(method: string, p: string, body?: unknown, token = this.#cfg.token) {
    return api(method, p, body, {
      base: this.webUrl + "/api/v1",
      headers: { Authorization: "token " + token, "Content-Type": "application/json" },
    });
  }

  verifyWebhook(headers: IncomingHttpHeaders, body: Buffer) {
    const want = Buffer.from(createHmac("sha256", this.#cfg.webhookSecret).update(body).digest("hex"));
    const got = Buffer.from(String(headers["x-forgejo-signature"] ?? ""));
    return want.length === got.length && timingSafeEqual(want, got);
  }

  parseEvent(headers: IncomingHttpHeaders, p: any): Trigger | null {
    const event = String(headers["x-forgejo-event"] ?? "");
    const issue = p.issue;
    if (!issue) return null;
    const repo = p.repository.full_name;
    const sender = p.sender?.login;
    if (event === "issues" && ["label_updated", "labeled", "opened"].includes(p.action)) {
      if (issue.pull_request || !(issue.labels ?? []).some((l: any) => l.name === this.label)) return null;
      return {
        repo, sender, dedupe: `${repo}#${issue.number}`,
        load: async () => ({ repo, issue, base: p.repository.default_branch, head: null, pr: null }),
      };
    }
    if (["issue_comment", "pull_request_comment"].includes(event) && p.action === "created" && issue.pull_request) {
      if (!String(p.comment.body).startsWith("/factory")) return null;
      return {
        repo, sender, dedupe: null,
        load: async () => {
          const pr = await this.#call("GET", `/repos/${repo}/pulls/${issue.number}`);
          return { repo, issue: { ...issue, body: p.comment.body }, base: pr.base.ref, head: pr.head.ref, pr: issue.number };
        },
      };
    }
    return null;
  }

  async mayTrigger(repo: string, user: unknown) {
    if (typeof user !== "string" || user === this.botName) return false;
    try {
      // Bot s pravem write cizi prava cist nesmi a admina z nej nedelame, aby nemohl mergovat.
      const r = await this.#call("GET", `/repos/${repo}/collaborators/${encodeURIComponent(user)}/permission`, undefined, this.#cfg.adminToken);
      return ["write", "admin", "owner"].includes(r.permission);
    } catch {
      return false;
    }
  }

  repoUrl(repo: string) {
    return `${this.webUrl}/${repo}.git`;
  }

  gitAuthHeader() {
    // Token jde jen hlavickou, do .git/config se nezapise.
    return "Basic " + Buffer.from(`${this.botName}:${this.#cfg.token}`).toString("base64");
  }

  async defaultBranch(repo: string) {
    return (await this.#call("GET", `/repos/${repo}`)).default_branch;
  }

  async getIssue(repo: string, number: number): Promise<IssueInfo> {
    const i = await this.#call("GET", `/repos/${repo}/issues/${number}`);
    return { number: i.number, title: i.title, body: i.body ?? "", open: i.state === "open", changeRequest: Boolean(i.pull_request) };
  }

  async listIssues(repo: string) {
    const list = await this.#call("GET", `/repos/${repo}/issues?state=open&type=issues&limit=50`);
    return list.map((i: any) => ({ number: i.number, title: i.title, labels: (i.labels ?? []).map((l: any) => l.name) }));
  }

  async openChange(repo: string, { head, base, title, body }: { head: string; base: string; title: string; body: string }) {
    return (await this.#call("POST", `/repos/${repo}/pulls`, { head, base, title, body })).number;
  }

  async comment(repo: string, number: number, body: string) {
    await this.#call("POST", `/repos/${repo}/issues/${number}/comments`, { body });
  }

  async feedback(repo: string, number: number, change: number | null): Promise<Feedback> {
    const comments = (await this.#call("GET", `/repos/${repo}/issues/${number}/comments`)).map((c: any) => ({ author: c.user.login, body: c.body }));
    const reviews: Feedback["reviews"] = [];
    if (change) {
      for (const review of await this.#call("GET", `/repos/${repo}/pulls/${change}/reviews`)) {
        for (const c of await this.#call("GET", `/repos/${repo}/pulls/${change}/reviews/${review.id}/comments`)) {
          reviews.push({ author: c.user.login, body: c.body, path: c.path });
        }
      }
    }
    return { comments, reviews };
  }

  async ci(repo: string, sha: string): Promise<CiStatus> {
    const status = await this.#call("GET", `/repos/${repo}/commits/${sha}/status`);
    return {
      state: status.state || "none",
      statuses: (status.statuses || []).map((s: any) => ({ context: s.context ?? null, status: s.status ?? null, description: s.description ?? null })),
    };
  }
}
