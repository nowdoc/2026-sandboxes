# Agent sandbox experiments

Research and prototypes for running coding agents in isolated environments and
publishing their changes as pull requests. Real Git and LLM credentials stay
outside the agent's environment.

Tested on one Linux host with nested KVM, November 1–4, 2026. The current
prototype, yfactory, uses Microsandbox (libkrun microVMs).

## Contents

| Directory | Purpose | Status |
|---|---|---|
| [`02-yfactory/`](02-yfactory/) | Prompt → microVM agent → pull request; UI, review and deployment | Working prototype |
| [`01-factory-poc/`](01-factory-poc/) | Forgejo issue → agent → pull request; runtime adapters and security tests | Archived PoC |
| [`research/`](research/) | Research, session logs and archived runtime results | Reference |

## Getting started

Follow the [yfactory README](02-yfactory/README.md) for build instructions and
the [deployment README](02-yfactory/infra/README.md) for setup and operations.
The [PoC README](01-factory-poc/README.md) documents the archived implementation.

Services are for a trusted LAN behind VPN, not the public internet. The yfactory
UI has no login. Replace `<host>` in examples with your host address.

Secrets, runtime data and Docker images are not included. Configuration templates
and initialization scripts are provided in each project.

## Runtimes

Nine runtimes plus runc and gVisor controls were evaluated November 1–2, 2026.
The goal was to build, test and run Docker Compose without access to the host,
LAN, other sandboxes or real credentials. Results are measured unless marked
otherwise; concurrent tests make performance numbers indicative, not benchmarks.

See the [test brief](01-factory-poc/runtimes/BRIEF.md),
[retained runtime notes](01-factory-poc/runtimes/README.md) and
[archive](research/runtimes-archive/) for details, raw results and the
[original matrix](research/runtimes-archive/matrix-before-cleanup.md).

### Criteria

- **microVM:** own kernel, not a shared-kernel container
- **E2E to PR:** issue → agent in the sandbox → pull request, through our orchestrator
- **Default-deny egress** and **credentials outside the sandbox**
- **LLM gateway:** the sandbox reaches the model only through our gateway with a per-task virtual key
- **Packages via proxy:** npm/pip/apt through an allowlisting proxy
- **Compose inside without `privileged`:** a 15-service fixture stack ([`01-factory-poc/fixture/compose.yml`](01-factory-poc/fixture/compose.yml))
- **Isolation between two sandboxes**, **pause / snapshot**, **no external account**

### Matrix

✅ works · ⚠️ partly, see notes · ❌ does not work · ❓ untested

| Runtime | Version | microVM | E2E to PR | Default-deny | Creds outside | LLM gateway | Pkg proxy | Compose (of 15) | Compose w/o privileged | 2-sandbox isolation | Pause / snapshot | No account |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Microsandbox** | 0.7.12 (beta) | ✅ libkrun | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ 15 | ✅ | ✅ | ✅ / ✅ | ✅ |
| Docker Sandboxes (`sbx`) | 0.50.1 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ 15 | ✅ | ✅ | ❌ / ✅ | ❌ |
| E2B Embed | main | ✅ Firecracker | ✅ | ⚠️ | ❌ | ✅ | ✅ | ✅ 15 | ✅ | ⚠️ | ✅ / ❓ | ✅ |
| gVisor (control) | 20261026 | ❌ | ✅ | ✅¹ | ✅¹ | ✅ | ✅ | ⚠️ 15 | ❌ | ✅ | ❓ / ❓ | ✅ |
| runc (control) | 1.3.6 | ❌ | ✅ | ✅¹ | ✅¹ | ✅ | ✅ | ❓ | ❓ | ✅ | ❓ / ❓ | ✅ |

¹ provided by our gateway and a per-task Docker network, not by the runtime.

### Performance and operations

| Runtime | Cold start (median) | Idle RAM per sandbox | Compose healthy in | Host daemons | Ops |
|---|---|---|---|---|---|
| Microsandbox | 1.25 s | 221 MB | 10 s | 0 | low |
| gVisor | ❓ | ❓ | 13 s | 0 beyond Docker | low, `daemon.json` change |
| E2B Embed | 0.17 s | 170 MB + 5 GiB stack + 2 GiB hugepages | 13 s | ~10 services | high |
| Docker Sandboxes | 14 s | 1.15 GB | 19 s incl. pull | 1 | low, but tied to a Docker account |

### Security suite

[`01-factory-poc/tests/security.ts`](01-factory-poc/tests/security.ts) runs
probes from inside a sandbox: host and LAN ports, other sandboxes, cloud
metadata, DNS, the gateway without a key, the git server without a token, and
more. Results are in [`01-factory-poc/tests/results/`](01-factory-poc/tests/results/).

| Runtime | Result |
|---|---|
| Microsandbox | 54/54 |
| Docker Sandboxes | 54/54 |
| E2B Embed | 51/54 on the first run (DNS, metadata); 52/52 after the TS adapter, with MMDS as a documented exception ([notes](01-factory-poc/runtimes/e2b/NOTES.md)) |
| gVisor, runc | 53/53 |
| open container (negative control) | fails, as it should |

The yfactory deployment has its own, larger suite
([`02-yfactory/tests/security.ts`](02-yfactory/tests/security.ts)): 161/161
against v28.

### Tried and dropped

| Runtime | Version | Main reason |
|---|---|---|
| OpenShell (NVIDIA) | 0.1.6 | Best policy and credential injection (placeholder, endpoint binding, L7), but Compose 0/15 by design: non-root workload, no capabilities, seccomp blocks user namespaces. Source-IP identity does not work, no suspend/snapshot. |
| Kata + Firecracker | 4.3.1 / FC 1.17.0 | Technically strong (unique IP, Compose without privileged, 2.05 s start), but laborious install, hanging VMs and a devmapper pool to babysit. |
| firecracker-containerd | be68640 | Poorly maintained, network holes, no credential injection, own build. |
| OpenSandbox (Alibaba) | 2026-11 | Not a microVM, unsafe defaults, Compose 0/15. |
| BoxLite | 0.11.0 | Allow-all default, no LLM gateway, Compose 0/15. |
| Superserve | – | Cannot be self-hosted. |

Read about but not run: OpenRuntimes executor, Vercel Sandbox (hosted only),
Daytona (repository archived), LangSmith (external).

Incomplete tests and setup caveats are recorded in the runtime archive.

### Recommendation

**Microsandbox** met the core requirements and was chosen for yfactory, but is
beta. **Docker Sandboxes** is a fallback if a proprietary runtime and Docker
account are acceptable. **E2B Embed** starts fastest but has a heavy deployment
and documented security gaps. **gVisor** is a simpler option when Docker Compose
inside the sandbox is not needed.

### Lessons that hold across runtimes

- "Docker driver" (OpenShell) means the sandbox runs *on* Docker, not that
  Docker runs *inside* it.
- Compose inside a sandbox needs root and user namespaces. Runtimes that forbid
  them on purpose cannot run it, not even with configuration.
- Isolation is mostly a network question: the gateway, a per-task network and
  default-deny egress did more than the runtime itself. The biggest holes we
  found were the host reachable through the bridge IP (fixed with
  `inhibit_ipv4`) and a writable rootfs shared between Microsandbox tasks
  (fixed with a per-task copy).
- Keep provider credentials outside the agent's environment and validate every
  commit before publishing. See the [PoC boundaries](01-factory-poc/README.md#security)
  and [yfactory trust model](02-yfactory/infra/docs/ARCH.md) for implementation details.

## License

[MIT](LICENSE).
