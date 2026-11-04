// runc a gVisor: kontejner ve vlastni interni siti, kde je krome nej jen gateway.
import { run, sh } from "../proc.ts";
import type { Sandbox, SandboxRuntime } from "./index.ts";

const GATEWAYS: Record<string, string> = { "factory-llm-gw": "llm-gw", "factory-pkg-gw": "pkg-gw" };

export class DockerRuntime implements SandboxRuntime {
  runtime: string;
  image: string;

  constructor(runtime = "runc", image = "factory-sandbox") {
    this.runtime = runtime;
    this.image = image;
  }

  async create(taskId: string): Promise<Sandbox> {
    const name = `factory-task-${taskId}`;
    // inhibit_ipv4: bridge nema IP na hostiteli, jinak by sandbox dosahl na jeho SSH.
    await sh("docker", ["network", "create", "--internal", "-o", "com.docker.network.bridge.inhibit_ipv4=true", name]);
    for (const [gw, alias] of Object.entries(GATEWAYS)) await sh("docker", ["network", "connect", "--alias", alias, name, gw]);
    await sh("docker", ["run", "-d", "--name", name, "--network", name, "--runtime", this.runtime,
      "--memory", "4g", "--cpus", "2", "--pids-limit", "1024",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      this.image, "sleep", "infinity"]);
    const ip = await sh("docker", ["inspect", name, "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"]);
    // IP misto jmen: gVisor ma vlastni sitovy stack a embedded DNS Dockeru nevidi.
    const [llm, pkg] = await Promise.all(Object.keys(GATEWAYS).map((gw) =>
      sh("docker", ["inspect", gw, "-f", `{{(index .NetworkSettings.Networks "${name}").IPAddress}}`])));
    return {
      id: name, ip, gatewayEnv: {
        LLM_BASE_URL: `http://${llm}:4000`,
        TASK_API_URL: `http://${llm}:4001`,
        HTTPS_PROXY: `http://${pkg}:3128`,
        HTTP_PROXY: `http://${pkg}:3128`,
        NO_PROXY: llm,
      },
    };
  }

  exec(sb: Sandbox, cmd: string, stdin?: Buffer, timeout = 900) {
    const env = Object.entries(sb.gatewayEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    return run("docker", ["exec", "-i", ...env, sb.id, "sh", "-c", cmd], { input: stdin, timeout });
  }

  async destroy(sb: Sandbox) {
    await run("docker", ["rm", "-f", sb.id]);
    for (const gw of Object.keys(GATEWAYS)) await run("docker", ["network", "disconnect", "-f", sb.id, gw]);
    await run("docker", ["network", "rm", sb.id]);
  }
}
