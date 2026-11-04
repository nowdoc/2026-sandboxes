// Security suite against a running deployment: node tests/security.ts [--infra ../infra] [--ui http://127.0.0.1:8090]
// Two VM-only runs A and B on a configured repository; probes from A, commit checks inside yfactory, container settings, UI guards,
// revocation after deletion. A check is true when the attack fails or the function works. Nothing is published to the provider.
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (name: string, def: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const HOST = process.env.FACTORY_HOST ?? "127.0.0.1";
const INFRA = arg("--infra", path.resolve(HERE, "../infra"));
const UI = arg("--ui", `http://${HOST}:8090`);
const IDE = arg("--ide", `http://${HOST}:8092`);
const REPO = arg("--repo", "example/repo");

type Out = { code: number; stdout: Buffer; stderr: Buffer };
function run(cmd: string, args: string[], input?: Buffer | string, timeout = 300): Promise<Out> {
  return new Promise((resolve) => {
    const p = execFile(cmd, args, { encoding: "buffer", maxBuffer: 512 * 1024 * 1024, timeout: timeout * 1000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }));
    p.stdin!.end(input ?? "");
  });
}
const docker = (args: string[], input?: Buffer | string, timeout?: number) => run("sudo", ["-n", "docker", ...args], input, timeout);
const vm = (id: string, cmd: string, input?: Buffer | string, user = "agent", timeout = 300) =>
  docker(["exec", "-i", "sandbox", "msb", "exec", "-u", user, `yf-${id}`, "--", "sh", "-c", cmd], input, timeout);
const agentEnv = (cmd: string) => `. /home/agent/.yf-env && ${cmd}`;
async function must(p: Promise<Out>, what: string) {
  const r = await p;
  if (r.code) throw new Error(`${what}: exit ${r.code} ${r.stderr.toString().slice(-400)}`);
  return r.stdout.toString();
}

const blocked: Record<string, boolean> = {};
const works: Record<string, boolean> = {};

async function api(method: string, p: string, body?: unknown) {
  const res = await fetch(UI + p, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const runOf = async (id: string) => ((await api("GET", "/api/runs")).data as any[]).find((r) => r.id === id);

async function newRun(): Promise<string> {
  const r = await api("POST", "/api/runs", { repo: REPO, keep: true });
  if (r.status !== 202) throw new Error(`POST /api/runs -> ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.id;
}
async function ready(id: string) {
  for (let i = 0; i < 120; i++) {
    const r = await runOf(id);
    if (r?.status === "ready") return r;
    if (r?.status === "failed" || r?.status === "done") throw new Error(`run ${id} ${r.status}: ${r.error}`);
    await new Promise((s) => setTimeout(s, 3000));
  }
  throw new Error(`run ${id} not ready`);
}

// Secret values only in memory, never printed. Values that are names or URLs, not secrets, are skipped.
function secretValues(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fs.readdirSync(path.join(INFRA, "secrets")).filter((f) => f.endsWith(".env"))) {
    for (const line of fs.readFileSync(path.join(INFRA, "secrets", f), "utf8").split("\n")) {
      const i = line.indexOf("=");
      if (i < 1) continue;
      const [k, v] = [line.slice(0, i).trim(), line.slice(i + 1).trim()];
      if (v.length < 12 || /(_URL|_USER|_DB)$/.test(k)) continue;
      out[`${f}:${k}`] = v;
    }
  }
  return out;
}
const envOf = async (id: string) => Object.fromEntries((await must(vm(id, "cat /home/agent/.yf-env", undefined, "root"), "read env"))
  .split("\n").map((l) => /^export (\w+)='(.*)'$/.exec(l)).filter(Boolean).map((m) => [m![1], m![2]]));

const ip = async (container: string, network: string) =>
  (await must(docker(["inspect", container, "-f", `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`]), `ip ${container}`)).trim();
const bridge = async (network: string) => (await must(docker(["network", "inspect", network, "-f", "{{(index .IPAM.Config 0).Gateway}}"]), `bridge ${network}`)).trim();

async function networkTargets(peerIp: string) {
  const t: [string, number][] = [["1.1.1.1", 443], ["8.8.8.8", 53], ["169.254.169.254", 80], ["192.168.1.1", 80],
    [HOST, 22], [HOST, 8090], [HOST, 8091], [HOST, 3900], ["10.99.0.3", 7000], ["10.99.0.10", 80],
    ["10.99.0.10", 22], ["10.99.0.10", 8080], ["10.99.0.10", 8081], ["10.99.0.11", 22], ["10.99.0.11", 80], [peerIp, 8000], [peerIp, 22], [peerIp, 8443]];
  // Published VM ports live on the sandbox loopback; a VM must not reach its own or a peer's through the sandbox container.
  for (let p = 20000; p <= 20010; p++) t.push(["10.99.0.3", p]);
  for (const n of ["ynfra_core", "ynfra_control", "ynfra_vms", "ynfra_egress", "ynfra_monitoring"]) for (const p of [22, 8090, 8091]) t.push([await bridge(n), p]);
  for (const [c, n, ports] of [["ynfra-litellm-1", "ynfra_core", [4000]], ["ynfra-garage-1", "ynfra_core", [3900, 3903]], ["ynfra-db-1", "ynfra_core", [5432]],
    ["yfactory", "ynfra_core", [8080, 8081, 9001]], ["yfactory", "ynfra_control", [8080, 8081, 9001]],
    ["sandbox", "ynfra_control", [7000]], ["ynfra-grafana-1", "ynfra_monitoring", [3000]], ["ynfra-victoriametrics-1", "ynfra_core", [8428]],
    ["ynfra-proxy-1", "ynfra_core", [3128]]] as const)
    for (const p of ports) t.push([await ip(c, n), p]);
  return t;
}

// Commit checks in the yfactory container against the run repository, as publish would call them. Never pushes to the provider.
async function checkCommits(id: string, base: string, tip: string): Promise<string | null> {
  const js = `import("/app/git.ts").then(async (g) => console.log(JSON.stringify(await g.checkCommits("/data/git/${id}.git", "${base}", "${tip}"))))`;
  return JSON.parse(await must(docker(["exec", "-w", "/app", "yfactory", "node", "-e", js]), "checkCommits"));
}

// Each case starts from the base commit, is force-pushed to the run branch and returns the tip.
const CASES: Record<string, string> = {
  normal: "echo ok > ok.txt && git add ok.txt && git commit -qm ok",
  workflow: "mkdir -p .github/workflows && echo 'on: push' > .github/workflows/x.yml && git add -A && git commit -qm ci",
  workflow_reverted: "mkdir -p .github/workflows && echo 'on: push' > .github/workflows/x.yml && git add -A && git commit -qm ci && git rm -rq .github && git commit -qm revert",
  symlink: "ln -s /etc/passwd link && git add link && git commit -qm link",
  gitmodules: "printf '[submodule \"x\"]\\n\\tpath = x\\n\\turl = https://example.com/x\\n' > .gitmodules && git add .gitmodules && git commit -qm sub",
  gitattributes: "echo '* filter=x' > .gitattributes && git add .gitattributes && git commit -qm attr",
  merge: "git checkout -qb side && echo a > a.txt && git add a.txt && git commit -qm a && git checkout -q - && echo b > b.txt && git add b.txt && git commit -qm b && git merge -q --no-edit side",
};

async function gitChecks(a: string, base: string) {
  const g = (cmd: string) => vm(a, agentEnv(`cd /workspace && ${cmd}`));
  works["git ls-remote own run"] = (await g("git ls-remote origin")).code === 0;
  await must(g("echo x > sec.txt && git add sec.txt && git commit -qm sec"), "commit");
  works["git push own branch"] = (await g('git push -q origin "HEAD:refs/heads/$YF_BRANCH"')).code === 0;
  blocked["git push other branch"] = (await g("git push -q origin HEAD:refs/heads/yfactory/other")).code !== 0;
  blocked["git push base branch"] = (await g('git push -q origin "HEAD:refs/heads/$YF_BASE"')).code !== 0;
  blocked["git push tag"] = (await g("git tag -f t1 && git push -q origin refs/tags/t1")).code !== 0;
  blocked["git delete own branch"] = (await g('git push -q origin ":refs/heads/$YF_BRANCH"')).code !== 0;
  for (const [name, cmd] of Object.entries(CASES)) {
    const tip = (await must(g(`git checkout -q -B "$YF_BRANCH" ${base} && git clean -qfdx && ${cmd} && git push -qf origin "HEAD:refs/heads/$YF_BRANCH" && git rev-parse HEAD`), `case ${name}`)).trim();
    const reason = await checkCommits(a, base, tip);
    if (name === "normal") works["commit check allows a normal commit"] = reason === null;
    else blocked[`commit check rejects ${name}`] = typeof reason === "string";
  }
  blocked["commit check rejects no new commit"] = typeof (await checkCommits(a, base, base)) === "string";
}

function wsStatus(base: string, p: string, origin?: string): Promise<string> {
  const u = new URL(base);
  return new Promise((resolve) => {
    const s = net.connect(Number(u.port || 80), u.hostname, () => s.write(`GET ${p} HTTP/1.1\r\nHost: ${u.host}\r\n` +
      `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${origin ? `Origin: ${origin}\r\n` : ""}\r\n`));
    s.once("data", (d) => { resolve(d.toString().split("\r\n")[0]); s.destroy(); });
    s.on("error", () => resolve("error"));
    setTimeout(() => { resolve("timeout"); s.destroy(); }, 15000);
  });
}

async function containerChecks() {
  const ids = (await must(docker(["ps", "-q", "--filter", "label=com.docker.compose.project=ynfra"]), "ps")).split("\n").filter(Boolean);
  const all = JSON.parse(await must(docker(["inspect", ...ids]), "inspect")) as any[];
  const by = (n: string) => all.find((c) => c.Name === `/${n}`);
  const envNames = (c: any) => (c.Config.Env as string[]).map((e) => e.split("=")[0]);
  blocked["no container mounts docker.sock"] = all.every((c) => !c.Mounts.some((m: any) => /docker\.sock|containerd\.sock/.test(m.Source)));
  blocked["no container is privileged"] = all.every((c) => !c.HostConfig.Privileged);
  const yf = by("yfactory"), sb = by("sandbox");
  blocked["yfactory runs as 1000, cap_drop ALL, no devices"] = yf.Config.User === "1000:1000" && (yf.HostConfig.CapDrop ?? []).includes("ALL") && !(yf.HostConfig.Devices ?? []).length;
  blocked["sandbox has only /dev/kvm"] = JSON.stringify((sb.HostConfig.Devices ?? []).map((d: any) => d.PathOnHost)) === '["/dev/kvm"]' && !(sb.HostConfig.CapAdd ?? []).length;
  const secretKeys = new Set(Object.keys(secretValues()).map((k) => k.split(":")[1]));
  blocked["sandbox env holds only SANDBOX_TOKEN of the secrets"] = JSON.stringify(envNames(sb).filter((n) => secretKeys.has(n))) === '["SANDBOX_TOKEN"]';
  const credential = (n: string) => /^(GITHUB|FORGEJO|GITLAB)_TOKEN/.test(n) || n === "SANDBOX_TOKEN";
  for (const n of ["ynfra-litellm-1", "ynfra-proxy-1"]) blocked[`${n} has no provider or sandbox token`] = !envNames(by(n)).some(credential);
  blocked["yfactory has no upstream LLM key"] = !envNames(yf).includes("OPENAI_API_KEY");
}

async function main() {
  const secrets = secretValues();
  if (!Object.keys(secrets).length) throw new Error(`no secrets found in ${INFRA}/secrets`);
  const models = (await api("GET", "/api/repos")).data.models as string[];
  const ids: string[] = [];
  const keys: Record<string, Record<string, string>> = {};
  try {
    ids.push(await newRun(), await newRun());
    const [a, b] = ids;
    const runA = await ready(a);
    await ready(b);
    keys[a] = await envOf(a); keys[b] = await envOf(b);
    const peerIp = (await must(vm(b, "hostname -I"), "ip B")).trim().split(" ")[0];
    await must(vm(b, "setsid nohup python3 -m http.server 8000 >/dev/null 2>&1 < /dev/null & sleep 1"), "listener");
    for (const id of ids) works[`IDE starts in ${id === a ? "A" : "B"}`] = (await api("POST", `/api/runs/${id}/ide`, {})).status === 200;
    works["code-server listens in B"] = (await vm(b, "curl -s -o /dev/null -w '%{http_code}' --noproxy '*' http://127.0.0.1:8443/healthz")).stdout.toString() === "200";
    works["peer listener answers locally"] = (await vm(b, "curl -s -o /dev/null -w '%{http_code}' --noproxy '*' http://127.0.0.1:8000/")).stdout.toString() === "200";

    // Before anything from B reaches A: A must not hold any platform secret or B's credentials.
    const scan = "env; cat /proc/[0-9]*/environ /proc/[0-9]*/cmdline; find /home /workspace /tmp /root /etc /opt /usr/local/share/yfactory -xdev -type f -size -4M 2>/dev/null | xargs -r cat 2>/dev/null; true";
    const dump = (await vm(a, scan, undefined, "root", 600)).stdout;
    for (const [label, value] of Object.entries(secrets)) blocked[`VM has no ${label}`] = !dump.includes(Buffer.from(value));
    blocked["VM has no YF_TOKEN of the other run"] = !dump.includes(Buffer.from(keys[b].YF_TOKEN));
    blocked["VM env has no LLM key, only the run token"] = !("LLM_API_KEY" in keys[a]) && !("LLM_API_KEY" in keys[b]);
    blocked["agent has no sudo"] = (await vm(a, "sudo -n true")).code !== 0;
    blocked["agent cannot write /etc"] = (await vm(a, "touch /etc/yf-sec-probe")).code !== 0;

    const cfg = {
      tcp: await networkTargets(peerIp), model: models[0], peer_run: b,
      proxy_internal: ["http://yfactory:8080/", `http://${await ip("yfactory", "ynfra_core")}:8080/`, `http://${HOST}:8090/`, "http://litellm:4000/health",
        `http://${await ip("ynfra-garage-1", "ynfra_core")}:3900/`, "http://10.99.0.3:7000/vms", "http://169.254.169.254/", "http://localhost:3128/"],
    };
    await must(vm(a, "cat > /tmp/yf-probe.py", fs.readFileSync(path.join(HERE, "vm_probe.py"))), "upload probe");
    await must(vm(a, "cat > /tmp/yf-probe.json", JSON.stringify(cfg)), "probe config");
    const p = JSON.parse(await must(vm(a, agentEnv("python3 /tmp/yf-probe.py < /tmp/yf-probe.json"), undefined, "agent", 900), "probe"));
    Object.assign(blocked, p.blocked); Object.assign(works, p.works);

    await gitChecks(a, runA.baseSha);
    await containerChecks();

    const term = `/api/runs/${a}/terminal?rows=24&cols=80`;
    blocked["terminal WebSocket with foreign Origin"] = (await wsStatus(UI, term, "http://evil.example")).includes(" 403");
    blocked["terminal WebSocket without Origin"] = (await wsStatus(UI, term)).includes(" 403");
    works["terminal WebSocket same origin"] = (await wsStatus(UI, term, UI)).includes(" 101");
    const ideWs = `/${a}/stable-x/?reconnectionToken=x&reconnection=false&skipWebSocketFrames=false`;
    blocked["IDE WebSocket with foreign Origin"] = (await wsStatus(IDE, ideWs, "http://evil.example")).includes(" 403");
    blocked["IDE WebSocket without Origin"] = (await wsStatus(IDE, ideWs)).includes(" 403");
    blocked["IDE WebSocket with the UI port as Origin"] = (await wsStatus(IDE, ideWs, UI)).includes(" 403");
    works["IDE page through :8092"] = (await fetch(`${IDE}/${a}/?folder=/workspace`)).status === 200;
    blocked["IDE of an unknown run"] = (await fetch(`${IDE}/ffffffff/`)).status === 404;
    const form = await fetch(UI + "/api/runs", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ repo: REPO, keep: true }) });
    blocked["POST /api/runs as text/plain"] = form.status === 415;
  } finally {
    for (const id of ids) await run("sudo", ["-n", path.join(INFRA, "yfactory.sh"), "rm", id], undefined, 300);
  }
  // Run tokens of deleted runs must stop working at the task API (LLM and git).
  for (const id of ids) {
    const k = keys[id];
    if (!k) continue;
    const code = (url: string) => must(docker(["exec", "-e", `T=${k.YF_TOKEN}`, "yfactory", "node", "-e",
      `fetch(${JSON.stringify(url)},{headers:{authorization:"Bearer "+process.env.T}}).then((r)=>console.log(r.status))`]), "fetch task api").then((r) => r.trim());
    blocked[`LLM route rejects the token after rm (${id})`] = (await code("http://localhost:9001/v1/models")) === "401";
    blocked[`run token rejected after rm (${id})`] = (await code(`http://localhost:9001/git/${id}.git/info/refs?service=git-upload-pack`)) === "401";
  }
  works["VMs removed"] = !(await must(docker(["exec", "sandbox", "msb", "ls"]), "msb ls")).split("\n").some((l) => ids.some((id) => l.includes(`yf-${id}`)));
}

let error: string | null = null;
try { await main(); } catch (e) { error = e instanceof Error ? e.message : String(e); }
const version = (await run("sudo", ["-n", "docker", "inspect", "yfactory", "-f", "{{.Config.Image}}"])).stdout.toString().trim();
const rows = [...Object.entries(blocked).map(([k, v]) => ["blocked", k, v] as const), ...Object.entries(works).map(([k, v]) => ["works", k, v] as const)];
for (const [kind, name, ok] of rows) console.log(`${ok ? "PASS" : "FAIL"}  ${kind.padEnd(7)}  ${name}`);
const failed = rows.filter((r) => !r[2]).map((r) => r[1]);
console.log(`\n${version}: ${rows.length - failed.length}/${rows.length} passed${error ? `, aborted: ${error}` : ""}`);
fs.mkdirSync(path.join(HERE, "results"), { recursive: true });
fs.writeFileSync(path.join(HERE, "results", "security.json"), JSON.stringify({ version, error, blocked, works }, null, 1) + "\n");
process.exitCode = failed.length || error ? 1 : 0;
