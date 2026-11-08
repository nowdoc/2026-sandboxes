# PoC runtimes

Notes, adapters and raw results for the retained runtimes. See the
[comparison](../../README.md#runtimes), [test brief](BRIEF.md) and
[dropped runtime archive](../../research/runtimes-archive/).

| Runtime | Notes | Adapter | Results |
|---|---|---|---|
| Microsandbox 0.7.12 | [Notes](microsandbox/NOTES.md) | [microsandbox.ts](../orchestrator/adapters/microsandbox.ts) | [Measurements](microsandbox/results.json), [security](../tests/results/security-microsandbox.json) |
| Docker Sandboxes 0.50.1 | [Notes](sbx/NOTES.md) | [sbx.ts](../orchestrator/adapters/sbx.ts) | [Measurements](sbx/results.json), [security](../tests/results/security-sbx.json) |
| E2B Embed | [Notes](e2b/NOTES.md); metadata service is a documented exception | [e2b.ts](../orchestrator/adapters/e2b.ts) | [Measurements](e2b/results.json), [security](../tests/results/security-e2b.json) |
| gVisor 20261026 | Compose requires `privileged` | [docker.ts](../orchestrator/adapters/docker.ts) | [Security](../tests/results/security-gvisor.json) |
| runc 1.3.6 | Shared-kernel control | [docker.ts](../orchestrator/adapters/docker.ts) | [Security](../tests/results/security-runc.json) |
