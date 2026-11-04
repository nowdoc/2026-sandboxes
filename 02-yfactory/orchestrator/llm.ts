import http from "node:http";
import { CFG } from "./config.ts";

// The LLM routes a VM may call. Everything else on LiteLLM, the admin API included, stays out of reach.
const ROUTES = /^\/v1\/(chat\/completions|messages|messages\/count_tokens|responses|models)$/;
const MAX_BODY = 50 * 1024 * 1024;

export const isLlmRoute = (url: string) => ROUTES.test(url.split("?")[0]);

// Streams the request to LiteLLM with the run's own virtual key; the VM only ever holds its run token.
export function forward(req: http.IncomingMessage, res: http.ServerResponse, key: string) {
  const u = new URL(CFG.litellm.url);
  const headers = { ...req.headers, host: u.host, authorization: `Bearer ${key}` };
  delete headers["x-api-key"];
  const up = http.request({ host: u.hostname, port: u.port, path: req.url, method: req.method, headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.setTimeout(600_000, () => up.destroy());
  up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  res.on("close", () => up.destroy());
  let n = 0;
  req.on("data", (c) => { if ((n += c.length) > MAX_BODY) { up.destroy(); if (!res.headersSent) res.writeHead(413); res.end(); } });
  req.pipe(up);
}
