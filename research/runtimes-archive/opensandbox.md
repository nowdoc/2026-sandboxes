# OpenSandbox server 0.x, egress v1.1.7, execd v1.1.0, Python SDK 1.2.0

**Verdict:** The Credential Vault with dns+nft works end-to-end and the secret is not in the sandbox, but egress has unsafe defaults and requires workarounds, and the gateway is reachable only through a relay. Compose does not work and gVisor does not work with egress, so only usable as a vault+egress layer without Compose.

Apache-2.0, no account, 1 python server (~174 MB RSS, root/sudo, docker access) + a sidecar container per sandbox, no KVM (Docker).

## Running
```
curl https://astral.sh/uv/install.sh | UV_NO_MODIFY_PATH=1 sh    # uv v0.13.6 (read before running), -> ~/.local/bin
uv tool install opensandbox-server ; uv pip install opensandbox   # SDK in venv/
uvx opensandbox-server init-config sandbox.toml --example docker  # edit: port 18480, [egress].mode="dns+nft", port_range >=100, server.api_key
sudo env SANDBOX_CONFIG_PATH=... opensandbox-server
```
Without api_key: "Startup blocked: server.api_key is empty in non-interactive mode". Images: opensandbox/execd:v1.1.0, opensandbox/egress:v1.1.7. Cleanup: kill/expiry of the sandbox.

## Works
- Cold start median 3.73 s (with the egress sidecar and relay), without policy ~1-2 s. 3 parallel ready in 4.4 s. Server ~174 MB RSS.
- Credential Vault (`credential_proxy=CredentialProxyConfig(enabled=True)` + `sb.credential_vault.create(credentials, bindings)`): HTTP and HTTPS both received `FAKE-SECRET-opensandbox-123` in the header/body, the sandbox env/proc/fs clean.
- Egress dns+nft: probe 14/14 blocked after workarounds. pause/resume (0.05/0.07 s, state survives). Adapter `orchestrator/adapters/opensandbox.py` (rc, stderr, tar via the files API + shell redirect, 5 MB stdin).

## Does not work
- Compose 0/15: Docker backend without privileged/cap_add; runc: dockerd `iptables ... Permission denied`; gVisor `runsc-dind`: `iptables nat: Table does not exist`, with `--iptables=false` `Failed to create bridge docker0 via netlink: operation not permitted`.
- gVisor + networkPolicy: "gVisor does not support the nftables rules required by the egress sidecar".
- Snapshot on Docker 29: `docker commit 404 "failed to apply diff: snapshot ... does not exist"`.
- Gateway: the bridge is isolated from factory-core; through a per-task relay (`opensandbox-relay-<task>`, alpine/socat) nginx returns 403 "unknown sandbox" (the relay IP is not in keys/map.conf, not modified); `/key/*` 403. Identity = relay IP.

## Caution
- Without networkPolicy the sandbox is open (internet, LAN, host SSH 172.17.0.1:22, `<host>`:22, other sandboxes).
- dns+nft whitelists the nameservers from the host's resolv.conf on all ports (LAN router 192.168.1.1 reachable on 80/443/22; confirmed in the source nameserver.go) -> user deny for 192.168/16, 10/8, 169.254/16 (deny wins).
- A policy with only IP rules does not enable the DNS filter (example.com resolves); `docker network connect` of the sidecar overwrites resolv.conf to 127.0.0.11 and bypasses the DNS filter.
- Vault: `hosts` must be FQDNs (an IP is rejected), bindings must not overlap ("can match the same request"), only http/https 80/443; the secret is in the sidecar's memory. A placeholder to an unbound host passes unsubstituted. A response echoing the secret ends up in the /tmp/*.stdout log of execd.
- The adapter returns stdout only as text lines (not binary), SDK `commands.run` has no stdin. After an uncaught exception in the SDK the container+volume remained. A one-off 30 s stall at `start sandbox container`.

## Not tested
- Kata/Firecracker (read): Firecracker only in Kubernetes Fast Sandbox, Kata via `docker_runtime="kata-runtime"` requires registration in daemon.json (change forbidden, not installed).
