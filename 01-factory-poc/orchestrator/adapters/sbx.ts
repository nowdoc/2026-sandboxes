// Docker Sandboxes (sbx): microVM, egress default-deny, rule per sandbox. The sbx login belongs to the host user,
// so sbx runs as that user (asHostUser); nothing is copied into the sandbox.
// Sandbox vidi gateway jen pres allow pravidlo na IP:port. Docker sit factory-core se kryje s docker0 uvnitr VM
// (172.18.0.0/16, "No route to host"), proto jde gateway pres publikovanou adresu GW_ADDR. Balicky jdou pres sbx proxy, ne pres squid;
// povolene domeny bere z gateway/allowlist.txt.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../proc.ts";
import { asHostUser, GW_ADDR, withEnv } from "./env.ts";
import type { Sandbox, SandboxRuntime } from "./index.ts";

const FACTORY = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const PREFIX = "factory-task-";

export class SbxRuntime implements SandboxRuntime {
  runtime = "sbx";

  private async sbx(args: string[], opts: { input?: Buffer; timeout?: number } = {}) {
    const [cmd, ...rest] = await asHostUser(["sbx", ...args]);
    return run(cmd, rest, { input: Buffer.alloc(0), ...opts }); // vzdy EOF na stdin, sbx nikdy nezeptá na TTY
  }

  private async ok(args: string[]) {
    const r = await this.sbx(args);
    if (r.code) throw new Error(`sbx ${args[0]} exit ${r.code}: ${r.stderr.toString().slice(-500)}`);
  }

  async create(taskId: string): Promise<Sandbox> {
    const name = `${PREFIX}${taskId}`;
    const domains = fs.readFileSync(path.join(FACTORY, "gateway/allowlist.txt"), "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
    try {
      await this.ok(["create", "--name", name, "--cpus", "2", "--memory", "4g", "--no-progress", "shell"]);
      await this.ok(["policy", "allow", "network", "--sandbox", name, [`${GW_ADDR}:4000`, `${GW_ADDR}:4001`, ...domains].join(",")]);
      const sb: Sandbox = { id: name, ip: "", gatewayEnv: {
        LLM_BASE_URL: `http://${GW_ADDR}:4000`, TASK_API_URL: `http://${GW_ADDR}:4001`, NO_PROXY: `localhost,127.0.0.1,${GW_ADDR}`,
      } };
      const r = await this.exec(sb, "sudo mkdir -p /workspace /task && sudo chown agent:agent /workspace /task && hostname -I", undefined, 60);
      if (r.code) throw new Error(`sbx init exit ${r.code}: ${r.stderr.toString().slice(-500)}`);
      sb.ip = r.stdout.toString().trim().split(/\s+/)[0];
      return sb;
    } catch (e) {
      await this.destroy({ id: name } as Sandbox);
      throw e;
    }
  }

  exec(sb: Sandbox, cmd: string, stdin?: Buffer, timeout = 900) {
    const { script, input } = withEnv(sb.gatewayEnv, cmd, stdin);
    return this.sbx(["exec", "-i", sb.id, "sh", "-c", script], { input, timeout });
  }

  async destroy(sb: Sandbox) {
    await this.sbx(["rm", "--force", sb.id]); // smaze i pravidla sandboxu
  }

  async cleanup() {
    const r = await this.sbx(["ls", "--json"]).catch(() => null);
    const list: { name: string }[] = r?.code === 0 ? JSON.parse(r.stdout.toString() || "[]") : [];
    for (const { name } of list) if (name.startsWith(PREFIX)) await this.destroy({ id: name } as Sandbox);
  }
}
