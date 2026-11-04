// Staging: neutralni git server mezi sandboxem a originem (GitLab, GitHub, Forgejo). Agent do nej pushuje
// pres proxy v orchestratoru (identita je TASK_TOKEN, token stagingu sandbox nikdy nevidi). Orchestrator pak
// vetev ze stagingu stahne, zkontroluje a pushne do originu.
import http from "node:http";
import https from "node:https";
import { api, HttpError } from "./http.ts";
import type { StagingConfig } from "./registry.ts";

export class Staging {
  url: string;
  user: string;
  #token: string;
  #admin: string;

  constructor(cfg: StagingConfig) {
    this.url = cfg.url;
    this.user = cfg.user;
    this.#token = cfg.token;
    this.#admin = cfg.adminToken; // jen pro zalozeni repa, bot na to nema scope
  }

  name(repo: string) {
    return repo.replace(/\//g, "__");
  }

  repoUrl(name: string) {
    return `${this.url}/${this.user}/${name}.git`;
  }

  authHeader() {
    return "Basic " + Buffer.from(`${this.user}:${this.#token}`).toString("base64");
  }

  #call(method: string, p: string, body?: unknown, token = this.#token) {
    return api(method, p, body, { base: this.url + "/api/v1", headers: { Authorization: "token " + token, "Content-Type": "application/json" } });
  }

  async ensureRepo(name: string) {
    try {
      await this.#call("GET", `/repos/${this.user}/${name}`);
      return;
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 404) throw e;
    }
    await this.#call("POST", `/admin/users/${this.user}/repos`, { name, private: true }, this.#admin);
    // Zadne CI na stagingu: workflow z agentovy vetve se nesmi spustit.
    await this.#call("PATCH", `/repos/${this.user}/${name}`, { has_actions: false }, this.#admin).catch((e) => console.error("staging actions", e.name));
  }

  // Preposle smart HTTP git protokol. Volajici uz overil token a cestu.
  proxy(name: string, rest: string, req: http.IncomingMessage, res: http.ServerResponse) {
    const target = new URL(`${this.url}/${this.user}/${name}.git/${rest}`);
    const headers: Record<string, string> = { Authorization: this.authHeader() };
    for (const h of ["content-type", "content-encoding", "content-length", "accept", "git-protocol"]) {
      const v = req.headers[h];
      if (typeof v === "string") headers[h] = v;
    }
    const up = (target.protocol === "https:" ? https : http).request(target, { method: req.method, headers }, (r) => {
      const out: Record<string, string> = {};
      for (const h of ["content-type", "cache-control", "expires", "pragma"]) {
        const v = r.headers[h];
        if (typeof v === "string") out[h] = v;
      }
      res.writeHead(r.statusCode ?? 502, out);
      r.pipe(res);
    });
    up.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    res.on("close", () => up.destroy());
    req.pipe(up);
  }
}
