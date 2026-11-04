# E2B Embed (runtime main; orchestrator v0.16.202610201713, api v0.14.202610271447, Firecracker v1.14-0.2.0, kernel 6.1.177, SDK 2.46.1)

**Verdict:** A Firecracker microVM with a 0.17 s cold start, pause/resume and Compose inside (15/15), but a heavy stack that mutates the host. Unusable as a credential gateway: header transforms and Secrets do not work in Embed, private ranges are hard-blocked.

Apache-2.0, no account, 10 long-lived containers + the orchestrator on the host (privileged, pid:host), KVM yes. Everything is measured unless marked "read".

## Running
```
cd 01-factory-poc/runtimes/e2b/stack && sg docker -c 'HUGEPAGES=1024 docker compose -p e2b up -d --wait'
sg docker -c 'docker compose -p e2b down'          # stop
# API key: docker compose exec ready cat /run/e2b/sdk.env (saved to state/sdk.env); SDK via API :13000, proxy :3002; node SDK via run.sh
```
The stack copy of compose.yaml has the API port 3000->13000 (Forgejo holds :3000). The stack is currently RUNNING (per the coordinator), no sandboxes.

## Works
- Cold start median 0.167 s (0.405/0.157/0.167), template e2b-docker 0.49 s; via the adapter 1.4-1.5 s (docker run node CLI). 3 in parallel create+exec 0.66 s.
- Pause 0.14 s, resume 0.30 s (files and processes survived). Destroy returns hugepages, nbd, firecracker.
- `denyOut:['0.0.0.0/0']` + `allowOut` of domains (SNI/Host filter) works.
- Compose in the `e2b-docker` template (build 44 s, 4 vCPU, 1.5 GB): 15/15 healthy in 13 s, `nslookup web.cz.test 172.30.0.2` OK, without privileged.
- Isolation: separate disks, sandboxes do not see each other, host/LAN unreachable. tar over stdin (sendStdin+closeStdin) OK.

## Does not work
- `network.rules` `transform.headers`: the API accepts it, the header was not injected (httpbin sees only the client header). `Secret.create` -> `403: Secrets are not available for this team`; `Secret.fill` just returns `${e2b.secrets.x}`.
- `egressProxy` (SOCKS5): `400: Invalid egress proxy config: egress proxy endpoint resolves to an internal / denied IP range: 127.0.0.1`; not tested on a public IP.
- Gateway: RFC1918, 100.64/10, 127/8, 169.254/16 are always hard-blocked (nft `filtered_always_denylist`), llm-gw 172.18.0.4, pkg-gw 172.18.0.2 and LiteLLM `<host>:4000` are unreachable. The workaround via alias 198.18.0.10 on the host works, but the source IP is the same for all sandboxes. Proposal: destination address/port per task.
- Sandbox with 1536 MiB + a concurrent build: `500: Failed to place sandbox: this node cannot map 512 MiB of guest memory`.

## Caveats
- Egress default = the whole internet allowed; always specify `network:{denyOut,allowOut}`. A blocked TCP `connect()` looks successful (the test must be at application level).
- Ports without authentication on all interfaces including LAN (ss): 5008 (gRPC create/kill), 5007, 5009, 5109, 5010, 5016-5018, 3001, 3002, 3003, 3010, 13000; 30006 loopback only. The vendor has no bind option.
- RAM: stack ~5 GiB (orchestrator ~3.5, clickhouse ~1.1, postgres ~0.4) + 2 GiB hugepages; idle sandbox 512 MiB ~170 MiB (~85 hugepages); a 2 GiB pool = ~3 sandboxes at full load / ~10 idle.
- Sandbox: Debian 12, uid 1000 `user` with sudo, 2 vCPU, 473 MB, disk 813M (100 % after a pull), same boot_id and IP 169.254.0.21 across sandboxes. `ns-N` netns stay in the pool (~45).
- The orchestrator adds ~300 rules to the host iptables (304 `veth-`: FORWARD, nat REDIRECT to 5010/5016-5018, PREROUTING DROP).

## Not tested
- Snapshot/fork (API only), SOCKS5 on a public IP, whether orchestrator teardown restores iptables (unverified), `diskSizeMB` in the builder, Python SDK.

## Host revert (not reverted, the coordinator decides)
Changes: /etc/modules-load.d/e2b.conf, /etc/modprobe.d/e2b-nbd.conf, /etc/udev/rules.d/97-nbd-device.rules, /etc/sysctl.d/90-e2b.conf (vm.nr_hugepages=1024, tcp_max_syn_backlog=65535, vm.max_map_count=1048576 was already set; tcp backlog was 2048), modules nbd/tun, mangle FORWARD TCPMSS clamp, directories /var/lib/e2b, /fc-*, /orchestrator, /var/run/netns. State before: state/pre.txt, state/iptables-pre.save. Installed via apt by the coordinator: rsync iptables e2fsprogs iproute2.
```
cd 01-factory-poc/runtimes/e2b/stack
docker compose -p e2b down -v && docker compose -p e2b --profile purge run --rm host-teardown
iptables-save | diff - ../state/iptables-pre.save     # verify
cat /proc/sys/vm/nr_hugepages                          # must be 0
sysctl -w net.ipv4.tcp_max_syn_backlog=2048            # host-teardown does not restore this
```
The kvm/tun modules stay loaded. The e2b Docker images (tools, node-e2b, api, ...) stay.

## TS adapter ([e2b.ts](../../orchestrator/adapters/e2b.ts)), in the UI
- Calls `runtimes/e2b/js/cli.mjs` via `docker run`. User `user`, `/workspace` and `/task` are created by root on create.
- Network: only `denyOut 0.0.0.0/0`, no domains in `allowOut`. With domains, E2B allows DNS to 8.8.8.8 (exfiltration). LLM, task API and squid go via `198.18.0.10:4000/4001/3128`. Do not put that IP in `allowOut`, otherwise the sandbox can reach the host's SSH and the E2B control API.
- Security 52/52 with exceptions: `metadata_ip` is replaced by a check of the MMDS keys (`accessTokenHash`, `address`, `envID`, `instanceID`, 401 without a token); the peer test on :22 and :80 is dropped because sandboxes have the same IP. The peer listener test is therefore weak. The same `silent_ok` exception as for sbx.
- Not closed: `192.0.2.1` is hard-allowed because of `/logs`; on the tested TCP ports (22, 3000, 4000, 5008, 5432, 8123, 13000, 30006) it returned no data. Port 80 and writing to the logs not tested.
- Dashboard: <http://<host>:3001>, login with the API key, listens on all interfaces.
