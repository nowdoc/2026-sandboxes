import { spawn } from "node:child_process";

export type Result = { code: number; stdout: Buffer; stderr: Buffer };

export class CommandError extends Error {
  name = "CommandError";
}

// Vzdy pole argumentu, nikdy shell.
export function run(cmd: string, args: string[], opts: { cwd?: string; input?: Buffer | string; timeout?: number } = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [], err: Buffer[] = [];
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => err.push(d));
    const timer = opts.timeout ? setTimeout(() => { p.kill("SIGKILL"); reject(new CommandError(`${cmd} timeout`)); }, opts.timeout * 1000) : undefined;
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }); });
    p.stdin.on("error", () => {});
    p.stdin.end(opts.input);
  });
}

// Zprava chyby nenese argumenty (mohly by obsahovat token), jen prikaz a stderr.
export async function sh(cmd: string, args: string[], opts: { cwd?: string; input?: Buffer | string; timeout?: number } = {}): Promise<string> {
  const r = await run(cmd, args, opts);
  if (r.code) throw new CommandError(`${cmd} ${args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-c") ?? ""} exit ${r.code}: ${r.stderr.toString().slice(-500)}`);
  return r.stdout.toString().trim();
}
