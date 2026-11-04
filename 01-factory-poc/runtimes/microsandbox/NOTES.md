# Microsandbox 0.7.12

**Verdict:** The best of those tested: default-deny egress, verified secrets substitution, Compose without privileged (15/15). Weaknesses: beta, the gateway cannot distinguish sandboxes by IP.

Apache-2.0, no account, no daemon (1 `msb machine` process per sandbox), KVM yes (the host user is not in the kvm group).

## Running
```
# <ms> = /tmp/ms; install: release tar.gz (sha256 OK) -> <ms>/home/bin/msb + lib/libkrunfw.so.5.6.1, install.sh not run
sudo -n setpriv --reuid=1000 --regid=1000 --groups=1000,<kvm-gid> env HOME=<ms>/hh MSB_HOME=<ms>/home msb ...
msb create -n NAME -c 2 -m 4G --net-default-egress deny --net-rule allow@IP:tcp:PORT IMAGE
msb exec NAME -- cmd        # stdin ok
msb rm -f NAME
```

## Works
- Cold start ~1.0-1.3 s (adapter 1.25 s), idle RAM ~221 MB RSS per sandbox, 3 parallel OK.
- Secrets: `FAKE_ENV=... msb create --tls-intercept --secret FAKE_ENV@host [--tls-no-verify-upstream-for host]`; the sandbox only has `$MSB_FAKE_ENV`, the host received the real value; another host -> 403 `secret_policy_denied`.
- Compose: `docker:dind` without privileged, 15/15 healthy in 10 s (`compose_probe_tmpfs.sh`).
- pause/resume, `snapshot create/restore` (0.07 s / 1.3 s, content restored), adapter `msb` CLI.

## Does not work
- Compose: `nslookup web.cz.test` failed, the dns container has no egress for `apk add dnsmasq`.
- Gateway: sees source 172.18.0.1 for all sandboxes, `llm_via_gateway` 403. Per-task identity only via a placeholder secret in Authorization (HTTPS) or a per-task port/path.

## Caveats
- Compose requires `mount -t tmpfs tmpfs /var/lib/docker`, otherwise an overlay-on-overlay error (`failed to mount ... overlay: invalid argument`).
- The probe reports metadata/LAN :80 as not blocked: TCP connects to the MSB gateway, which returns 403, nothing leaves.
- nip.io -> private IP is blocked by DNS rebind protection (`--no-dns-rebind-protection`). Default guest subnet pool 172.16.0.0/12 (`--net-ipv4-pool` on collisions).

## Not tested
- 3 parallel under load, fork, `snapshot --full`, inner Compose egress.

## TS adapter ([microsandbox.ts](../../orchestrator/adapters/microsandbox.ts)), in the UI
- Binary `home/bin/msb` + `home/lib/libkrunfw.so.5.6.1` (from the tarball, sha256 OK), `MSB_HOME=runtimes/microsandbox/home`. `msb` refuses to start when any ancestor of `MSB_HOME` is group-writable: `chmod g-w runtimes runtimes/microsandbox`, and `home` must be owned by the host user.
- The orchestrator is root and runs `msb` via `setpriv` as the host user with the kvm group (root `msb` rejects the host user's paths).
- Image: `docker export factory-sandbox | tar -x -C runtimes/microsandbox/rootfs` (as the host user). **`msb` does not copy the directory, it mounts it for writing.** The adapter therefore makes a per-task copy in `tasks/` and deletes it after the task. Previously tasks shared files. The files belong to the host user (uid 1000 = `agent`).
- Network: `--net-default-egress deny`, only `allow@<llm-gw>:tcp:4000,4001` and `<pkg-gw>:tcp:3128` on IPs in `factory-core`, `--net-ipv4-pool 10.200.0.0/16` (the default 172.16/12 overlaps the Docker bridge). No published port, no change to the host apart from `chmod`.
- Env (`LLM_API_KEY`, `TASK_TOKEN`) goes to the sandbox on stdin (`adapters/env.ts`), it is not in the host's `ps` (measured). `msb exec` with tar over stdin works.
- Measured: create+exec ~0.8 s, E2E to PR 2× + from the UI + iteration (1 review comment), security 54/54, 0 sandboxes after the run, nothing left in the network or in `state/tasks`.
- **Test exception:** msb terminates TCP on port 80 itself and returns 403 `network_policy_denied`. `connect()` therefore succeeds (`metadata_ip`, `lan_router`, peer :80), so `tests/probe.py` treats it as blocked for `deny_marker` when this response arrives. Verified that the listener on `<host>:80` did not receive even a connection.
