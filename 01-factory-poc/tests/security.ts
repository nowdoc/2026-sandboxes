// Bezpecnostni test runtimu: tests/security.ts <runtime>. 'open' je negativni kontrola.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import * as factory from "../orchestrator/factory.ts";
import { run, sh } from "../orchestrator/proc.ts";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const name = process.argv[2];
const probe = fs.readFileSync(path.join(ROOT, "tests/probe.py"));
const secrets: Record<string, string> = {
  bot_token: factory.CFG.FORGEJO_BOT_TOKEN, admin_token: factory.CFG.FORGEJO_ADMIN_TOKEN,
  webhook_secret: factory.CFG.WEBHOOK_SECRET, litellm_master: factory.LITELLM.LITELLM_MASTER_KEY,
};
const SCAN = "env; cat /proc/1/environ /proc/self/environ; find /workspace /task /home /tmp /root -type f 2>/dev/null | xargs -r cat 2>/dev/null";
let results: Record<string, boolean> = {};
let works: Record<string, boolean> = {};
// Runtime-specificka vyjimka: msb sam ukonci TCP na :80 a vrati 403 network_policy_denied, na hostu nic nedorazi.
const DENY_MARKER: Record<string, string> = { microsandbox: "network_policy_denied" };
// Runtime-specificka vyjimka (sbx, e2b): proxy prijme kazde TCP spojeni, ale pro zakazane cile nevrati ani bajt a na hostu nic nedorazi.
const SILENT_OK = name === "sbx" || name === "e2b";
const REPO = "factory-admin/fixture";
const TASK_PROBE = String.raw`
import json, os, sys, urllib.error, urllib.request
base, token = os.environ["TASK_API_URL"], os.environ["TASK_TOKEN"]
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
def call(path, token=token, data=None):
    req = urllib.request.Request(base + path, data=data, headers={"Authorization": "Bearer " + token})
    try:
        r = opener.open(req, timeout=20); return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
own, body = call("/task/comments")
other = json.loads(call("/task/comments", sys.argv[1])[1])
print(json.dumps({
    "own": own, "number": json.loads(body)["number"], "other_number": other["number"],
    "none": call("/task/comments", "")[0], "bad": call("/task/comments", "x" * 43)[0],
    "forgejo": call("/api/v1/user")[0], "escape": call("/task/../api/v1/user")[0],
    "pulls": call("/api/v1/repos/factory-admin/fixture/pulls", data=b"{}")[0],
    "git": call("/factory-admin/fixture.git/info/refs?service=git-receive-pack")[0],
    "admin": call("/key/generate", data=b"{}")[0],
    "reply": call("/task/reply", data=b"x" * 5000)[0],
    "large": call("/task/reply", data=b"x" * 70000)[0],
}))
`;

const fail = (r: { stderr: Buffer }) => { throw new Error(r.stderr.toString()); };

if (name === "open") {
  // Kontrola: bezny kontejner v core siti bez omezeni musi testy shodit.
  const out = await run("docker", ["run", "--rm", "-i", "--network", "factory-core", "factory-sandbox", "python3", "-c", probe.toString()], { timeout: 180 });
  const r = JSON.parse(out.stdout.toString());
  results = r.blocked; works = r.works;
} else {
  const rt = factory.ALL_RUNTIMES[name]();
  const id = () => randomBytes(4).toString("hex");
  const a = await rt.create(id()), b = await rt.create(id());
  let key: string | undefined, keyB: string | undefined, taskA: string | undefined, taskB: string | undefined;
  try {
    key = await factory.grantKey(a, "sec-a", {});
    keyB = await factory.grantKey(b, "sec-b", {});
    secrets.other_task_key = keyB; // vlastni klic v sandboxu byt smi
    taskA = factory.grantTask(a, REPO, 1, null, "0".repeat(40));
    taskB = factory.grantTask(b, REPO, 2, null, "0".repeat(40));
    secrets.other_task_token = b.gatewayEnv.TASK_TOKEN;
    const bridge = a.ip.slice(0, a.ip.lastIndexOf(".")) + ".1"; // IP bridge na hostiteli
    // Bez IP na bridgi muze .1 patrit povolene gateway, ta na 4000 poslouchat ma.
    const bridgePorts = [22, 9000, 3000, 4000].filter((p) => !a.gatewayEnv.LLM_BASE_URL.includes(`//${bridge}:${p}`));
    // Primo LiteLLM a Forgejo v core siti: sandbox je smi videt jen pres gateway.
    const direct = await Promise.all([["factory-litellm-litellm-1", 4000], ["factory-forgejo-forgejo-1", 3000]].map(async ([c, port]) =>
      [await sh("docker", ["inspect", c as string, "-f", '{{(index .NetworkSettings.Networks "factory-core").IPAddress}}']), port]));
    // E2B: vsechny sandboxy maji stejnou IP, b.ip je pak vlastni sshd, ne peer.
    const peerPorts = a.ip === b.ip ? [] : [[b.ip, 22], [b.ip, 80]];
    const host = process.env.FACTORY_HOST ?? "127.0.0.1";
    const arg = JSON.stringify({ host, deny_marker: DENY_MARKER[name], silent_ok: SILENT_OK, tcp: [...direct, ...peerPorts, ...bridgePorts.map((p) => [bridge, p]), ["172.18.0.1", 22], ["172.18.0.1", 9000], ["172.18.0.1", 9001], [host, 3000], [host, 4000]] });
    let r = await rt.exec(a, `cat > /tmp/p.py && python3 /tmp/p.py '${arg}'`, probe, 180);
    if (r.code) fail(r);
    const p = JSON.parse(r.stdout.toString());
    results = p.blocked; works = p.works;
    if (name === "e2b") {
      // Firecracker MMDS je lokalni pro VM a nejde vypnout. Vyjimka plati, jen dokud obsahuje tyto klice bez tajnych hodnot.
      const mmds = `import json,urllib.request as u
o=u.build_opener(u.ProxyHandler({}));t=o.open(u.Request("http://169.254.169.254/latest/api/token",method="PUT",headers={"X-metadata-token-ttl-seconds":"60"}),timeout=5).read().decode()
print(json.dumps(sorted(json.loads(o.open(u.Request("http://169.254.169.254/",headers={"X-metadata-token":t,"Accept":"application/json"}),timeout=5).read()))))`;
      const m = await rt.exec(a, "cat > /tmp/m.py && python3 /tmp/m.py", Buffer.from(mmds), 30);
      delete results.metadata_ip;
      results.metadata_only_known_keys = m.code === 0 && JSON.stringify(JSON.parse(m.stdout.toString())) === JSON.stringify(["accessTokenHash", "address", "envID", "instanceID"]);
    }
    // Listener v B: A na nej nesmi dosahnout ani kdyz nasloucha.
    await rt.exec(b, "nohup python3 -m http.server 8000 >/dev/null 2>&1 & sleep 1");
    const peer = SILENT_OK
      ? `import socket,sys\ntry:\n s=socket.create_connection(('${b.ip}',8000),timeout=4);s.sendall(b'GET / HTTP/1.0\\r\\nHost: ${b.ip}:8000\\r\\n\\r\\n');s.settimeout(4);sys.exit(1 if s.recv(100) else 0)\nexcept OSError:\n sys.exit(0)`
      : `import socket;socket.create_connection(('${b.ip}',8000),timeout=4)`;
    const pr = await rt.exec(a, "cat > /tmp/peer.py && python3 /tmp/peer.py", Buffer.from(peer));
    results.peer_sandbox_listener = SILENT_OK ? pr.code === 0 : pr.code !== 0;
    const dump = (await rt.exec(a, SCAN)).stdout;
    for (const [label, value] of Object.entries(secrets)) results[`no_${label}_readable`] = !dump.includes(Buffer.from(value));
    // Task API: co projde pres gateway s tokenem a bez nej.
    r = await rt.exec(a, `cat > /tmp/t.py && python3 /tmp/t.py ${JSON.stringify(b.gatewayEnv.TASK_TOKEN)}`, Buffer.from(TASK_PROBE), 60);
    if (r.code) fail(r);
    const t = JSON.parse(r.stdout.toString());
    Object.assign(works, { task_comments: t.own === 200 && t.number === 1, task_reply: t.reply === 202 });
    Object.assign(results, {
      task_no_token_rejected: t.none === 401, task_bad_token_rejected: t.bad === 401,
      task_token_scoped_to_issue: t.other_number === 2,
      task_no_forgejo_api: t.forgejo === 403, task_no_forgejo_path_escape: t.escape === 403,
      task_no_pr_create: t.pulls === 403, task_no_git_http: t.git === 403,
      task_no_litellm_admin: t.admin === 403, task_reply_too_large_rejected: t.large === 413,
    });
    const stored = JSON.parse(fs.readFileSync(taskA, "utf8")).reply ?? "";
    results.task_reply_truncated = stored.length === factory.MAX_REPLY;
    const expired = JSON.parse(fs.readFileSync(taskB, "utf8"));
    expired.expires = 0;
    factory.saveTask(taskB, expired);
    results.task_expired_rejected = factory.loadTask(b.gatewayEnv.TASK_TOKEN) === null;
  } finally {
    for (const f of [taskA, taskB]) if (f) fs.rmSync(f, { force: true });
    for (const [s, k] of [[a, key], [b, keyB]] as const) {
      if (k) await factory.revokeKey(k);
      await rt.destroy(s);
    }
  }
}

// Skodlivy patch: pokus zapsat hook pres cestu .git/ pri aplikaci na hostiteli
{
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "sec-"));
  const g = ["-c", "user.name=x", "-c", "user.email=x@x", "-c", "core.hooksPath=/dev/null"];
  await run("git", [...g, "init", "-q"], { cwd: t });
  await run("git", [...g, "commit", "-q", "--allow-empty", "-m", "base"], { cwd: t });
  const evil = "From: x <x@x>\nSubject: [PATCH] evil\n\n---\ndiff --git a/.git/hooks/pwn b/.git/hooks/pwn\nnew file mode 100755\n--- /dev/null\n+++ b/.git/hooks/pwn\n@@ -0,0 +1 @@\n+touch /tmp/pwned\n-- \n2\n\n";
  await run("git", [...g, "am", "-q"], { cwd: t, input: evil });
  results.patch_cannot_write_dotgit = !fs.existsSync(path.join(t, ".git/hooks/pwn"));
  fs.rmSync(t, { recursive: true, force: true });
}

const lines: Record<string, string> = {
  blocks_workflow: "diff --git a/.forgejo/workflows/x.yml b/.forgejo/workflows/x.yml", blocks_gitmodules: "diff --git a/.gitmodules b/.gitmodules",
  blocks_symlink: "new file mode 120000", blocks_binary: "GIT binary patch",
};
for (const [label, line] of Object.entries(lines)) results[`patch_${label}`] = factory.checkPatch(line) !== null;
results.patch_allows_normal = factory.checkPatch("diff --git a/src/app.py b/src/app.py\nindex 12..34 100644") === null;
// Rename s mezerou v nazvu projde textovym filtrem, musi ho chytit kontrola vysledku.
{
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "sec-"));
  const g = (...a: string[]) => run("git", ["-c", "user.name=x", "-c", "user.email=x@x", ...a], { cwd: t });
  await g("init", "-q");
  fs.writeFileSync(path.join(t, "foo bar"), "hi\n");
  await g("add", "-A"); await g("commit", "-qm", "base");
  const base = (await g("rev-parse", "HEAD")).stdout.toString().trim();
  results.tree_allows_normal = await (async () => {
    fs.writeFileSync(path.join(t, "ok.txt"), "ok\n");
    await g("add", "-A"); await g("commit", "-qm", "ok");
    return (await factory.checkTree(t, base)) === null;
  })();
  fs.mkdirSync(path.join(t, ".github/workflows"), { recursive: true });
  await g("mv", "foo bar", ".github/workflows/x.yml"); await g("commit", "-qm", "evil");
  results.tree_blocks_rename_into_ci = (await factory.checkTree(t, base)) !== null;
  await g("reset", "-q", "--hard", "HEAD~1");
  fs.symlinkSync("/etc/passwd", path.join(t, "link"));
  await g("add", "-A"); await g("commit", "-qm", "link");
  results.tree_blocks_symlink = (await factory.checkTree(t, base)) !== null;
  fs.rmSync(t, { recursive: true, force: true });
}
results.sender_bot_rejected =!(await factory.mayTrigger("factory-admin/fixture", factory.BOT));
results.sender_owner_allowed = await factory.mayTrigger("factory-admin/fixture", "factory-admin");
results.sender_unknown_rejected = !(await factory.mayTrigger("factory-admin/fixture", "nobody-here"));

const fails = Object.keys(results).filter((k) => !results[k]).sort();
const bad = Object.keys(works).filter((k) => !works[k]).sort();
console.log(JSON.stringify({ runtime: name, passed: Object.values(results).filter(Boolean).length, total: Object.keys(results).length, failed: fails, broken_functionality: bad }, null, 1));
const out = path.join(ROOT, "tests/results");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, `security-${name}.json`), JSON.stringify({ blocked: results, works }, null, 1));
process.exitCode = fails.length || bad.length ? 1 : 0;
