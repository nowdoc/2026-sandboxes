# sbx (Docker Sandboxes) v0.50.1

**Verdict:** Technically the most polished (microVM, host-side default-deny proxy, `set-custom` secrets for any host, Compose without privileged). Against the PoC: mandatory Docker account, proprietary license, the gateway cannot distinguish tasks by source IP.

Proprietary (Docker Subscription Service Agreement), requires a Docker account (login), 1 daemon `sandboxd` (~200 MB RSS) + a shim per sandbox, KVM (kvm group).

## Running
```
sbx daemon start
sbx policy init                       # required before first use (otherwise "Global network policy not initialized")
sg kvm -c 'sbx create ...' ; sg kvm -c 'sbx exec N -- cmd' </dev/null
sbx policy allow network --sandbox N host[:port],...
sbx rm --force N
```
Binary /usr/local/bin/sbx (from the user), a copy of the tarball in `runtimes/sbx/prefix`. Global policy `deny-all` is set (left in place, together with the user's login).

## Works
- Cold start create->exec median 14.0 s (11.8-15.8); restart of a stopped one + exec ~8 s, FS survives. Idle RAM ~1150 MB (shim ~949 + sandboxd ~200); the VM defaults to the host's CPU and memory.
- Egress default-deny: 1.1.1.1, DNS, metadata, LAN, host :22 blocked. Allow per sandbox/domain/IP/CIDR.
- Credential injection: `sbx secret set-custom --sandbox N --host IP --placeholder PH-{rand} --value ...`; the echo server received the value in Authorization and X-Api-Key, not found in the sandbox.
- Compose: 15/15 healthy in 19 s, `nslookup web.cz.test` OK, without privileged.
- Snapshot `template save N tag` (stopped only, 0.3 s) + `create --pull never -t tag`; stop/start; 2-3 parallel; tar via `sbx exec -i`.

## Does not work
- Gateway: source IP = host for all sandboxes, IP->key mapping not possible (llm-gw 172.18.0.4:4000 answers 403 "unknown sandbox" after allow).
- `template save` on a running one: "stdin is not a terminal; pass --force" (--force does not exist, it passes after `sbx stop`). `exec -d` not supported. No pause/resume.
- Chain to pkg-gw:3128 from the VM: `curl -x 172.18.0.2:3128` "Failed to connect" (pkg is handled by domain allow in sbx).

## Caveats
- Secrets are substituted locally only in HEADERS (not URL/body; --header/--format only with --cloud). Set the env with the placeholder manually via `sbx exec -e`. A placeholder sent to another allowed host stayed a placeholder.
- The workspace (`sbx create shell /path`) is a virtiofs rw bind; two sandboxes with the same path share the directory. Without a path there is no mount.
- A raw TCP connect "succeeds" (transparent proxy), no data passes. Secrets on disk are protected only by file permissions (no keychain).
- Docker Hub pull requires allow: registry-1.docker.io, auth.docker.io, production.cloudfront.docker.com, *.r2.cloudflarestorage.com.

## Not tested
- HTTPS on a custom host for secrets, e2e with LiteLLM, `sbx settings` proxy/proxy.sandbox, traffic volume to Docker (read from the docs: login.docker.com, hub/api.docker.com, marlin-*.docker.com telemetry, sbx-diagnostics S3; `SBX_NO_TELEMETRY=1` create+exec works, effect not measured), listening server between sandboxes.

## TS adapter ([sbx.ts](../../orchestrator/adapters/sbx.ts)), in the UI
- The login belongs to the host user, root is "not signed in". The orchestrator (root) therefore runs `sbx` via `setpriv` as the host user with `HOME=` set to that user's home; nothing is copied and no new login happens. Dependency: the host user must stay logged in.
- Sandbox `shell` without a workspace, `--cpus 2 --memory 4g`, `/workspace` and `/task` are created by `sudo` inside. Rules `sbx policy allow network --sandbox`: `198.18.0.10:4000`, `:4001` and the domains from `gateway/allowlist.txt` (packages go through the sbx proxy, not squid).
- The Docker network `factory-core` (172.18.0.0/16) overlaps `docker0` inside the VM: direct TCP to `172.18.0.2` ends with `No route to host` (only curl via the proxy gets through). That is why the gateway publishes `198.18.0.10:4000/4001` (alias on `lo`, `up.sh`, [compose.yml](../../gateway/compose.yml)).
- Env goes via stdin (not in `ps`, measured). Cold start create+init ~8 s.
- Measured: E2E to PR 2× + from the UI + iteration, security 54/54, 0 sandboxes after the run, 0 files in `state/tasks`.
- **Test exception:** the sbx proxy accepts every TCP connection and returns not a single byte for forbidden destinations. `tests/probe.py` with `silent_ok` treats it as blocked when nothing arrives after the HTTP request (an SSH banner or HTTP would arrive). The listener on `<host>:8099` received no connection. The sandbox peer test is weak with sbx: the sandboxes have the same inner IP 172.17.0.x, so A connects to its own address.
- The rest see above: account, proprietary license, telemetry not measured.
