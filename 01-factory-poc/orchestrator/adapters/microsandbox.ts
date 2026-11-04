// Microsandbox (libkrun microVM): default-deny egress, jen gateway:4000, :4001 a pkg proxy :3128.
// Gateway vidi zdroj 172.18.0.1 pro vsechny sandboxy, identita je virtualni key a TASK_TOKEN.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run, sh } from "../proc.ts";
import { asHostUser, withEnv } from "./env.ts";
import type { Sandbox, SandboxRuntime } from "./index.ts";

const DIR = path.join(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))), "runtimes/microsandbox");
const HOME = path.join(DIR, "home"); // musi byt pod adresari bez zapisu pro skupinu, jinak msb odmitne start
const ROOTFS = path.join(DIR, "rootfs"); // docker export factory-sandbox, viz NOTES.md
// msb adresar pripoji primo a zapisy jdou do nej, proto ma kazda uloha vlastni kopii. Jinak by si ulohy sdilely soubory.
const TASKS = path.join(DIR, "tasks");
const PREFIX = "factory-task-";

export class MicrosandboxRuntime implements SandboxRuntime {
  runtime = "microsandbox";

  private async msb(args: string[], opts: { input?: Buffer; timeout?: number } = {}) {
    const [cmd, ...rest] = await asHostUser([path.join(HOME, "bin/msb"), ...args], { MSB_HOME: HOME, HOME });
    return run(cmd, rest, opts);
  }

  async create(taskId: string): Promise<Sandbox> {
    const name = `${PREFIX}${taskId}`;
    const [llm, pkg] = await Promise.all(["factory-llm-gw", "factory-pkg-gw"].map((gw) =>
      sh("docker", ["inspect", gw, "-f", '{{(index .NetworkSettings.Networks "factory-core").IPAddress}}'])));
    const rules = [`allow@${llm}:tcp:4000`, `allow@${llm}:tcp:4001`, `allow@${pkg}:tcp:3128`].join(",");
    const rootfs = path.join(TASKS, name);
    fs.mkdirSync(TASKS, { recursive: true, mode: 0o755 });
    await sh("cp", ["-a", "--reflink=auto", ROOTFS, rootfs]);
    // Pool mimo 172.16/12, kde lezi Docker bridge (gateway je 172.18.0.x).
    const r = await this.msb(["create", "-q", "-n", name, "-c", "2", "-m", "4G", "--net-default-egress", "deny",
      "--net-ipv4-pool", "10.200.0.0/16", "--net-rule", rules, rootfs]);
    if (r.code) throw new Error(`msb create exit ${r.code}: ${r.stderr.toString().slice(-500)}`);
    const sb: Sandbox = { id: name, ip: "", gatewayEnv: {
      LLM_BASE_URL: `http://${llm}:4000`, TASK_API_URL: `http://${llm}:4001`,
      HTTPS_PROXY: `http://${pkg}:3128`, HTTP_PROXY: `http://${pkg}:3128`, NO_PROXY: llm,
    } };
    sb.ip = (await this.exec(sb, "hostname -I", undefined, 60)).stdout.toString().trim().split(/\s+/)[0];
    return sb;
  }

  exec(sb: Sandbox, cmd: string, stdin?: Buffer, timeout = 900) {
    const { script, input } = withEnv(sb.gatewayEnv, cmd, stdin);
    return this.msb(["exec", "-u", "agent", sb.id, "--", "sh", "-c", script], { input, timeout });
  }

  async destroy(sb: Sandbox) {
    await this.msb(["rm", "-f", sb.id]);
    fs.rmSync(path.join(TASKS, path.basename(sb.id)), { recursive: true, force: true });
  }

  async cleanup() {
    if (!fs.existsSync(path.join(HOME, "bin/msb"))) return;
    const r = await this.msb(["ls", "--format", "json"]).catch(() => null);
    const list: { name: string }[] = r?.code === 0 ? JSON.parse(r.stdout.toString() || "[]") : [];
    for (const { name } of list) if (name.startsWith(PREFIX)) await this.destroy({ id: name } as Sandbox);
    if (fs.existsSync(TASKS)) for (const name of fs.readdirSync(TASKS)) if (name.startsWith(PREFIX)) await this.destroy({ id: name } as Sandbox);
  }
}
