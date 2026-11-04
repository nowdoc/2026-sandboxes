# Runtimes kept in the PoC

The comparison and the recommendation are in
[`../../README.md`](../../README.md#runtimes). This directory only has the three
runtimes that stayed, plus the test assignment [BRIEF.md](BRIEF.md).

gVisor and runc have no directory here. They share
[`../orchestrator/adapters/docker.ts`](../orchestrator/adapters/docker.ts).
Dropped runtimes are in
[`../../research/runtimes-archive/`](../../research/runtimes-archive/).

| Runtime | In the UI | Notes | Adapter | Measured data |
|---|---|---|---|---|
| Microsandbox 0.7.12 | yes | [NOTES](microsandbox/NOTES.md) | [microsandbox.ts](../orchestrator/adapters/microsandbox.ts) | [results.json](microsandbox/results.json), [security](../tests/results/security-microsandbox.json) |
| Docker Sandboxes 0.50.1 | yes | [NOTES](sbx/NOTES.md) | [sbx.ts](../orchestrator/adapters/sbx.ts) | [results.json](sbx/results.json), [security](../tests/results/security-sbx.json) |
| E2B Embed | yes | [NOTES](e2b/NOTES.md). The metadata service answers; the suite treats that as a documented exception | [e2b.ts](../orchestrator/adapters/e2b.ts) | [results.json](e2b/results.json), [security](../tests/results/security-e2b.json) |
| gVisor 20261026 | yes | Compose only with `privileged` | [docker.ts](../orchestrator/adapters/docker.ts) | [security](../tests/results/security-gvisor.json) |
| runc 1.3.6 | yes, as the control | Shared kernel | [docker.ts](../orchestrator/adapters/docker.ts) | [security](../tests/results/security-runc.json) |

Security totals: Microsandbox 54/54, Docker Sandboxes 54/54, E2B 52/52 with the
metadata exception, gVisor and runc 53/53. The numbers are in
[`../tests/results/`](../tests/results/).
