# Runtimes

Comparison of sandbox runtimes for the factory. Each runtime has details in `<name>/NOTES.md` and data in `results.json`. Test assignment: [BRIEF.md](../../01-factory-poc/runtimes/BRIEF.md).

## Conclusion so far
- **Microsandbox:** default-deny, credential injection and Compose without privileged, no account. Beta.
- **Docker Sandboxes:** functionally the most complete, but a Docker account and a 14 s cold start.
- **E2B Embed:** the fastest, but no credential injection and a heavy stack.
- **Kata + Firecracker:** the only microVM where our gateway model (unique IP) works and Compose without privileged works at the same time. Installation is laborious.
- **E2E to PR + iteration + `tests/security.ts`** passed on runc, gVisor, Microsandbox and sbx (in the UI). E2B has E2E and iteration, but security fails (DNS, metadata), hence it is not in the UI.

## Matrix
✅ works · ⚠️ partially, see notes · ❌ does not work · ❓ not tested · ⏳ test running

All values are measured on this machine unless the notes say otherwise.

| Runtime | Version | Status | MicroVM | E2E to PR | Default-deny | Credentials outside the sandbox | LLM gateway | Packages via proxy | Compose (of 15) | Compose without privileged | Isolation of 2 sandboxes | Pause / snapshot | No account |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Microsandbox | 0.7.12 | ✅ beta | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ 15 | ✅ | ✅ | ✅ / ✅ | ✅ |
| gVisor | 20261026 | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ 15 | ❌ | ✅ | ❓ / ❓ | ✅ |
| OpenShell | 0.1.6 | ⚠️ | ✅ | ❓ | ✅ | ✅ | ✅ | ✅ | ❌ 0 | ❌ | ✅ | ❌ / ❌ | ✅ |
| OpenSandbox | server 2026-11 | ⚠️ | ❌ | ❓ | ⚠️ | ✅ | ⚠️ | ✅ | ❌ 0 | ❌ | ✅ | ✅ / ❌ | ✅ |
| BoxLite | 0.11.0 | ⚠️ | ✅ | ❓ | ⚠️ | ⚠️ | ❌ | ✅ | ❌ 0 | ❌ | ✅ | ❓ / ⚠️ | ✅ |
| E2B Embed | main | ⚠️ | ✅ | ✅ | ⚠️ | ❌ | ✅ | ✅ | ✅ 15 | ✅ | ⚠️ | ✅ / ❓ | ✅ |
| Docker Sandboxes | 0.50.1 | ⚠️ account | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 15 | ✅ | ✅ | ❌ / ✅ | ❌ |
| Kata + Firecracker | 4.3.1 / FC 1.17.0 | ⚠️ | ✅ | ❓ | ✅ | ❓ | ⚠️ | ✅ | ⚠️ 15 | ✅ | ✅ | ✅ / ❌ | ✅ |
| firecracker-containerd | be68640 | ⚠️ | ✅ | ❓ | ⚠️ | ❌ | ⚠️ | ❌ | ⚠️ 15 | ❌ | ❌ | ✅ / ❌ | ✅ |
| runc (control) | 1.3.6 | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ❓ | ❓ | ✅ | ❓ / ❓ | ✅ |
| Superserve | – | ❌ dropped | – | ❌ | ❓ | ❓ | ❓ | ❓ | ❓ | ❓ | ❓ | ❓ | ❌ |

"Default-deny" and "Credentials outside the sandbox" are provided for gVisor and runc by our gateway and the per-task network, not by the runtime.

### Performance and ops
| Runtime | Cold start (median) | Idle RAM per sandbox | Compose healthy in | Daemons on the host | Ops complexity |
|---|---|---|---|---|---|
| Microsandbox | 1.25 s | 221 MB | 10 s | 0 | low |
| gVisor | ❓ | ❓ | 13 s | 0 beyond Docker | low, change to `daemon.json` |
| OpenShell, Docker driver | 1.30–1.70 s | 25 MB + gateway 290 MB | – | 1 | low |
| OpenShell, microVM | 2.24 s with cache, 6.06 s without | 140 MB + gateway 290 MB | – | 1 | low |
| OpenSandbox | 3.73 s | 16 MB + server 174 MB | – | 1 + a sidecar per sandbox | medium |
| BoxLite | 2.41 s | 254 MB | – | 0 | low |
| E2B Embed | 0.17 s | 170 MB + stack 5 GiB + hugepages 2 GiB | 13 s | about 10 services | high |
| Docker Sandboxes | 14 s | 1.15 GB | 19 s including pull | 1 | low, but account-dependent |
| Kata + Firecracker | 2.05 s | 260 MB | 9 s after dockerd start | 1 (containerd) | medium to high |
| firecracker-containerd | 6.2 s | 180 MB | 20 s | 1 | high, own build |

The numbers are indicative: the tests ran concurrently and each agent measured separately. This is not yet a comparable benchmark; that is in the list below.

The LLM gateway column was re-measured for Microsandbox, sbx and E2B with a virtual key in the sandbox (a shared source IP does not matter). sbx and E2B reach the gateway via `198.18.0.10:4000/4001` (an alias on `lo`, see [gateway/compose.yml](../../01-factory-poc/gateway/compose.yml)), Microsandbox directly to the nginx IP in `factory-core`.

The security suite `tests/security.ts` (53 checks on runc and gVisor, 54 on the others) ran on runc, gVisor, Microsandbox (54/54), sbx (54/54) and E2B (51/54). Runtimes with a TS adapter have exceptions described in their NOTES. The numbers are indicative, the tests ran concurrently.

## Overview
| Runtime | Verdict | Links |
|---|---|---|
| Microsandbox | In the UI. Default-deny, E2E and security 54/54. Beta, rootfs from `docker export` | [adapter](../../01-factory-poc/orchestrator/adapters/microsandbox.ts) · [notes](../../01-factory-poc/runtimes/microsandbox/NOTES.md) · [repo](https://github.com/microsandbox/microsandbox) · [docs](https://docs.microsandbox.dev) |
| Docker Sandboxes | In the UI. E2E and security 54/54, proprietary, requires the host user to be logged in | [adapter](../../01-factory-poc/orchestrator/adapters/sbx.ts) · [notes](../../01-factory-poc/runtimes/sbx/NOTES.md) · [docs](https://docs.docker.com/ai/sandboxes/) · [releases](https://github.com/docker/sbx-releases) |
| E2B Embed | In the UI: E2E and security OK, MMDS as an exception. Heavy stack | [adapter](../../01-factory-poc/orchestrator/adapters/e2b.ts) · [notes](../../01-factory-poc/runtimes/e2b/NOTES.md) · [repo](https://github.com/e2b-dev/runtime) · [docs](https://e2b.dev/docs) |
| gVisor | Simple and in E2E, Compose only with privileged | [docs](https://gvisor.dev/docs/) · [Docker in gVisor](https://gvisor.dev/docs/tutorials/docker-in-gvisor/) · [adapter](../../01-factory-poc/orchestrator/adapters/docker.ts) · [results](../../01-factory-poc/tests/results/security-gvisor.json) |
| OpenShell | Best policy and credentials, Compose deliberately does not work, no switch. Suitable for a stack without Docker inside | [notes](openshell.md) · [repo](https://github.com/nvidia/openshell) |
| OpenSandbox | Credential Vault OK, unsafe defaults, Compose does not work | [notes](opensandbox.md) · [repo](https://github.com/opensandbox-group/OpenSandbox) · [Vault](https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/guides/credential-vault.md) |
| BoxLite | Allow-all default, Compose does not work | [notes](boxlite.md) · [repo](https://github.com/boxlite-ai/boxlite) · [docs](https://docs.boxlite.ai) |
| firecracker-containerd | Poorly maintained, network holes, a lot of manual work | [notes](fc-ctr.md) · [repo](https://github.com/firecracker-microvm/firecracker-containerd) |
| Kata + Firecracker | Strong candidate: unique IP for the key, Compose without privileged. Laborious installation, stdin without EOF | [notes](kata-fc.md) · [repo](https://github.com/kata-containers/kata-containers) · [guide](https://github.com/kata-containers/kata-containers/blob/main/docs/how-to/how-to-use-kata-containers-with-firecracker.md) |
| runc | Control only, shared kernel | [repo](https://github.com/opencontainers/runc) · [results](../../01-factory-poc/tests/results/security-runc.json) |
| Superserve | Dropped, cannot be self-hosted | [notes](superserve.md) · [repo](https://github.com/superserve-ai/superserve) |

Not included, only read: [OpenRuntimes](https://github.com/open-runtimes/executor) (function executor), [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox/concepts) (hosted), Daytona (repo archived), LangSmith (external).
