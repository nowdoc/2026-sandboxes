# Software Factory PoC

> Archived PoC, status as of 2026-11-02. The product continued in [../02-yfactory/](../02-yfactory/).

Forgejo issue → sandbox → agent on `GLM-5.3-Flash` → PR from `factory-bot`. The sandbox has no real credentials.

## How to use it
1. In Forgejo (<http://<host>:3000>, `factory-admin`) create an issue in `factory-admin/fixture` and describe the change in its body.
2. In Yfactory (<http://<host>:8088>) pick a runtime and click "Implement". If the issue has the `factory` label, it starts on its own via the webhook.
3. Within 10 to 30 s the issue gets a link to the PR. For further changes, comment `/factory <what to change>` in the PR.

The model is set via `FACTORY_MODEL` (default `GLM-5.3-Flash`). `FACTORY_AGENT=fake` runs a scripted agent without an LLM for quick tests. The agent is [orchestrator/agent.py](orchestrator/agent.py): the model uses the tools `run`, `read_file`, `write_file` and `finish`; commit, rebase and push are done by the script.

## Sandbox boundaries
| What | Sandbox | Who does it |
|---|---|---|
| LLM | virtual LiteLLM key per task (`mock`, `GLM-5.3-Flash`, `GLM-5.3`), no budget, deleted after the task | the real keys are held by LiteLLM |
| Git clone | `/workspace` from the mirror in `state/mirrors`, one branch, `--depth 50` (`FACTORY_CLONE_DEPTH`), `origin` = staging | orchestrator, only `fetch` from upstream |
| Git push | the agent pushes to the **staging** repo (`factory-bot/<owner>__<repo>`) via `$TASK_API_URL/git/...`, identity is `TASK_TOKEN`, the staging token is not in the sandbox. Multiple commits, `fetch` and rebase onto `origin/<base>` are allowed | orchestrator: `gitProxy` proxy, syncs the base and head branches from origin to staging before the task |
| Promote to origin | the sandbox has no token and no network path to origin | the orchestrator pulls the branch from staging into a temporary bare repo, checks every commit (`checkCommits`) and pushes with `--force-with-lease`, then the PR |
| Comments, review, CI | `GET $TASK_API_URL/task/comments`, `/task/ci` with `TASK_TOKEN` | the orchestrator reads only the issue and PR of the given task |
| Reply to the PR | `POST /task/reply`, only stores the text | the orchestrator sends it as `factory-bot` after accepting the patch |
| Slack | `GET /task/slack` returns 501, not wired up yet | orchestrator |

The Task API runs on port 4001 of the gateway. The token is valid for a single task and stops working when it ends or after 2 h. Wired up for `runc`, `gvisor`, `microsandbox`, `sbx` and `e2b`.

Only a user with `write` permission can trigger it. Every commit on the branch is checked: it must not touch `.git`, `.github`, `.gitea`, `.forgejo`, `.gitmodules` or `.gitattributes`, and it must not add a symlink, a submodule or a merge commit. At most 200 commits. `.gitignore` is allowed. Iteration: a `/factory ...` comment in the PR.

## Project registry
[orchestrator/projects.json](orchestrator/projects.json) defines which repos the factory may work with and as which user. It contains no tokens, only the names of variables from `orchestrator/.env` (`tokenEnv`, `adminTokenEnv`, `webhookSecretEnv`). The file is validated at startup and an error carries only the variable name, never the value.

- `providers`: id → `kind` (only `forgejo` so far), `url`, `user` (the factory user in that system), `label` (optional, default `factory`)
- `staging`: the git server between the sandbox and origin
- `projects`: `repo`, `provider`, optionally `id` (default is `repo`; the UI and runs show `id`)

Webhook: `/webhook/<provider id>`, the bare `/webhook` belongs to the first provider in the file. A repo that is not in the registry is ignored. Any other path returns 404. Mirrors are in `state/mirrors/<provider>/<repo>.git`, the staging repo is named `<provider>__<owner>__<repo>`. The path to the file can be changed via `FACTORY_PROJECTS`.

| Where | What |
|---|---|
| [../README.md](../README.md#runtimes) | runtime scorecard |
| [runtimes/README.md](runtimes/README.md) | the runtimes that stayed, with links to their notes |
| [../research/README.md](../research/README.md) | web reading and session logs |
| [AGENTS.md](AGENTS.md) | rules and commands for agents |

## Services
| Service | Address | Links |
|---|---|---|
| Forgejo | <http://<host>:3000> | [compose](forgejo/compose.yml) · [documentation](https://forgejo.org/docs/latest/) |
| LiteLLM | <http://<host>:4000> | [compose](litellm/compose.yml) · [config](litellm/config.yaml) · [documentation](https://docs.litellm.ai/) |
| Gateway LLM and packages | task networks, nginx and squid additionally on `198.18.0.10:4000/4001/3128` (alias on `lo` from `up.sh`, for sbx and E2B) | [compose](gateway/compose.yml) · [nginx](gateway/nginx.conf) · [allowlist](gateway/allowlist.txt) |
| Orchestrator and Yfactory | container `factory-orchestrator` (Node 24, TypeScript without a build step), `docker logs factory-orchestrator` | [compose](orchestrator/compose.yml) · [factory.ts](orchestrator/factory.ts) · [adapters](orchestrator/adapters/) |
| Yfactory UI | <http://<host>:8088> | [yfactory.ts](orchestrator/yfactory.ts) · [ui](orchestrator/ui/) |

## Logins
Credentials are set in `orchestrator/.env` (see `orchestrator/.env.example`) and the other `.env` files named below.

| Service | Address | User | Password |
|---|---|---|---|
| Yfactory | <http://<host>:8088> | no login | – |
| Forgejo | <http://<host>:3000> | `factory-admin` | `FORGEJO_ADMIN_PASSWORD` in `orchestrator/.env` |
| E2B dashboard | <http://<host>:3001> | – | `E2B_API_KEY` in `runtimes/e2b/state/sdk.env` |
| LiteLLM UI | <http://<host>:4000/ui> | `admin` (LiteLLM default, unverified) | `LITELLM_MASTER_KEY` in `litellm/.env` |

Forgejo `factory-bot` is the orchestrator's service account and uses the token `FORGEJO_BOT_TOKEN`. `litellm/.env` has to be read via `sudo`.

Yfactory: tickets from `factory-admin/fixture`, an "Implement" button with a runtime choice (`runc`, `gvisor`, `microsandbox`, `sbx`, `e2b`), a list of implementations from `state/runs.json`. Max 3 runs in parallel, the others wait in the `queued` state; the same ticket cannot be started twice. The webhook and the UI take the same path, the runtime for the webhook is determined by `FACTORY_RUNTIME`.

Tests: [security.ts](tests/security.ts) · [probe.py](tests/probe.py) · [e2e.sh](tests/e2e.sh) · [compose_probe.sh](tests/compose_probe.sh) · [runtime brief](runtimes/BRIEF.md)
