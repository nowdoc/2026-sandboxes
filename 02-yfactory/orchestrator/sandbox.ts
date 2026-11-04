// node:http instead of fetch: undici cuts responses after 5 minutes, an agent run takes longer.
import http from "node:http";
import { CFG } from "./config.ts";
import type { Result } from "./proc.ts";
import type { Target } from "./proxy.ts";

export const PREFIX = "yf-";

function call(method: string, p: string, input?: Buffer | string, timeout = 60): Promise<any> {
  const url = new URL(p, CFG.sandbox.url);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: { Authorization: `Bearer ${CFG.sandbox.token}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        const data = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        if ((res.statusCode ?? 500) >= 300) reject(new Error(`sandbox ${method} ${url.pathname} -> ${res.statusCode}: ${data.error ?? ""}`));
        else resolve(data);
      });
    });
    req.setTimeout((timeout + 60) * 1000, () => req.destroy(new Error("sandbox timeout")));
    req.on("error", reject);
    req.end(input);
  });
}

export async function exec(name: string, cmd: string, stdin?: Buffer | string, timeout = 900, user = "agent"): Promise<Result> {
  const q = new URLSearchParams({ cmd, timeout: String(timeout), user });
  const r = await call("POST", `/vms/${name}/exec?${q}`, stdin ?? "", timeout);
  return { code: r.code, stdout: Buffer.from(r.stdout, "base64"), stderr: Buffer.from(r.stderr, "base64") };
}

// The browser's headers go on (code-server checks Origin against Host), the authorization is this service's own.
export function ideTarget(name: string, path: string, headers: http.IncomingHttpHeaders): Target {
  const url = new URL(CFG.sandbox.url);
  return { host: url.hostname, port: Number(url.port) || 80, path: `/vms/${name}/http${path}`, headers: { ...headers, authorization: `Bearer ${CFG.sandbox.token}` } };
}

export const create = (name: string) => call("POST", `/vms/${name}`, "", 300);
export const start = (name: string) => call("POST", `/vms/${name}/start`, "", 120);
export const remove = (name: string) => call("DELETE", `/vms/${name}`, undefined, 120);
export const list = (): Promise<string[]> => call("GET", "/vms");

// A terminal: the request stays open for the keystrokes, the response carries the screen bytes.
export function shell(name: string, rows: number, cols: number): Promise<{ req: http.ClientRequest; res: http.IncomingMessage }> {
  const url = new URL(`/vms/${name}/shell?rows=${rows}&cols=${cols}`, CFG.sandbox.url);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: "POST", headers: { Authorization: `Bearer ${CFG.sandbox.token}`, "Transfer-Encoding": "chunked" } }, (res) =>
      (res.statusCode === 200 ? resolve({ req, res }) : (res.resume(), reject(new Error(`sandbox shell -> ${res.statusCode}`)))));
    req.on("error", reject);
    req.flushHeaders();
  });
}
