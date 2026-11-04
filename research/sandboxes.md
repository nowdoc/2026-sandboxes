# Sandboxes for AI agents (self-hosted) - research

As of 2026-11-01. Web reading only (WebSearch/WebFetch), nothing installed or run, `01-factory-poc/runtimes` not read. What was later measured is in [../README.md](../README.md#runtimes).
The source date is given only when the page itself states it; otherwise "no date". Claims marked [P] = primary source (repo/documentation/advisory), [S] = secondary/aggregator, [M] = marketing/vendor. I could not find real user experience (HN/Reddit/postmortems), see the section "Not found".

## Verified facts (with URLs)

### Microsandbox
- Beta: "Expect breaking changes, missing features, and rough edges"; Apache-2.0; ~8.9k stars; "Backed by Y Combinator"; the GitHub org is superradcompany; requires KVM on Linux. Mentions libkrun as the underlying layer. No date. [P] https://github.com/zerocore-ai/microsandbox
- Official "Docker in a sandbox" guide: a microVM from the `docker:dind` image, dockerd is started by a script, flat root disk 10 GiB, 2 GiB RAM, Docker data survives stop/start and is deleted when the sandbox is removed. Flat root disk is so far local only, not in the cloud. No date. [P] https://docs.microsandbox.dev/how-to/docker/docker-in-sandbox.md
- Official Compose tests guide: `docker:27.5.1-dind`, `docker compose up --build --abort-on-container-exit` inside the microVM, number of services not stated, the cache is lost when the sandbox is deleted (reusing the sandbox keeps the cache). No date. [P] https://docs.microsandbox.dev/how-to/ci-cd/compose-tests.md
- Snapshots and "warm workers" are documented; the v0.6 to v0.7 migration means breaking API changes. [P] https://docs.microsandbox.dev/llms.txt
- The documentation has no page on nested virtualization or on privileged. [P] same
- A community compose file for running microsandbox in Docker uses privileged + seccomp/apparmor unconfined (that is the containerized server, not Compose inside the sandbox). [S] https://gitea.com/AlexSun/compose-anything/src/branch/main/builds/microsandbox

### E2B
- Infra repo: Apache-2.0; needs Linux with KVM; "E2B Embed" = the whole stack on one Linux host, started with `docker compose up -d --wait`. Components: API, orchestrator (Firecracker), template manager, client-proxy, envd, dashboard-api, PostgreSQL, Redis, ClickHouse, object storage. No date. [P] https://github.com/e2b-dev/infra
- The documentation/page does not mention nested virtualization; the E2B enterprise page lists Embed as "on the roadmap" (contradicts the infra repo README, where it is described as usable). [M] https://e2b.dev/enterprise.md
- I did NOT find the claim about unauthenticated gRPC in Embed. The search returned only the unrelated CVE-2025-14038 (EDB Hybrid Manager). The hypothesis remains unverified from the web.

### gVisor
- Official Docker-in-gVisor guide: outer container `--runtime runsc --cap-add all` (not `--privileged`), runsc flags `--net-raw` (all versions) and `--allow-packet-socket-write` (Docker 28+), inner dockerd `--iptables=false --ip6tables=false`, only host/bridge network, `--expose` does not work; Docker 29 requires tmpfs on /var/lib/docker or a disabled containerd-snapshotter. No date (© 2026). [P] https://gvisor.dev/docs/tutorials/docker-in-gvisor
  - Disagreement with the hypothesis: `--cap-add all` is required (in gVisor this is a capability inside the sandbox, not a host one), not "privileged"; but iptables really are absent. Confirms "no iptables".
- Issue #12145 (opened 2025-09-18, closed 2026-01-09): `docker:dind` does not work without its own init, `--expose` does not work; the maintainer mentions a DNS problem in Compose, issue #7469. [P] https://github.com/google/gvisor/issues/12145
- Issue about `nft: Protocol not supported` (both iptables and iptables-legacy). No date. [P] https://github.com/google/gvisor/issues/9917
- CVE-2026-95702: use-after-free in the VFS, a local attacker with ordinary privileges in the container can run code in the host sentry process; fixed in release 20260831.0; the sentry remains restricted by seccomp and namespaces. No disclosure date. [S, Debian tracker] https://security-tracker.debian.org/tracker/CVE-2026-95702

### Firecracker
- CVE-2026-1386: jailer, overwrite of an arbitrary file on the host through a symlink; Firecracker v1.13.1 and older and v1.14.0; fixed in v1.14.1 and v1.13.2; AWS states its services are not affected. Published 2026-01-23. [P] https://aws.amazon.com/security/security-bulletins/2026-003-AWS
- CVE-2026-5747: out-of-bounds write in the virtio-pci transport, CVSS 7.5, a patch exists. No date. [S] https://www.action1.com/vulnerabilities/cve-2026-5747/ (not confirmed against the AWS bulletin)

### runc / libkrun / crun
- runc CVE-2025-31133, CVE-2025-52565, CVE-2025-52881: container escapes through writes to /proc and bind-mounts; disclosed 2025-11-05; fixed in 1.2.8, 1.3.3, 1.4.0-rc.3; recommendation: user namespaces, do not assign host root. CVE-2025-52881 bypasses LSM labels. [P/S] https://www.openwall.com/lists/oss-security/2025/11/05/3 , https://sysdig.com/blog/runc-container-escape-vulnerabilities
- libkrun: SUSE advisories from 2026 are mostly OpenSSL dependencies, not a hypervisor escape; CVE-2026-5674 (CVSS 8.8) is in the Nixpkgs tracker, I did not load the description (the page requires JS). [S] https://linuxsecurity.com/advisories/suse/suse-2026-23070-1-libkrun , https://tracker.security.nixos.org/suggestions/by-package/libkrun?page=1
- crun: CVE-2026-84042, rootful krun with passt runs the payload as host root. Only a title in an aggregator, not confirmed. [S] https://hol.org/guard/security/cves/CVE-2026-84042-crun-crun-rootful-krun-with-passt-executes
- libkrun issue: krun in 1.17.4 sometimes does not stop short-lived containers. No date. [P] https://upd.dev/containers/libkrun/issues/554

### Docker Sandboxes (sbx)
- `sbx login` is required; Docker justifies it by verified identity and governance; sbx collects telemetry (command, success, duration, Docker username), disabled with `SBX_NO_TELEMETRY=1`. Docker Desktop is not needed. Local sandboxes run in a microVM. No date. [P] https://docs.docker.com/ai/sandboxes/faq.md , https://docs.docker.com/ai/sandboxes.md
- The documentation does not describe Compose, an own daemon inside, or nested KVM (neither the FAQ nor the main page addresses it). [P] same
- A comment in the AUR: libkrun replaced by "libsailor" in the latest sbx version (single source, not confirmed). [S] https://aur.archlinux.org/packages/docker-sbx

### Sysbox
- Community project "not officially supported by Docker", best-effort support, Docker is the main sponsor since the acquisition of Nestybox in May 2022, Enterprise edition [DEPRECATED], Apache-2.0. No date. [P] https://github.com/nestybox/sysbox
- AUR lists sysbox-ce 0.7.0-1 updated 2026-06-05 (not confirmed on GitHub). The sysbox-external repo was archived 2025-08-07. [S] https://aur.archlinux.org/packages/sysbox-ce?O=0

### Daytona
- The daytonaio/daytona repo was archived by the owner 2026-10-03, "no longer maintained", core development moved to private code since June 2026; the code remains freely usable "as is". I did not confirm the license (aggregators say AGPL-3.0, an old blog Apache-2.0). [P] https://github.com/daytonaio/daytona/blob/main/README.md
- Note: available as a verified page only through WebFetch; the search found no confirmation.

### NVIDIA OpenShell
- Version 0.1.x, Apache-2.0, requires Docker/Podman/host virtualization or Kubernetes (Helm); docker-in-sandbox and privileged are not mentioned in the README. No date. [P] https://github.com/NVIDIA/OpenShell
- Gateway as a Docker Compose service; sandboxes are Docker containers with a "supervisor"; on Linux `extra_hosts` is needed for host.openshell.internal; a user reports that Docker Engine 28+ worked and snap 29.8.0 did not; docker group = root on the host. No date. [P/S] https://docs.nvidia.com/openshell/get-started/tutorials/docker-compose.md , https://github.com/NVIDIA/OpenShell/pull/1321/files
- I found no issue about docker-in-docker/privileged.

### BoxLite
- Apache-2.0, KVM on Linux, no daemon, ~2.6k stars, 205 open issues; version on docs.rs 0.9.5 (pre-1.0); company not named; nested Docker not mentioned in the documentation. No date. [P] https://github.com/boxlite-ai/boxlite , https://docs.rs/crate/boxlite/latest

### OpenSandbox (Alibaba)
- Apache-2.0, ~16.4k stars, an Agentic AI Foundation project, Firecracker runtime with a declared 64 ms P50 (own measurement, marketing), pause/resume; docker-in-sandbox not mentioned. No date. [P/M] https://github.com/alibaba/OpenSandbox

### Kubernetes agent-sandbox (SIG Apps)
- CRDs Sandbox/SandboxWarmPool/SandboxClaim, runtime via RuntimeClass (gVisor, Kata), examples use the API `v1beta1`; deep hibernation and efficient persistence are only goals; snapshots are not a finished feature; uninstalling the CRDs deletes all CRs. No date. [P] https://github.com/kubernetes-sigs/agent-sandbox

### Kata Containers
- Real experience: Docker-in-Docker in Kata required "five attempts" until the first build (encircle360 blog, no date, [S]) https://encircle360.com/en/blog/ci-runners-kata-containers-microvm ; GitLab issue Kata+Firecracker "failed to get reader from content store" (no date, resolution unknown) https://gitlab.com/gitlab-com/gl-infra/production-engineering/-/issues/27645 ; Kata on cloud VMs requires nested virtualization. [S] https://northflank.com/blog/what-are-kata-containers

### Docker in other hosted sandboxes (comparison, vendor docs [M])
- Freestyle (Docker + Compose in a microVM snapshot) https://www.freestyle.sh/docs/guides/run-docker-in-a-sandbox ; Blaxel https://docs.blaxel.ai/Tutorials/Docker ; Beam https://docs.beam.cloud/v2/sandbox/docker.md ; OpenHands Enterprise https://docs.openhands.dev/enterprise/docker-in-sandbox.md ; Cloudflare Sandbox SDK has its own guide and limits. These are vendor docs, not operational experience.

## Table

| Project | Maturity | Production use (documented) | Main risks | Docker/Compose inside |
|---|---|---|---|---|
| Microsandbox | beta, breaking changes (v0.6 to v0.7) | not found | pre-1.0, small team, no independent postmortem | yes, officially dind in a microVM, no privileged in the guide |
| E2B (infra/Embed) | OSS Apache-2.0, Embed unclear (roadmap vs. README) | vendor claims, independent not found | heavy stack (PG, Redis, ClickHouse), unverified auth | Firecracker VM, Docker inside not found |
| gVisor | mature (Google), active CVEs | widely, but not documented here | CVE-2026-95702 (sentry), Docker without iptables, `--cap-add all`, DNS in Compose | limited, only host/bridge, no iptables |
| Firecracker | mature (AWS) | AWS Lambda/Fargate [M] | CVE-2026-1386 jailer, 2026-5747 virtio | as a VM yes, it is your rootfs |
| Kata | mature | not documented here | DinD tuning, nested virt, snapshots not found | yes with tuning |
| libkrun | pre-1.0 library | underlying layer of microsandbox/podman krun | occasional failure to stop a container, CVE-2026-5674 unverified | depends on the layer above |
| Docker sbx | Docker Inc. product, requires an account | not found | login + telemetry, closed | undocumented |
| Sysbox | community, Docker sponsor, "best effort" | not found here | shared kernel (not a VM), unclear future | yes (main purpose), no privileged |
| Daytona | repo archived 2026-10-03, development private | - | abandonment of OSS | cannot be recommended for self-host |
| OpenShell | 0.1.x | not found | very young, Docker group = root | undocumented |
| BoxLite | pre-1.0 (0.9.x) | not found | 205 open issues, unclear owner | undocumented |
| OpenSandbox | active, AAIF foundation | not found independently | benchmarks are vendor | undocumented |
| agent-sandbox (K8s) | v1beta1 API, SIG | not found | needs K8s, isolation depends on runtime | depends on runtime |

## Hypothesis vs. findings
- "Microsandbox handled Compose without privileged": supported by the official documentation (dind in a microVM, a Compose test), but the documentation itself says nothing about privileged. Independent confirmation is missing.
- "gVisor only with privileged and without iptables": partial disagreement. The documentation wants `--cap-add all` plus runsc flags; iptables really are disabled. Docker 28/29 need extra flags.
- "E2B Embed heavy stack": confirmed by the component list. "Unauthenticated gRPC": not found.
- "sbx requires a Docker account": confirmed (`sbx login`).
- "OpenShell and BoxLite do not handle Compose": not found in either direction; the documentation does not address it.

## Recommendation (one physical machine, nested KVM)
1. Default choice for Docker/Compose with dozens of services: a microVM with its own kernel and an inner dockerd (Microsandbox or your own Firecracker/Cloud Hypervisor VM), not privileged DinD on the host. This is derived from documentation, not independent measurement; before deployment, measure I/O and the start of dozens of services.
2. Speed: a pre-built image/snapshot with Docker images loaded (Microsandbox warm workers/snapshots, Freestyle docs similarly); independent benchmarks not found.
3. Avoid: Daytona (archived), shared kernel + privileged DinD (runc CVEs from 2025-11), gVisor for large Compose (iptables, DNS).
4. Keep patching Firecracker (1.14.1+/1.13.2+), gVisor (20260831.0+), runc (1.2.8/1.3.3/1.4.0+).
5. Operations: plan for disk cleanup (Docker data disappears with the sandbox, otherwise it grows), verify nested virt performance and snapshot/restore behavior with your own test.

## Not found (I am not guessing)
- Hacker News, Reddit, postmortems and independent benchmarks for all projects: the search engine returned no relevant thread.
- Modal, Fly Machines, Coder, Devcontainers, Kata snapshot/restore, libkrun CVE-2026-5674 description, E2B gRPC auth, OpenShell/BoxLite Docker inside, sbx Compose and nested KVM, Sysbox latest release: not verified.
- Publication dates of most documentation pages.
