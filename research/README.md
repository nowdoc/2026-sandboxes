# Research

Research and session logs from building the prototypes. See the
[runtime comparison](../README.md#runtimes) and [current prototype](../02-yfactory/).

## Reading

Source reviews dated November 1, 2026; these are not runtime measurements.
Assessments describe the PoC at that time. Current behavior and limitations
are documented in the project READMEs.

| File | Content |
|---|---|
| [factories.md](factories.md) | How other factories work, and a critique of the PoC design as of 2026-11-01 |
| [credentials-egress.md](credentials-egress.md) | Credential proxies, incidents, and a critique of the PoC network design as of 2026-11-01 |
| [sandboxes.md](sandboxes.md) | Vendor docs and advisories |
| [runtimes-tested.md](runtimes-tested.md) | Pointer to the scorecard and to the archive |
| [runtimes-archive/](runtimes-archive/) | Notes and `results.json` of the runtimes deleted from the PoC |

## Session logs

Historical records, not current setup instructions. Keep existing logs unchanged;
add new ones as `<date>-<topic>.md`.

| Note | What it records |
|---|---|
| [2026-11-01-orchestrator-runtimes.md](2026-11-01-orchestrator-runtimes.md) | The PoC orchestrator in TypeScript, the adapters, the security numbers, the shared Microsandbox rootfs, and which runtimes were kept |
| [2026-11-01-provider-staging-registry.md](2026-11-01-provider-staging-registry.md) | Forgejo behind a provider interface, the staging repo, and the project registry |
| [2026-11-02-ynfra-yfactory.md](2026-11-02-ynfra-yfactory.md) | Why yfactory is a new orchestrator, `msb` in an unprivileged container, and the first infra end to end. Image tags in the log are content hashes; `build.sh` now uses `vN` and `vm-vN` |
