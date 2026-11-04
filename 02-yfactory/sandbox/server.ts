// Holds no credentials. Only the orchestrator can reach this API (control network + SANDBOX_TOKEN).
import { createHash, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import { inc, render } from "./metrics.ts";
import { run, sh } from "./proc.ts";
import { proxyHttp, proxyUpgrade } from "./proxy.ts";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing variable ${name}`);
  return v;
}

const TOKEN = createHash("sha256").update(need("SANDBOX_TOKEN")).digest();
const IMAGE = `ynfra/yfactory:vm-${need("YF_VM_VERSION")}`;
const TAR = `/images/${IMAGE.split(":")[1]}.tar`;
const API = process.env.YF_API_IP || "10.99.0.10";
const PROXY = process.env.YF_PROXY_IP || "10.99.0.11";
const CPUS = process.env.YF_VM_CPUS || "2";
const MEMORY = process.env.YF_VM_MEMORY || "4G";
const POOL = process.env.YF_VM_POOL || "10.200.0.0/16";
const NAME = /^yf-\w+$/;
const MAX_STDIN = 16 * 1024 * 1024;
// code-server in the VM listens on IDE_PORT; each VM gets a host port, bound to 127.0.0.1 of this container only.
const IDE_PORT = 8443, HOST_PORTS = [20000, 20999];

async function ensureImages() {
  const images = (await sh("msb", ["image", "ls"]).catch(() => "")).split("\n").map((l) => l.split(/\s+/)[0]);
  if (!images.includes(IMAGE)) await sh("msb", ["load", "-q", "-i", TAR], { timeout: 900 });
  // Other versions are never used again; each one is hundreds of MB in MSB_HOME.
  const old = images.filter((i) => i.startsWith("ynfra/yfactory:vm-") && i !== IMAGE);
  if (old.length) await run("msb", ["image", "rm", ...old], { timeout: 300 });
}

// Counts and seconds per operation, labelled ok or error.
async function timed<T extends { code: number }>(op: string, p: Promise<T>): Promise<T> {
  const t = Date.now();
  const r = await p;
  inc("yf_sandbox_ops_total", { op, result: r.code ? "error" : "ok" });
  inc("yf_sandbox_op_seconds_total", { op }, (Date.now() - t) / 1000);
  return r;
}

async function list(): Promise<string[]> {
  const r = await run("msb", ["ls", "--format", "json"]);
  if (r.code) return [];
  return (JSON.parse(r.stdout.toString() || "[]") as { name: string }[]).map((s) => s.name).filter((n) => NAME.test(n));
}

const ports = new Map<string, number>();
// From msb, so it survives a restart of this service. VMs created before the IDE have no port.
async function portOf(name: string): Promise<number | undefined> {
  if (ports.has(name)) return ports.get(name);
  const r = await run("msb", ["inspect", name, "--format", "json"]);
  if (r.code) return undefined;
  const p = JSON.parse(r.stdout.toString()).active_config?.network?.ports?.find((p: { guest_port: number }) => p.guest_port === IDE_PORT)?.host_port;
  if (p) ports.set(name, p);
  return p;
}

// One create at a time, so two VMs never pick the same host port.
let creating: Promise<unknown> = Promise.resolve();
function create(name: string) {
  const next = creating.catch(() => {}).then(async () => {
    const used = new Set(await Promise.all((await list()).map(portOf)));
    let port = HOST_PORTS[0];
    while (used.has(port)) port++;
    if (port > HOST_PORTS[1]) return { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("no free host port") };
    const rules = [`allow@${API}:tcp:9001`, `allow@${PROXY}:tcp:3128`].join(",");
    const r = await run("msb", ["create", "-q", "-n", name, "-c", CPUS, "-m", MEMORY, "--net-default-egress", "deny",
      "--net-ipv4-pool", POOL, "--net-rule", rules, "-p", `127.0.0.1:${port}:${IDE_PORT}`, IMAGE], { timeout: 300 });
    if (!r.code) ports.set(name, port);
    return r;
  });
  creating = next;
  return next;
}

// The token is for this API only, never forwarded into the VM.
async function ideTarget(name: string, url: URL, req: http.IncomingMessage) {
  // The map first: code-server loads hundreds of files, msb ls for each would be slow.
  const port = ports.get(name) ?? ((await list()).includes(name) ? await portOf(name) : undefined);
  if (!port) return undefined;
  const { authorization: _, ...headers } = req.headers;
  return { host: "127.0.0.1", port, path: (url.pathname.slice(`/vms/${name}/http`.length) || "/") + url.search, headers };
}

function body(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (d: Buffer) => { size += d.length; if (size > MAX_STDIN) { reject(new Error("too large")); req.destroy(); } else chunks.push(d); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, code: number, data: unknown) {
  const raw = Buffer.from(JSON.stringify(data));
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": raw.length }).end(raw);
}

function authorized(req: http.IncomingMessage) {
  const got = createHash("sha256").update((req.headers.authorization ?? "").replace(/^Bearer /, "")).digest();
  return timingSafeEqual(got, TOKEN);
}

// msb exec -t needs a tty on its own stdin and Node has no pty, so `script` provides one. The size is fixed at start.
function shell(name: string, url: URL, req: http.IncomingMessage, res: http.ServerResponse) {
  const size = (key: string, def: number, max: number) => Math.min(max, Math.max(5, Math.floor(Number(url.searchParams.get(key))) || def));
  const rows = size("rows", 24, 200), cols = size("cols", 80, 400);
  const child = spawn("script", ["-qfec", `stty rows ${rows} cols ${cols}; exec msb exec -t -e TERM=xterm-256color -u agent ${name} -- bash -l`, "/dev/null"], { stdio: ["pipe", "pipe", "ignore"] });
  inc("yf_sandbox_ops_total", { op: "shell", result: "ok" });
  res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" });
  res.flushHeaders();
  req.pipe(child.stdin).on("error", () => {});
  child.stdout.pipe(res);
  const stop = () => child.kill("SIGHUP");
  const limit = setTimeout(stop, 8 * 3600 * 1000);
  res.on("close", stop);
  req.on("error", stop);
  child.on("exit", () => { clearTimeout(limit); res.end(); });
}

// GET /vms · POST /vms/<name> · POST /vms/<name>/exec?cmd=&timeout=&user= (body = stdin) · DELETE /vms/<name>
// POST /vms/<name>/shell?rows=&cols= : a terminal, the request body is the keystrokes and the response the screen bytes, until either side closes
// any /vms/<name>/http/<path> : HTTP and WebSocket to code-server in the VM
async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  // Counts only, no names or output, so no token needed.
  if (req.url === "/metrics" && req.method === "GET") {
    const raw = render([["yf_sandbox_vms", {}, (await list()).length]]);
    return res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" }).end(raw);
  }
  if (req.url === "/health" && req.method === "GET") {
    const msb = await run("msb", ["ls", "--format", "json"], { timeout: 5 }).then((r) => r.code ? `exit ${r.code}` : "ok", (e: Error) => e.name === "CommandError" ? "timeout" : "unreachable");
    return json(res, msb === "ok" ? 200 : 503, { ok: msb === "ok", checks: { msb } });
  }
  if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
  const url = new URL(req.url ?? "/", "http://sandbox");
  const [, root, name, action] = url.pathname.split("/");
  if (root !== "vms") return json(res, 404, { error: "not found" });
  if (!name) return req.method === "GET" ? json(res, 200, await list()) : json(res, 405, { error: "method" });
  if (!NAME.test(name)) return json(res, 400, { error: "invalid name" });
  if (action === "http") {
    const t = await ideTarget(name, url, req);
    return t ? proxyHttp(req, res, t) : json(res, 404, { error: "no such VM, or it has no IDE port" });
  }
  if (req.method === "DELETE" && !action) {
    await timed("remove", run("msb", ["rm", "-f", name], { timeout: 120 }));
    ports.delete(name);
    return json(res, 200, { removed: name });
  }
  if (req.method !== "POST") return json(res, 405, { error: "method" });
  if (!action) {
    const r = await timed("create", create(name));
    return r.code ? json(res, 500, { error: `msb create exit ${r.code}: ${r.stderr.toString().slice(-300)}` }) : json(res, 201, { created: name });
  }
  // After a restart of this service a VM is `crashed`: its disk is intact, but a bare `msb exec` boots it only for that one command
  // and stops it again, so anything meant to keep running (code-server) needs a real start. Idempotent.
  if (action === "start") {
    if (!(await list()).includes(name)) return json(res, 404, { error: "no such VM" });
    const r = await timed("start", run("msb", ["start", "-q", name], { timeout: 120 }));
    return r.code && !/already running/.test(r.stderr.toString()) ? json(res, 500, { error: `msb start exit ${r.code}: ${r.stderr.toString().slice(-300)}` }) : json(res, 200, { started: name });
  }
  if (action === "shell") return (await list()).includes(name) ? shell(name, url, req, res) : json(res, 404, { error: "no such VM" });
  if (action !== "exec") return json(res, 404, { error: "not found" });
  const cmd = url.searchParams.get("cmd") ?? "";
  const timeout = Math.min(Number(url.searchParams.get("timeout")) || 900, 6 * 3600);
  // root only for the setup step; the VM is the boundary, root inside it reaches nothing more.
  const user = url.searchParams.get("user") === "root" ? "root" : "agent";
  const r = await timed("exec", run("msb", ["exec", "-u", user, name, "--", "sh", "-c", cmd], { input: await body(req), timeout })
    .catch((e) => ({ code: 124, stdout: Buffer.alloc(0), stderr: Buffer.from(String(e.message)) })));
  json(res, 200, { code: r.code, stdout: r.stdout.toString("base64"), stderr: r.stderr.toString("base64") });
}

await ensureImages();
const server = http.createServer((q, r) => handle(q, r).catch((e) => { console.error(e); if (!r.headersSent) json(r, 500, { error: "internal" }); else r.end(); }));
// Exec of an agent run takes up to YF_RUN_TIMEOUT, the default 5 min request timeout would cut it.
server.requestTimeout = 0;
server.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://sandbox");
  const [, root, name, action] = url.pathname.split("/");
  const t = authorized(req) && root === "vms" && NAME.test(name ?? "") && action === "http" ? await ideTarget(name, url, req).catch(() => undefined) : undefined;
  if (!t) return void socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
  proxyUpgrade(req, socket, head, t);
});
server.listen(7000);
console.log(`sandbox: api :7000, image ${IMAGE}, vms ${(await list()).join(", ") || "-"}`);
