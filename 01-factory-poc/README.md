# Software Factory PoC

Archived as of November 2, 2026; continued in [yfactory](../02-yfactory/).
A Forgejo issue starts an agent in a sandbox and produces a PR from `factory-bot`.
Real credentials stay outside the sandbox.

## Getting started

Requires Linux, Docker and the dependencies of the selected
[runtime](runtimes/README.md). Keep services on a trusted LAN behind VPN.

Configure Forgejo credentials and webhook settings in `orchestrator/.env`
using [the template](orchestrator/.env.example). For a fresh fixture deployment,
[forgejo/seed.sh](forgejo/seed.sh) creates users, tokens, the repository and this
file after Forgejo starts; it skips seeding if the file already exists.
[up.sh](up.sh) generates `litellm/.env` on first start.

```bash
cd 01-factory-poc
./up.sh
FACTORY_ROOT="$PWD" FACTORY_HOME="${HOME}" sudo -E docker compose -f orchestrator/compose.yml up -d --build
```

`up.sh` needs Docker access and permission to add a loopback IP alias.

1. Create an issue in `factory-admin/fixture` as `factory-admin`.
2. In the UI, select a runtime and click **Implement**, or add the `factory`
   label to trigger the webhook.
3. Follow the PR link posted on the issue. Comment `/factory <instructions>`
   on the PR to request changes.

## Configuration

| Setting | Purpose | Default |
|---|---|---|
| `FACTORY_RUNTIME` | Webhook runtime; UI runs select their own | `gvisor` |
| `FACTORY_MODEL` | LLM model | `GLM-5.3-Flash` |
| `FACTORY_AGENT` | Set to `fake` for scripted tests without an LLM | LLM agent |
| `FACTORY_CLONE_DEPTH` | Git clone depth | `50` |
| `FACTORY_PROJECTS` | Project registry path | `orchestrator/projects.json` |

[orchestrator/projects.json](orchestrator/projects.json) defines providers
(`forgejo` only), the staging server and allowed projects. It references secret
variable names (`tokenEnv`, `adminTokenEnv`, `webhookSecretEnv`), not values, and
is validated at startup. Projects specify `repo`, `provider` and an optional `id`.

Webhooks use `/webhook/<provider id>`; `/webhook` selects the first provider.
Unregistered repositories are ignored. Mirrors live in
`state/mirrors/<provider>/<repo>.git`; staging repositories use
`<provider>__<owner>__<repo>`. Runs are stored in `state/runs.json`, with at most
three concurrent runs and no duplicate run for the same ticket.

## Security

The PoC orchestrator is privileged and mounts the host Docker socket; it is not
isolated from the host. Only users with repository write permission can trigger runs.

| Boundary | Behavior |
|---|---|
| LLM | Per-task virtual LiteLLM key, no budget, deleted after the task; real keys stay in LiteLLM |
| Git | Clone to `/workspace` from a mirror; push to staging through the task API using `TASK_TOKEN`, never a provider token |
| Publishing | Orchestrator checks every commit, pushes with `--force-with-lease` and opens the PR |
| Comments and CI | Task API reads only the task's issue and PR; replies are published by the orchestrator after patch acceptance |
| Egress | Gateway-mediated LLM and package access; see runtime notes for isolation limitations |

The task API is on gateway port `4001`. Its token expires when the task ends or
after two hours. Slack integration is not implemented (`/task/slack` returns 501).

Commit validation rejects `.git`, `.github`, `.gitea`, `.forgejo`, `.gitmodules`,
`.gitattributes`, symlinks, submodules, merge commits and branches with more than
200 commits. `.gitignore` is allowed.

## Services

Replace `<host>` with the deployment address. Secrets are in local `.env` files,
not in git. `factory-bot` uses `FORGEJO_BOT_TOKEN` from `orchestrator/.env`.

| Service | Address | Authentication / configuration |
|---|---|---|
| Forgejo | `http://<host>:3000` | `factory-admin`; `FORGEJO_ADMIN_PASSWORD` in `orchestrator/.env`; [Compose](forgejo/compose.yml) |
| UI | `http://<host>:8088` | No login; [source](orchestrator/yfactory.ts) |
| LiteLLM | `http://<host>:4000/ui` | `LITELLM_MASTER_KEY` in `litellm/.env`; default user `admin` is unverified; [config](litellm/config.yaml) |
| E2B dashboard | `http://<host>:3001` | `E2B_API_KEY` in `runtimes/e2b/state/sdk.env` |
| LLM and package gateways | Task networks; `198.18.0.10:4000/4001/3128` for sbx and E2B | [nginx](gateway/nginx.conf), [allowlist](gateway/allowlist.txt) |
| Orchestrator | Container `factory-orchestrator` | [Compose](orchestrator/compose.yml); `docker logs factory-orchestrator` |

## Tests

```bash
tests/e2e.sh "Task title"
sudo -E node tests/security.ts gvisor
```

Tests require a running deployment. See [security probes](tests/probe.py),
[Compose probe](tests/compose_probe.sh), [runtime brief](runtimes/BRIEF.md) and
[runtime comparison](../README.md#runtimes). Contributor rules are in [AGENTS.md](AGENTS.md).
