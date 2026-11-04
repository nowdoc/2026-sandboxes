# Research

Web reading and the session logs from building the prototypes. The runtime
scorecard is in [`../README.md`](../README.md#runtimes). What the product does
now is [`../02-yfactory/`](../02-yfactory/).

## Reading

Dated 2026-11-01. Nothing in these files was installed for the sake of the
reading; the measurements are in the scorecard.

| File | What it is |
|---|---|
| [factories.md](factories.md) | How other factories work, and a critique of the PoC design as of 2026-11-01 |
| [credentials-egress.md](credentials-egress.md) | Credential proxies, incidents, and a critique of the PoC network design as of 2026-11-01 |
| [sandboxes.md](sandboxes.md) | Vendor docs and advisories |
| [runtimes-tested.md](runtimes-tested.md) | Pointer to the scorecard and to the archive |
| [runtimes-archive/](runtimes-archive/) | Notes and `results.json` of the runtimes deleted from the PoC |

### What those critiques asked for

Sections titled "assessment" judge the PoC of 2026-11-01. yfactory later did
some of it.

| Asked for | Where it stands |
|---|---|
| Credentials and the push stay outside the VM | Done in both. yfactory also keeps the LiteLLM key in the orchestrator and swaps it in on the task API |
| A per-task virtual LLM key | Done in both |
| Orchestrator is not root and has no Docker socket | Done in yfactory (uid 1000). The PoC orchestrator is privileged and mounts the socket |
| Pin the LiteLLM image | Done in yfactory (`ghcr.io/berriai/litellm:v1.106.6`) |
| Reject CI, git metadata, symlinks and submodules before publish | Done. The exact paths are in each prototype's README |
| Setup instructions in the repo | Done in yfactory: environment and repository scripts, and an inspect run that proposes them |
| Check who may trigger a run | yfactory has no webhook; a run starts from the UI, CLI or MCP on the LAN. The PoC webhook is unchanged |
| Validate the result outside the VM | Not built |
| A budget on the virtual key | Not built. yfactory leaves LiteLLM budgets off on purpose |
| The bot cannot approve or merge | Not checked by the orchestrator. The documented token is Contents and Pull requests |
| Logs you can look at after the run | Sessions and `setup.log` in S3, metrics in Grafana. No merge-rate number |

## Session logs

What was tried on a given day. A later decision can supersede a log; the log
stays. New logs go here as `<date>-<topic>.md`.

| Note | What it records |
|---|---|
| [2026-11-01-orchestrator-runtimes.md](2026-11-01-orchestrator-runtimes.md) | The PoC orchestrator in TypeScript, the adapters, the security numbers, the shared Microsandbox rootfs, and which runtimes were kept |
| [2026-11-01-provider-staging-registry.md](2026-11-01-provider-staging-registry.md) | Forgejo behind a provider interface, the staging repo, and the project registry |
| [2026-11-02-ynfra-yfactory.md](2026-11-02-ynfra-yfactory.md) | Why yfactory is a new orchestrator, `msb` in an unprivileged container, and the first infra end to end. Image tags in the log are content hashes; `build.sh` now uses `vN` and `vm-vN` |
