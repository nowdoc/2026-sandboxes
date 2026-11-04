// Yfactory UI: staticke soubory z ui/ a maly JSON API. Nikdy neposila tokeny ani vystup sandboxu.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Project } from "./registry.ts";
import * as runs from "./runs.ts";

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui");
const PORT = 8088;
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

type Deps = { cfg: Record<string, string>; projects: Project[]; runtimes: string[]; defaultRuntime: string };

export function startUi({ cfg, projects, runtimes, defaultRuntime }: Deps) {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const REPOS = [...byId.keys()];
  const bind = cfg.YFACTORY_BIND ?? process.env.FACTORY_BIND ?? "127.0.0.1";
  const origin = `http://${bind}:${PORT}`;

  const send = (res: http.ServerResponse, code: number, body: string | Buffer, type = "application/json", extra: Record<string, string> = {}) => {
    res.writeHead(code, {
      "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'", ...extra,
    }).end(body);
  };
  const json = (res: http.ServerResponse, code: number, data: object) => send(res, code, JSON.stringify(data));

  async function readJson(req: http.IncomingMessage) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 4096) throw new Error("too large");
      chunks.push(c);
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  }

  async function issues(res: http.ServerResponse) {
    const open = new Set(runs.list().filter((r) => r.status === "queued" || r.status === "running").map((r) => `${r.repo}#${r.issue}`));
    const out = [];
    for (const pj of projects) {
      for (const i of await pj.provider.listIssues(pj.repo)) {
        out.push({ repo: pj.id, number: i.number, title: i.title, labels: i.labels, active: open.has(`${pj.id}#${i.number}`) });
      }
    }
    json(res, 200, out);
  }

  async function start(req: http.IncomingMessage, res: http.ServerResponse) {
    let body: any;
    try { body = await readJson(req); } catch { return json(res, 400, { error: "neplatny request" }); }
    const pj = byId.get(body.repo ?? REPOS[0]);
    if (!pj) return json(res, 400, { error: "repo neni povolene" });
    if (typeof body.runtime !== "string" || !runtimes.includes(body.runtime)) return json(res, 400, { error: "neznamy runtime" });
    if (!Number.isInteger(body.issue) || body.issue < 1) return json(res, 400, { error: "neplatne issue" });
    let issue: Awaited<ReturnType<Project["provider"]["getIssue"]>>, base: string;
    try {
      issue = await pj.provider.getIssue(pj.repo, body.issue);
      base = await pj.provider.defaultBranch(pj.repo);
    } catch { return json(res, 404, { error: "issue neexistuje" }); }
    if (issue.changeRequest || !issue.open) return json(res, 400, { error: "issue neni otevrene" });
    try {
      const run = runs.submit({ project: pj.id, repo: pj.repo, issue, base, head: null, pr: null }, body.runtime, "ui");
      json(res, 202, { id: run.id, status: run.status });
    } catch (e) {
      if (e instanceof runs.ActiveError) return json(res, 409, { error: "ticket uz se implementuje" });
      throw e;
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = (req.url ?? "").split("?")[0];
      if (req.method === "POST") {
        // UI nema prihlaseni, Origin brani cizim strankam spoustet ulohy z prohlizece.
        if (req.headers.origin !== origin) return json(res, 403, { error: "origin" });
        if (url === "/api/runs") return await start(req, res);
        return json(res, 404, { error: "not found" });
      }
      if (req.method !== "GET") return json(res, 405, { error: "method" });
      if (url === "/api/config") return json(res, 200, { repos: REPOS, runtimes, defaultRuntime });
      if (url === "/api/issues") return await issues(res);
      if (url === "/api/runs") return json(res, 200, { runs: runs.list().slice(-100).reverse(), forgejo: projects[0].provider.webUrl, maxRunning: runs.MAX_RUNNING });
      const file = url === "/" ? "index.html" : url.slice(1);
      if (!/^[\w-]+\.(html|js|css)$/.test(file)) return json(res, 404, { error: "not found" });
      send(res, 200, fs.readFileSync(path.join(UI, file)), TYPES[path.extname(file)]);
    } catch (e) {
      console.error("ui", e);
      if (!res.headersSent) json(res, 502, { error: "chyba" });
    }
  });
  server.listen(PORT, bind, () => console.log(`yfactory on ${bind}:${PORT}`));
}
