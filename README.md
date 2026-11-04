# 2026-agent-sandbox

Research and prototypes for running **coding agents in isolated sandboxes**: a
request (an issue or a prompt) goes in, an agent works inside a microVM with no
real credentials, and the result comes out as a pull request that a human
reviews.

The work happened on one Linux host with nested KVM between 2026-11-01 and 2026-11-04. It is kept here so others can reuse
the findings and, if they want, run the code again. The runtime scorecard is
[below](#runtimes). Web reading and session logs are in [`research/`](research/).

## Contents

| Folder | What it is | State |
|---|---|---|
| [`research/`](research/) | Web reading from 2026-11-01, session logs, and the notes of runtimes that were deleted | reference |
| [`01-factory-poc/`](01-factory-poc/) | First PoC: Forgejo issue → sandbox → agent → PR, with one adapter per runtime (runc, gVisor, Microsandbox, Docker Sandboxes, E2B) and a security suite | archived, worked end to end |
| [`02-yfactory/`](02-yfactory/) | The product that grew out of the PoC: orchestrator, Microsandbox service, opencode in the VM, review and revise, UI, and the deployment (`infra/`) | working prototype |

## The short version

- **Runtime:** [Microsandbox](https://github.com/microsandbox/microsandbox)
  (libkrun microVM) was the only runtime with every key property: microVM,
  default-deny egress, credentials outside the sandbox, Docker Compose inside
  without `privileged`, no account. It is beta. Docker Sandboxes (`sbx`) and
  E2B were the runners-up; six others were tried and dropped.
- **Credentials:** the sandbox gets only a per-run virtual LiteLLM key (or
  just a run token that the orchestrator swaps for it) and a run token for
  its own git branch. Real Git and LLM credentials never enter the VM.
- **Git:** the agent pushes only to a branch the orchestrator owns (a staging
  repo in the PoC, a per-run repo in yfactory). Every commit is checked, and
  only then does the orchestrator push to the origin and open the PR. The
  check rejects `.git`, `.github`, `.gitea`, `.forgejo`, `.gitmodules`,
  `.gitattributes`, symlinks, submodules and merge commits, and more than 200
  commits. yfactory also rejects `.gitlab-ci.yml`. `.gitignore` is allowed.
- **Egress:** default-deny; the VM reaches only the orchestrator's task API
  (LLM routes, its own git repo) and a package proxy with a domain allowlist.
- **Security suite:** `tests/security.ts` (PoC) and
  `02-yfactory/tests/security.ts` probe isolation from inside the sandbox;
  results are in the `tests/results/` folders. The last yfactory run passed
  161/161.

## Quick start

Each folder has its own README. In short:

```bash
# yfactory (the current prototype). Needs Docker and /dev/kvm.
cd 02-yfactory
./build.sh dev                     # builds ynfra/yfactory:<service>-dev images
cd infra
cp .env.example .env               # set YF_VERSION=dev, YF_VM_VERSION, YF_BIND, KVM_GID
make init                          # generates secrets/ with random values
$EDITOR secrets/litellm.env        # upstream model provider
$EDITOR secrets/yfactory.env       # GitHub token for your repositories
$EDITOR config/yfactory/*.json     # providers and repositories
make up
```

```bash
# The PoC
cd 01-factory-poc
cp orchestrator/.env.example orchestrator/.env
./up.sh                            # Forgejo, LiteLLM, gateway; generates litellm/.env
FACTORY_ROOT="$PWD" FACTORY_HOME="${HOME}" sudo -E docker compose -f orchestrator/compose.yml up -d --build
```

Addresses in the docs use `<host>` for the machine you run this on;
replace them with your own. Nothing is meant to be exposed to the internet:
there is little or no authentication on the UIs.

## What is not here

- **Secrets.** No `.env` files, keys, tokens or passwords. Every place that
  needs one has a `.env.example` or is generated (`up.sh`, `make init`).
- **Runtime state:** Forgejo data, git mirrors, run history, the Microsandbox
  rootfs, E2B host state, S3 data, Docker images.
- **Backups** of old file versions from the PoC.

Some code comments are in Czech; the docs are in English.

## License

[MIT](LICENSE).

## Runtimes

Where can an untrusted coding agent run so that it can build, test and even
start a Docker Compose stack, while it cannot reach the host, the LAN, other
sandboxes or any real credential?

We tried nine runtimes plus runc and gVisor as controls, on one Linux host with nested KVM, between 2026-11-01 and 2026-11-02. Every
value below was measured there unless the notes say otherwise. Tests ran
concurrently, so performance numbers are indicative, not a benchmark.

The matrix below is the current one. Per-runtime notes for the three that
stayed are in [`01-factory-poc/runtimes/`](01-factory-poc/runtimes/). Notes and
`results.json` for the ones that were deleted are in
[`research/runtimes-archive/`](research/runtimes-archive/), and the matrix from
before that cleanup is
[`research/runtimes-archive/matrix-before-cleanup.md`](research/runtimes-archive/matrix-before-cleanup.md).
The assignment each test followed is
[`01-factory-poc/runtimes/BRIEF.md`](01-factory-poc/runtimes/BRIEF.md).

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

Left unfinished on the dropped runtimes:

- Kata: end-to-end to a PR and credential injection. Two VMs (`kata-fc-cclh0`, `kata-fc-cqemu0`) were still around at the time; `dmsetup` was empty after the cleanup.
- OpenShell: no TypeScript adapter. `openshell-gateway generate-certs` is required before a run. The per-task credential header was checked only against an echo server. A DNS TXT tunnel was not tested.
- BoxLite and OpenSandbox: dockerd inside the sandbox was not tested past Compose 0/15.

### Recommendation

**Microsandbox** is the one runtime with ✅ in every key column: libkrun
microVM, default-deny egress, credentials outside, Compose without
`privileged`, no account, no host daemon, 1.25 s cold start. The risk is that
it is beta. We built [yfactory](02-yfactory/) on it, running `msb` inside an
unprivileged container that only has `/dev/kvm` (no root, no `privileged`, no
Docker socket).

**Docker Sandboxes** is the most complete functionally and a good fallback,
but it is proprietary, needs a signed-in Docker account on the host, has a
14 s cold start and no pause.

**E2B Embed** has the fastest start and full Compose, but no credential
injection, a heavy self-hosted stack (about ten services, hugepages) and
security gaps around DNS and the metadata service.

**gVisor** is the simplest step up from runc when Compose inside is not
needed; with Compose it needs `privileged`.

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
- A virtual, per-task LLM key in the sandbox is acceptable; a real one is not.
  yfactory goes one step further: the key stays in the orchestrator, and the VM
  only has a run token. The sandbox may read comments and CI results through
  the task API, but it never writes to the git host or chat itself: the
  orchestrator does that after checking the result. The exact paths that check
  rejects are listed in each prototype's README.
