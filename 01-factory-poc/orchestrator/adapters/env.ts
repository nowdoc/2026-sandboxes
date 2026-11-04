import { sh } from "../proc.ts";
// Env jde sandboxu na stdin, ne v argv: `ps` na hostu pak nevidi LLM_API_KEY ani TASK_TOKEN.
const quote = (v: string) => `'${v.replaceAll("'", `'\\''`)}'`;

export function withEnv(env: Record<string, string>, cmd: string, stdin?: Buffer) {
  const line = `export ${Object.entries(env).map(([k, v]) => `${k}=${quote(v)}`).join(" ")}\n`;
  return { script: `IFS= read -r E; eval "$E"; ${cmd}`, input: Buffer.concat([Buffer.from(line), stdin ?? Buffer.alloc(0)]) };
}

// msb and sbx belong to the unprivileged host user (on-disk paths, sbx login) and only the kvm group can use /dev/kvm.
// The orchestrator runs as root, so it runs the command as that user and copies nothing.
const HOST_HOME = process.env.FACTORY_HOME ?? "/home/sandbox";
const HOST_UID = process.env.FACTORY_UID ?? "1000";
export async function asHostUser(cmd: string[], env: Record<string, string> = {}) {
  const kvm = (await sh("getent", ["group", "kvm"])).split(":")[2];
  const pre = process.getuid?.() === 0 ? ["setpriv", `--reuid=${HOST_UID}`, `--regid=${HOST_UID}`, `--groups=${HOST_UID},${kvm}`] : [];
  return ["env", `HOME=${HOST_HOME}`, ...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...pre, ...cmd];
}

// Publikovane porty gateway (4000, 4001) pro runtimes, ktere nevidi Docker sit, viz gateway/compose.yml.
export const GW_ADDR = "198.18.0.10";
