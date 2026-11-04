# OpenShell 0.1.6 (NVIDIA)

**Verdict:** Policy and credential injection (placeholder, endpoint-bound substitution, L7 REST) are genuinely strong on both the docker and libkrun drivers, start 1.3 s / 2.2 s. Not suitable where the sandbox needs Docker Compose/root (0/15), and task identity by source IP at the nginx gateway does not work.

Apache-2.0, no account, 1 gateway (gRPC, SQLite, root via sudo) + a driver, KVM only for the VM driver (libkrun).

## Running
```
# release tarballs v0.1.6 (sha256 OK) in bin/: openshell, openshell-gateway, openshell-driver-vm, openshell-supervisor; install.sh not run
openshell-gateway generate-certs --output-dir state/tls     # gateway_jwt bundle, needed for both docker and VM driver
./gwctl.sh ...                                              # gw-docker.toml (port 17680), gw-vm.toml (17681)
XDG_CONFIG_HOME=cfg openshell -g os-docker|os-vm sandbox create --detach --no-tty -- sleep infinity
XDG_CONFIG_HOME=cfg openshell -g os-docker sandbox exec NAME --no-tty -- sh -c ...
```
Gateway config for the local test: `[openshell.gateway.auth] allow_unauthenticated_users=true`, `disable_tls=true`, 127.0.0.1.

## Works
- Cold start docker 1.30 s, VM 2.24 s (first VM 16.7 s). Idle RAM: docker ~25 MB/sandbox, VM ~140 MB (+ gateway ~290 MB, driver-vm 28 MB shared).
- Egress default-deny, probe all BLOCKED on both drivers; live policy update (`policy set --wait`); L7 REST `access: read-only` -> POST 403 `policy_denied`.
- Credentials: `profile import` + `provider create --credential OSECHO_TOKEN=...` + `sandbox create --provider`; in the sandbox only `openshell:resolve:env:v...`, the echo server received the value in the header, query and Bearer. Another allowed host -> 403 `credential_endpoint_mismatch`, a disallowed one -> EACCES.
- Adapter `orchestrator/adapters/openshell.py` (docker and VM), tar over stdin, 3 in parallel, VM stop/start (~2 s).

## Does not work
- Compose 0/15: the workload is not root (the policy rejects `run_as_user: root`), CapBnd=0, `unshare -Urn` EPERM, no network and tun, no /dev/kvm in the VM.
- Gateway: nginx sees 172.18.0.1 for all sandboxes, 403 "unknown sandbox". Identity via a per-task credential header (verified only on an echo server) or a per-task gateway.
- `sandbox suspend/resume`: "compute driver does not support sandbox suspend". No snapshot.

## Caution
- Sandbox name max 19 characters including `factory-task-` -> task id max 6 characters, otherwise "name exceeds maximum length (20 > 19)".
- After batch deletion the VM driver left 10 `openshell-driver-vm --internal-run-vm` processes + state directories (`sandbox list` empty), killed manually; a simple delete cleans up. Possible leak.
- `packages_via_proxy` requires `tls: skip` on 172.18.0.2:3128. Per-binary rules are brittle (hash/path of the binary). Private IPs require `allowed_ips`.
- A sandbox with the right to an allowed endpoint can have the secret echoed back. Telemetry is on by default (`OPENSHELL_TELEMETRY_ENABLED=false`).
- `external_dns:false` in the probe is a false alarm (synthetic 198.18.0.x, connect EACCES).

## Not tested
- DNS exfiltration (tunnel via TXT), real LiteLLM gw with a per-task header, dockerd in the sandbox (only preconditions verified).

## Retest 2 (2026-11-01, without sudo: `sg docker` / `sg kvm`)
### dockerd + Compose in the sandbox: FAIL 0/15, DELIBERATE RESTRICTION (no configuration option)
- Image `openshell-dind` = factory-sandbox + apt `docker.io docker-cli docker-compose iptables` (Dockerfile deleted; 1x RUN apt-get install). VM: --from rootfs.tar (docker export).
- Measured on both VM and docker driver: uid 1000, CapEff/CapBnd=0, NoNewPrivs=1, `unshare -Ur` -> "Operation not permitted".
- `dockerd` -> "dockerd needs to be started with root privileges. To run dockerd in rootless mode as an unprivileged user, see https://docs.docker.com/go/rootless/"
  (after --userland-proxy=false --iptables=false --bridge=none --storage-driver=vfs). Rootless does not work: userns is blocked by seccomp, newuidmap is not in the image.
- Sources (read, NVIDIA/OpenShell main): `validate_policy_safety` rejects run_as_user root (policy: "must be 'sandbox' or numeric UID in [1, ...]"); seccomp.rs hard-blocks
  unshare/clone CLONE_NEWUSER and sets PR_SET_NO_NEW_PRIVS; the docker driver has no cap_add/privileged (only cdi_devices, mounts). No policy/process/image/driver_config knob. (I did not try Alpine docker:29-dind after fixing KVM.)
- Note: docker:29-dind image prep in the VM failed only because of /dev/kvm permission (see below), not because of alpine.
### LiteLLM through nginx (without the IP map)
- Profile `llmgw` (endpoint IP gw:4000, path /v1/**, credential LITELLM_API_KEY bearer) + provider with FAKE-SECRET-openshell-123, docker and VM driver:
  `curl -H "Authorization: Bearer $LITELLM_API_KEY" .../v1/chat/completions` -> 401 from LiteLLM: "LiteLLM Virtual Key expected. Received=FAKE****-123" = the real value passed through nginx all the way to LiteLLM (nginx log: POST /v1/chat/completions 401 from 172.18.0.1; the LiteLLM log says the same). `/key/generate` with the key -> 403 (nginx). In the sandbox env only the placeholder.
- The IPs of the gw containers changed in the meantime (llm 172.18.0.2, pkg 172.18.0.4) -> the adapter now takes them from `docker inspect`.
### Operation without sudo
- Gateway: docker driver `sg docker`, vm driver `sg kvm` (gwctl.sh). A nested `sg kvm -c "sg docker ..."` loses kvm -> "cannot open /dev/kvm: Permission denied" (and then a misleading "image-prep vm exited").
- A VM gateway without a Docker socket does not see local images ("Not authorized: .../factory-sandbox") -> image as a rootfs tar (`--from x.tar`), requires `allow_driver_config=true` in `[openshell.drivers.vm]`; PATH must include /usr/sbin (mke2fs).
- Two gateways must not share XDG_STATE_HOME ("database is locked"). `ss -p` does not see the PIDs of processes started via sg -> stop by PID.
- Cold start by adapter (incl. docker inspect + provider create): docker 1.70 s, VM from rootfs.tar 6.06 s (earlier 2.24 s from image cache). Probe again: everything blocked; `llm_via_gateway` false = 401 (no key), reachability confirmed.
- Cleanup: sandboxes, gateways, VM processes, state dirs, image openshell-dind:test, tars deleted. Note: I also deleted state/tls (JWT bundle) -> before the next run `openshell-gateway generate-certs --output-dir state/tls`.
