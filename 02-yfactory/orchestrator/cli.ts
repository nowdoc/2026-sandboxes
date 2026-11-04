import process from "node:process";

async function call(method: string, p: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:8080${p}`, {
    method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

const [cmd, ...args] = process.argv.slice(2);
const usage = `yf ls
yf new <owner/repo> [prompt...]   without a prompt, only prepares a VM
yf publish <id>                   run branch -> provider and PR
yf rm <id>                        export sessions to S3 and delete the VM`;

try {
  if (cmd === "ls") {
    for (const r of await call("GET", "/api/runs")) {
      console.log([r.id, r.status.padEnd(7), r.vm ? "vm" : "  ", r.repo, r.pr ?? "", r.prompt.split("\n")[0].slice(0, 50)].join("  "));
    }
  } else if (cmd === "new" && args[0]) {
    const r = await call("POST", "/api/runs", { repo: args[0], prompt: args.slice(1).join(" "), keep: true });
    console.log(r.id);
  } else if ((cmd === "publish" || cmd === "rm") && args[0]) {
    const r = await call("POST", `/api/runs/${args[0]}/${cmd === "rm" ? "destroy" : "publish"}`, {});
    console.log(r.pr ?? r.status);
  } else {
    console.log(usage);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
