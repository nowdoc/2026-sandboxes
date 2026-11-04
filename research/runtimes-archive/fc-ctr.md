# fc-ctr: firecracker-containerd main@be68640 (2026-07-16) + Firecracker 1.17.0, kernel 4.14.174

**Verdict:** A low-level kit: hard KVM isolation and no egress by default, but own build, runc 1.1.x, old kernel, no stdin EOF, no egress allowlist, credential injection or VM snapshot. For the PoC more work than Docker/gVisor.

Apache-2.0, no account, no releases/tags (only `main`, minimally maintained), 2 daemons (firecracker-containerd + a shim per VM), root (sudo), KVM yes.

## Running
```
01-factory-poc/runtimes/fc-ctr/up.sh              # loop + devmapper pool fcctr-pool (20G sparse) + containerd
./ctr.sh images pull --snapshotter devmapper docker.io/library/alpine:latest
./fcvm.sh create vm1 512 1                      # vmid memMiB vcpu (CNI fcnet, bridge fcctr-br0, 10.201.77.0/24)
./fcvm.sh run vm1 c1 docker.io/library/alpine:latest 0 sleep 3600   # privileged=0|1
./ctr.sh tasks exec --exec-id e1 c1 sh -c 'uname -r' </dev/null     # ALWAYS </dev/null
./down.sh                                       # kill VM + containerd, rm pool, loop, bridge
```
Build in Docker (`build.sh`, ~3.5 min + rootfs `tools/image-builder` ~2 min), the host NIC does not translate. The adapter `orchestrator/adapters/fc_ctr.py` requires a running up.sh.

## Works
- Cold start median 6.2 s (6.27/6.18/6.22; adapter 6.8-10.4 s), 3 in parallel 11.2-12.7 s. Idle RAM ~180 MB/VM (firecracker ~150 + shim ~30).
- Egress outward closed by default (1.1.1.1:443, metadata, LAN, DNS). Pause/resume works. Disks separate (devmapper snapshot).
- Compose: dind in a VM with 4 GB/2 vCPU, privileged dind, 15/15 healthy in ~20 s (images preloaded via stdin).

## Does not work
- stdin EOF is not propagated (`cat`, `tar -xf -` hang); tar only as `head -c <N> | tar -xf - -C dir`.
- Compose `nslookup web.cz.test 172.30.0.2`: the dns service does `apk add dnsmasq`, the guest has no internet.
- The host is open from the guest: 10.201.77.1:22, `<host>`:22, LLM GW `<host>`:4000. VMs see each other over L2 (ping, TCP 9000), bridge without isolation. pkg-gw unreachable.
- No credential injection/egress proxy (docker-credential-mmds only for image pull). No VM snapshot API.

## Caution
- runc 1.5.2 in the guest crashes (`runc did not terminate successfully: exit status 2`); runc 1.1.15 works.
- Compose requires a manual cgroup mount (cpu,cpuacct + net_cls,net_prio), iptables-legacy, `dockerd --allow-direct-routing` (otherwise "can't initialize iptables table `raw'"). Kernel without nftables, raw, ip6tables nat, pidfd.
- `firecracker-ctr run` can only do the default VM (1 vCPU, 128 MB), hence own `fcvm`. Host FORWARD policy DROP, DNS empty (`#MANUAL`).
- Never `pkill -f` in a shell (it killed the shell); look up `pgrep -x firecracker-con` and verify /proc/PID/exe.
- Leftovers after cleanup: state/devmapper/{data,meta} (sparse, 428 MB), root-owned state/root, state/run, state/shim/default#* (deletion blocked by a permission check).

## Not tested
- Credentials (unsupported), host mitigations (bridge without `isGateway` / INPUT rule), VM source IP 10.201.77.x at the gateway (unverified), gateway/route publication.
