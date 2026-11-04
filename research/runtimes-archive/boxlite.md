# BoxLite 0.11.0

**Verdict:** A daemonless microVM with a working IP allowlist and HTTPS secret substitution, but the default is allow-all and Compose inside does not work (kernel without bridge/netfilter). The gateway cannot tell tasks apart by IP; usable only without Compose.

Apache-2.0, no account, no daemon (1 `boxlite-shim` + bwrap per box), KVM yes (the host user is not in the kvm group).

## Running
```
# <bl> = /tmp/bl; install: cli/boxlite (release tar.gz, sha256 OK), pkg/ (unpacked cp313 wheel), home/ = BOXLITE_HOME (~1.1G image cache)
sudo -n setpriv --reuid=1000 --regid=1000 --groups=1000,<kvm-gid> env HOME=<bl>/hh BOXLITE_HOME=<bl>/home boxlite ...   # otherwise "/dev/kvm: permission denied"
boxlite exec -i BOX -- sh -c 'tar xf -'
```
After `boxlite stop`/`rm -f`, kill `boxlite-shim` (adapter: pgrep on `/boxes/<id>/bin/boxlite-shim`).

## Works
- Cold start create+start+exec median 2.41 s (first pull of python:3.13-slim ~14 s), idle RAM ~254 MB.
- create/start/exec -i/rm, Python SDK (Secret, NetworkSpec/OutboundNetworkSpec), adapter `orchestrator/adapters/boxlite.py`, tar over stdin.
- `--allow-net <IP>` rejects the rest (1.1.1.1, metadata, LAN, host :22). SDK `box.stop()` ends the shim, `clone_box` OK.

## Does not work
- Compose 0/15: guest kernel 6.12.87 without bridge/netfilter, dockerd "failed to create bridge docker0 via netlink: operation not supported" (even with `--cap-add ALL`, `--iptables=false`).
- Secrets on a host echo server: 502 (upstream cert verification, `SSL_CERT_FILE` did not help); verified only on httpbin.org.
- Gateway: sees source 172.18.0.1 for all boxes (gvproxy on the host), `llm_via_gateway` 403. Per-task identity would work via a Secret placeholder in Authorization (HTTPS) or a per-task port/path.
- No pause/resume.

## Caution
- Egress default is ALLOW-ALL; default-deny = always pass `--allow-net IP`. DNS stays open even with an allowlist (possible DNS exfiltration). Hostname rules only by SNI/Host on 80/443. Without allow-net the host is reachable as host.boxlite.internal (192.168.127.254).
- Secrets: SDK only (CLI cannot), HTTPS only (MITM); the placeholder is not substituted over plain HTTP. A placeholder sent to a non-allowed host without an allowlist goes out unchanged.
- CLI `stop`/`rm -f` leaves `boxlite-shim` (the VM) running. A box with an entrypoint (docker:dind) needs an explicit `start`.

## Not tested
- Content after snapshot restore (restore on a stopped box verified), own guest kernel, `boxlite serve` REST.
