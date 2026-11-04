// E2B Embed (Firecracker). SDK je jen v node-e2b image, proto kazde volani = `docker run` s runtimes/e2b/js/cli.mjs.
// Default-deny: denyOut 0.0.0.0/0 a allowOut jen domeny z gateway/allowlist.txt. Gateway je na GW_ADDR (DNAT publikovanych
// portu 4000 a 4001); IP do allowOut nepatri, jinak by sandbox dosahl na vsechny sluzby hosta na teto adrese.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../proc.ts";
import { GW_ADDR, withEnv } from "./env.ts";
import type { Sandbox, SandboxRuntime } from "./index.ts";

const FACTORY = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const DIR = path.join(FACTORY, "runtimes/e2b");
const PREFIX = "factory-task-";

export class E2BRuntime implements SandboxRuntime {
  runtime = "e2b";

  private cli(args: string[], opts: { input?: Buffer; timeout?: number; user?: string } = {}) {
    const image = fs.readFileSync(path.join(DIR, "stack/.env"), "utf8").match(/^E2B_NODE_E2B_IMAGE=(\S+)/m)?.[1];
    if (!image) throw new Error("E2B_NODE_E2B_IMAGE chybi v runtimes/e2b/stack/.env");
    return run("docker", ["run", "--rm", "-i", "--network", "host", "--env-file", path.join(DIR, "state/sdk.env"),
      "-e", "E2B_API_URL=http://127.0.0.1:13000", "-e", "E2B_SANDBOX_URL=http://127.0.0.1:3002", "-e", `E2B_USER=${opts.user ?? "user"}`,
      "-v", `${DIR}/js:/app/js:ro`, "-w", "/app", "--entrypoint", "node", image, "/app/js/cli.mjs", ...args],
    { input: opts.input ?? Buffer.alloc(0), timeout: opts.timeout });
  }

  private async call(args: string[], opts: { input?: Buffer; timeout?: number; user?: string } = {}) {
    const r = await this.cli(args, opts);
    if (r.code) throw new Error(`e2b ${args[0]} exit ${r.code}: ${r.stderr.toString().slice(-500)}`);
    return JSON.parse(r.stdout.toString());
  }

  async create(taskId: string): Promise<Sandbox> {
    // Bez domen v allowOut: E2B by kvuli nim povolilo DNS na 8.8.8.8. Balicky jdou pres squid jako u ostatnich.
    const net = JSON.stringify({ denyOut: ["0.0.0.0/0"] });
    const { id } = await this.call(["create", "base", net, `${PREFIX}${taskId}`], { timeout: 120 });
    const sb: Sandbox = { id, ip: "", gatewayEnv: {
      LLM_BASE_URL: `http://${GW_ADDR}:4000`, TASK_API_URL: `http://${GW_ADDR}:4001`,
      HTTPS_PROXY: `http://${GW_ADDR}:3128`, HTTP_PROXY: `http://${GW_ADDR}:3128`, NO_PROXY: GW_ADDR,
    } };
    try {
      const r = await this.call(["exec", id, "60000", "mkdir -p /workspace /task && chown user:user /workspace /task && hostname -I"], { user: "root", timeout: 90 });
      if (r.code) throw new Error("e2b init exit " + r.code);
      sb.ip = Buffer.from(r.stdout, "base64").toString().trim().split(/\s+/)[0];
    } catch (e) {
      await this.destroy(sb);
      throw e;
    }
    return sb;
  }

  async exec(sb: Sandbox, cmd: string, stdin?: Buffer, timeout = 900) {
    const { script, input } = withEnv(sb.gatewayEnv, cmd, stdin);
    const r = await this.call(["exec", sb.id, String(timeout * 1000), `sh -c '${script.replaceAll("'", `'\\''`)}'`], { input, timeout: timeout + 30 });
    return { code: r.code as number, stdout: Buffer.from(r.stdout, "base64"), stderr: Buffer.from(r.stderr, "base64") };
  }

  async destroy(sb: Sandbox) {
    await this.cli(["destroy", sb.id]);
  }

  async cleanup() {
    if (!fs.existsSync(path.join(DIR, "state/sdk.env"))) return;
    const list: { id: string; task: string }[] = await this.call(["list"], { timeout: 60 }).catch(() => []);
    for (const { id, task } of list) if (task.startsWith(PREFIX)) await this.destroy({ id } as Sandbox);
  }
}
