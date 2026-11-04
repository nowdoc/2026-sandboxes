// VS Code (code-server) of a run's VM, on its own port: another origin than the UI, so a page served from the VM cannot call the UI API.
import http from "node:http";
import { inc } from "./metrics.ts";
import { proxyHttp, proxyUpgrade } from "./proxy.ts";
import * as sandbox from "./sandbox.ts";
import { sameOrigin } from "./terminal.ts";

export const PORT = Number(process.env.YF_IDE_LISTEN ?? 8081);

// Defaults for a new VM; a person may change them in the IDE. No Copilot or other built-in AI: the agent is opencode.
const SETTINGS = { "chat.disableAIFeatures": true, "workbench.startupEditor": "none", "telemetry.telemetryLevel": "off" };

// As agent with the run env, so its terminal is the same as `make shell`. Idempotent: a running code-server is kept.
// --noproxy: the run env sends HTTP through squid, which cannot reach the VM itself.
export const START = `curl -sf --noproxy '*' -o /dev/null http://127.0.0.1:8443/healthz && exit 0
mkdir -p ~/.yf/code-server/User
[ -f ~/.yf/code-server/User/settings.json ] || cat > ~/.yf/code-server/User/settings.json <<'EOF'
${JSON.stringify(SETTINGS, null, 1)}
EOF
setsid nohup code-server --auth none --bind-addr 0.0.0.0:8443 --disable-telemetry --disable-update-check --disable-workspace-trust \
  --user-data-dir ~/.yf/code-server /workspace >~/.yf/code-server.log 2>&1 </dev/null &
for i in $(seq 100); do curl -sf --noproxy '*' -o /dev/null http://127.0.0.1:8443/healthz && exit 0; sleep 0.2; done
exit 1`;

// /<run id>/<path>; the path is resolved here, so "../" cannot leave the run's VM.
function route(url: string, vmOf: (id: string) => string | null | undefined) {
  const m = /^\/(\w+)(\/.*)?$/.exec(url);
  const vm = m && vmOf(m[1]);
  if (!vm) return null;
  if (!m[2]) return { redirect: `/${m[1]}/` };
  const u = new URL(m[2], "http://ide");
  return { vm, path: u.pathname + u.search };
}

export function serve(vmOf: (id: string) => string | null | undefined) {
  const server = http.createServer((req, res) => {
    const r = route(req.url ?? "/", vmOf);
    if (!r) return void res.writeHead(404).end();
    if ("redirect" in r) return void res.writeHead(302, { Location: r.redirect }).end();
    proxyHttp(req, res, sandbox.ideTarget(r.vm, r.path, req.headers));
  });
  server.requestTimeout = 0;
  // The same guard as the terminal: the UI has no login, a foreign page must not open the IDE's WebSockets.
  server.on("upgrade", (req, socket, head) => {
    const r = route(req.url ?? "/", vmOf);
    if (!r || "redirect" in r || !sameOrigin(req)) return void socket.end(`HTTP/1.1 ${r ? 403 : 404} Forbidden\r\nConnection: close\r\n\r\n`);
    inc("yf_ide_connections_total");
    proxyUpgrade(req, socket, head, sandbox.ideTarget(r.vm, r.path, req.headers));
  });
  server.listen(PORT);
}
