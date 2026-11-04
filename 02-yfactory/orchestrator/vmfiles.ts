// Read-only view of /workspace in a run's VM. Names and contents come from the VM, so they are data only.
import * as sandbox from "./sandbox.ts";

const ROOT = "/workspace";
const MAX_FILE = 512 * 1024;

export class FileError extends Error {
  code: number;
  constructor(code: number, message: string) { super(message); this.code = code; }
}

const quote = (v: string) => `'${v.replaceAll("'", `'\\''`)}'`;

// realpath inside the VM, so a symlink cannot lead out of /workspace.
async function resolve(vm: string, p: string, kind: "d" | "f"): Promise<string> {
  if (!p.startsWith(ROOT) || p.includes("\0") || p.length > 1024) throw new FileError(400, "path must be under /workspace");
  const r = await sandbox.exec(vm, `p=$(realpath -e -- ${quote(p)}) || exit 4; case "$p" in ${ROOT}|${ROOT}/*) ;; *) exit 3;; esac; [ -${kind} "$p" ] || exit 5; printf %s "$p"`, "", 30);
  if (r.code === 4) throw new FileError(404, "not found");
  if (r.code === 3) throw new FileError(403, "outside /workspace");
  if (r.code === 5) throw new FileError(400, kind === "d" ? "not a directory" : "not a file");
  if (r.code) throw new FileError(502, "VM did not answer");
  return r.stdout.toString();
}

export async function list(vm: string, p: string) {
  const dir = await resolve(vm, p, "d");
  const r = await sandbox.exec(vm, `find ${quote(dir)} -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%f\\0'`, "", 30);
  if (r.code) throw new FileError(502, "listing failed");
  const entries = r.stdout.toString().split("\0").filter(Boolean).slice(0, 5000).map((l) => {
    const [y, size, ...name] = l.split("\t");
    return { name: name.join("\t"), type: y === "d" ? "dir" : y === "l" ? "link" : "file", size: Number(size) || 0 };
  }).sort((a, b) => +(b.type === "dir") - +(a.type === "dir") || a.name.localeCompare(b.name));
  return { path: dir, entries };
}

export async function read(vm: string, p: string) {
  const file = await resolve(vm, p, "f");
  const r = await sandbox.exec(vm, `head -c ${MAX_FILE + 1} -- ${quote(file)}`, "", 30);
  if (r.code) throw new FileError(502, "read failed");
  if (r.stdout.subarray(0, 8192).includes(0)) throw new FileError(415, "binary");
  return { text: r.stdout.subarray(0, MAX_FILE), truncated: r.stdout.length > MAX_FILE };
}
