// /yf/*: the task API of the actions (api/ACTIONS.md). The caller has found the run by its token, so an action can only
// address its own run.
import type http from "node:http";
import * as act from "./actions.ts";
import * as git from "./git.ts";
import { body, json } from "./httpx.ts";
import { inc } from "./metrics.ts";
import * as runs from "./runs.ts";
import type { Run } from "./runs.ts";

const MAX_BODY = 512 * 1024;

const hits = new Map<string, number[]>();

export async function serve(req: http.IncomingMessage, res: http.ServerResponse, run: Run, deps: act.Deps) {
  const u = new URL(req.url!, "http://task");
  if (req.method === "GET" && u.pathname === "/yf/context") return json(res, 200, act.context(run));
  if (req.method === "GET" && u.pathname === "/yf/events") {
    const after = Math.max(0, Number(u.searchParams.get("after")) || 0), wait = Math.min(30, Math.max(0, Number(u.searchParams.get("wait")) || 0));
    return json(res, 200, { events: await act.events(run, after, wait * 1000) });
  }
  if (req.method === "POST" && u.pathname === "/yf/actions") {
    const now = Date.now(), recent = (hits.get(run.id) ?? []).filter((t) => now - t < 10_000);
    hits.set(run.id, recent);
    if (recent.length >= 30) { req.resume(); inc("yf_task_api_denied_total", { route: "yf", code: 429 }); return json(res, 429, { error: "too many actions, slow down" }); }
    recent.push(now);
    // Answer an oversized body before reading it: a connection that is cut off tells the agent nothing.
    if (Number(req.headers["content-length"]) > MAX_BODY) { req.resume(); return json(res, 413, { error: "body too large" }); }
    let raw: unknown;
    try { raw = JSON.parse((await body(req, MAX_BODY)).toString()); } catch (e) {
      return json(res, (e as Error).message === "too large" ? 413 : 400, { error: (e as Error).message === "too large" ? "body too large" : "invalid JSON" });
    }
    try {
      // One action at a time per run: idempotency and the limits read state that the previous action writes.
      const result = await git.locked(`act:${run.id}`, () => act.handle(run, raw, deps));
      runs.save();
      inc("yf_actions_total", { type: String((raw as any)?.type ?? "invalid").slice(0, 24), status: result.status });
      return json(res, 200, result);
    } catch (e) {
      console.error(`[${run.id}] action`, e instanceof Error ? e.message : e);
      return json(res, 502, { error: "the orchestrator could not complete the action, retry with the same id" });
    }
  }
  req.resume();
  return res.writeHead(404).end();
}

