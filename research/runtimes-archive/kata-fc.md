# Kata Containers 4.3.1 + Firecracker 1.17.0 (no Kubernetes, own containerd + devmapper)
Verdict: partial. Only the **Go shim** (kata-go-static) works with FC; the runtime-rs shim (kata-static) has no network with FC.
License Apache-2.0, no account. Daemons: 1 own containerd (+ a shim and firecracker per VM).

## Restart (everything under runtimes/kata-fc, sudo -n only)
    runtimes/kata-fc/run.sh up        # losetup+dmsetup thin-pool kata--fc-pool (20G+1G sparse) + containerd (private mount ns)
    runtimes/kata-fc/run.sh test      # 3x cold start via orchestrator/adapters/kata_fc.py (needs running gw containers)
    runtimes/kata-fc/run.sh nerdctl ps -a      # nerdctl against its own socket (ns kata-fc)
    runtimes/kata-fc/run.sh down      # rm containers, stop containerd, remove pool
Image: `docker save factory-sandbox | run.sh nerdctl load` (once; unpack into devmapper).
Install from scratch: kata-static-4.3.1-amd64.tar.zst and kata-go-static-4.3.1-amd64.tar.zst (github release) -> root/opt/kata
(from the go tarball only bin/ and share/defaults; firecracker/jailer v1.17.0 into root/opt/kata/bin), nerdctl 2.4.2, cni-plugins 1.9.1 (bridge, host-local), /usr/bin/containerd 2.4.2 from the host.
Findings/hacks needed to run:
- the shim (rs and go) accepts only a "shipped" config = canonicalize(path) must be /etc/kata-containers/.. or /opt/kata/share/defaults/kata-containers/[runtime-rs/]configuration.toml;
  hence `ctrd.sh` does `unshare -m` + bind root/opt onto /opt (only for this containerd, host unchanged) and `configuration.toml` is a symlink to configuration-fc.toml.
  Swapping the hypervisor = swapping that symlink (one line) - see clh/qemu below.
- containerd 2.x: the transfer service needs `[[unpack_config]] snapshotter=devmapper`, otherwise "no unpack platforms defined".
- runtime-rs configuration-rs-fc.toml has a bug: dial_timeout_ms=45000 > reconnect_timeout_ms -> "reconnect_timeout_ms must be >= dial_timeout_ms" (fixed to 10/10000).
- runtime-rs + FC: network fails: "add net device ... After 500 attempts" (the device was added only after the VM started, FC cannot hotplug). The Go shim attaches the NIC before start -> OK.
- nerdctl: --data-root is necessary (otherwise it writes to /var/lib/nerdctl), --cgroup-manager cgroupfs, own --cni-netconfpath/--cni-path; nerdctl auto-creates nerdctl-bridge.conflist with the firewall plugin (unused, deleted).
- the go shim has debug off; enabling enable_debug slowed the start to 8-9 s (serial console).

## Measured
- cold_start_s (create incl. docker net+CNI -> first exec): 1.87 / 2.16 / 2.05, median 2.05 s (first exec 0.08-0.1 s). 3 parallel creates 3.7 s, destroy 3x 1.8 s.
- ram_idle_mb: 260 MB PSS on the host (firecracker 245 + shim 21), the VM sees 6 GB (default_memory 2048 + --memory 4g; the limit is added on top, not instead).
- exec: `nerdctl exec -i` OK, headless, as root via sudo -n. The return code is lost (nerdctl returns 1, "exec failed with exit code N" on stderr -> the adapter parses it).
- **stdin: EOF is NOT propagated** ("failed to close the process stdin: InvalidExecId"): `cat`, busybox `tar x` etc. hang. GNU tar (ends at the end marker) and `head -c N` work, 1 MB OK. The adapter wraps `head -c N | (cmd)`.
- egress (tests/probe.py, in the VM): 11/11 "blocked" (1.1.1.1, DNS, 169.254.169.254, 192.168.1.1, `<host>`:22, forgejo, litellm, proxy to a foreign domain, ...); packages_via_proxy true; llm_via_gateway false ONLY because the gateway answers 403 "unknown sandbox" (the source IP is not mapped to a key).
  Mechanism: the same topology as docker.py = per-task `docker network --internal` (no IP on the host, bridge named kfcXXXXX) + gateways attached; the VM attaches to that bridge via CNI `bridge` (isGateway=false, ipMasq=false, host-local, no default route in the guest). No change to the host firewall.
  The source IP seen by the gateway = the guest IP (10.77.N.100, the nginx log confirmed it, e.g. 10.77.91.101) -> IP->key mapping works the same as with the docker adapter (the adapter returns Sandbox.ip).
  The variant "CNI bridge without NAT on its own bridge with routing to the gateway containers" NOT TRIED (Docker FORWARD DROP + prohibition of touching the host firewall).
- compose (docker:29-dind inside the VM): 15/15 healthy, 9 s after dockerd start; WITHOUT --privileged, but: --cap-add NET_ADMIN,SYS_ADMIN,SYS_RESOURCE,NET_RAW,MKNOD, --security-opt systempaths=unconfined (/proc/sys is otherwise ro) and `mount -o remount,rw /sys/fs/cgroup` (cgroup2 ro). Without these: iptables "Permission denied" -> ip_forward ro -> cgroup ro.
  Storage driver overlayfs on an ext4 block rootfs (no overlay-on-overlay, no tmpfs trick needed). The Kata kernel 6.18.56 has BRIDGE, NETFILTER, NF_TABLES, NF_NAT, VETH, OVERLAY_FS, VXLAN built in (no modules) -> no own kernel needed.
  nslookup web.cz.test 172.30.0.2 FAIL: the dns container `apk add dnsmasq` has no egress ("dnsmasq (no such package)"), same as with other runtimes. Images alpine/busybox loaded by `docker load` from tar (pull from the network does not work).
- disk: container rootfs = devmapper thin snapshot as a virtio-mmio block (/dev/vdb ext4, 3.9G base_image_size 4GB); FC has no virtiofs, volumes/hosts/resolv.conf are copied (ShareFile). Each VM has its own snapshot, nothing shared.
- isolation: 3 VMs = 3 docker networks/bridges; A->B IP "Network is unreachable", host (172.17.0.1:22) unreachable; only the gateway container is shared (attached to all networks, by design). Each VM has its own disk.
- pause/unpause (nerdctl, cgroup freezer in the guest) OK. checkpoint/snapshot: `service Checkpoint: not implemented` -> Kata+FC has NO snapshot (FC can do it, Kata does not expose it).
- hypervisor swap (symlink configuration.toml): cloud-hypervisor and qemu: the VM starts, but the first `exec` hangs (>2 min, terminated), causes not investigated -> unverified/does not work in this environment. Nested virt performance not measured (only boot times).
- credentials (injecting FAKE-SECRET out of the VM's view): NOT TESTED (Kata has no proxy of its own; needs a MITM/egress proxy on the host).

## Cleanup / leftovers (see end of report)
`run.sh down` does not clean up by itself: two VMs ("kata-fc-cclh0", "kata-fc-cqemu0") from the hypervisor test hang in state Unknown; shims (kata-go-shim, ns kata-fc) and devmapper snapshots kata--fc-pool-snap-93/-95 hold the pool. These 2 shims must be killed manually, then `run.sh down`.
Adapter `orchestrator/adapters/kata_fc.py` (KataFcRuntime). Stale IPAM state: state/cni-ipam/*, /run/kata, /var/lib/nerdctl (first run without --data-root).
