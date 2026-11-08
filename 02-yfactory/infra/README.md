# yfactory deployment

Docker Compose deployment for yfactory. This directory is self-contained except
for prebuilt Docker images. Services are for a trusted LAN behind VPN; the UI
has no login. Do not expose them to the public internet.

| Doc | Content |
|---|---|
| [docs/SERVICES.md](docs/SERVICES.md) | each service: purpose, inputs, outputs, ports, what it is not for |
| [docs/ARCH.md](docs/ARCH.md) | architecture and trust boundaries, diagrams |
| [docs/API.md](docs/API.md) | the HTTP API and the management MCP server (`http://<host>:8090/mcp`) |
| [AGENTS.md](AGENTS.md) | conventions for changes here |

## Getting started

Requires Linux, Docker Compose, Make, `/dev/kvm` and sudo access. Load these
images into local Docker before starting:

- `ynfra/yfactory:orchestrator-<version>`
- `ynfra/yfactory:sandbox-<version>`
- `ynfra/yfactory:vm-<vm version>`

From this directory:

```bash
cp .env.example .env
$EDITOR .env
make init
$EDITOR secrets/litellm.env secrets/yfactory.env
$EDITOR config/yfactory/providers.json config/yfactory/opencode.json config/litellm/litellm.yaml
make up
make status
```

Set `YF_VERSION` and `YF_VM_VERSION` to the image versions, `YF_BIND` to the
loopback or trusted LAN address, and `KVM_GID` to the host's KVM group ID
(`getent group kvm | cut -d: -f3`). Configure upstream model credentials,
provider tokens and model names before starting runs. Add repositories and
environments through the UI.

`make init` creates data directories, secrets and the S3 bucket without
overwriting existing secret files. Make wraps `yfactory.sh`; operational targets use sudo.

## Terms
| Term | Means |
|---|---|
| VM | One run's microVM (`yf-<id>`), removed with the run |
| `sandbox` | Service that creates and drives VMs; not a VM itself |
| `vms` | Internal network through which VMs reach allowed services |
| Run | Task with a repository, VM and optional prompt and PR |

## Addresses
Replace `<host>` with `YF_BIND`.

| Service | Container IP | Ports | From the host |
|---|---|---|---|
| `yfactory` UI and API | `10.99.0.10` on `vms`, dynamic on `core`, `control` | `8080` UI, `9001` task API (the only port VMs reach), `8081` VS Code | <http://<host>:8090>, VS Code of a run <http://<host>:8092/><id>/ |
| `sandbox` | `10.99.0.3` on `vms`, dynamic on `control`, `egress` | `7000` API | — |
| `proxy` | `10.99.0.11` on `vms`, dynamic on `core` | `3128` | — |
| `litellm` | dynamic on `core` | `4000` | — |
| `db` | dynamic on `core` | `5432` | — |
| `garage` | dynamic on `core` | `3900` S3, `3901` RPC, `3903` admin | `127.0.0.1:3900` |
| `victorialogs` | dynamic on `monitoring` | `9428` HTTP, `5140/udp` syslog | `127.0.0.1:5140/udp` (Docker daemon sends logs here) |
| `victoriametrics` | dynamic on `monitoring`, `core` | `8428` | — |
| `cadvisor` | dynamic on `monitoring` | `8080` | — (container CPU, memory, uptime in Grafana) |
| `grafana` | dynamic on `monitoring` | `3000` | <http://<host>:8091>, anonymous viewer, Explore → VictoriaLogs or VictoriaMetrics |
| VMs | `10.200.0.0/16` inside `sandbox` | — | `make shell ID=<id>` |

Networks: `core` (services and internet), `control` (internal management),
`vms` (internal VM access), `egress` (msb default route), `monitoring` (logs and metrics).

`make status` reports service health. Logs go to VictoriaLogs with 30-day
retention (`app_name` = container); `docker logs` also works from the local cache.

## Credentials
Stored in `secrets/`, mode 600, owned by the user invoking sudo and never committed.
Do not put secrets in `.env`, `config/` or repository environment settings.

All files are created by `make init`; fill in provider tokens and upstream model
credentials yourself. Keep the generated `LITELLM_MASTER_KEY` identical in both files.

| File | Variables | Used by |
|---|---|---|
| `yfactory.env` | `LITELLM_MASTER_KEY`, provider tokens named by `tokenEnv` | `yfactory` |
| `litellm.env` | `LITELLM_MASTER_KEY`, `OPENAI_API_URL`, `OPENAI_API_KEY` | `litellm` |
| `db.env` | `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `DATABASE_URL` | `db`, `litellm` |
| `s3.env` | `S3_ACCESS_KEY`, `S3_SECRET_KEY` (bucket `yfactory`, region `garage`) | `yfactory` |
| `garage.env` | `GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN` | `garage` |
| `sandbox.env` | `SANDBOX_TOKEN` | `yfactory`, `sandbox` |
| `grafana.env` | `GF_SECURITY_ADMIN_PASSWORD` (user `admin`) | `grafana` |

A VM receives only a run token. The per-run virtual LiteLLM key stays in the
orchestrator; deleting the run revokes access.

GitHub requires a fine-grained PAT scoped to configured repositories: Contents
and Pull requests (read/write), Metadata (read), no Workflows permission.
A missing token prevents runs but does not disable the UI.

For multiple accounts, define one provider per account with a separate `tokenEnv`
in `providers.json`, add each token to `secrets/yfactory.env`, then `make restart`.
Repositories select their account through `provider`.

## Commands
```bash
make up                                   # initialize and start services
make down                                 # stop services
make status
make logs S=<service>
make restart S=<service>                   # recreate after config or secret changes
make deploy V=v2 VM=v1                     # deploy local images; VM is optional
make runs
make new REPO=owner/repo PROMPT="Add a health endpoint"
make new REPO=owner/repo                   # VM only, for the terminal
make shell ID=<id>                         # bash in the VM
make publish ID=<id>                       # run branch -> provider and PR
make rm ID=<id>                            # sessions to S3, delete the VM
```
Deployment keeps the previous image versions for rollback and removes older
yfactory images and the Docker build cache. To roll back, restore the previous
versions in `.env` and run `make up`.

## Working with runs

- Ready runs expose a terminal as `agent`, a read-only `/workspace` file tree and
  VS Code. Open VSX is not allowlisted, so extensions cannot be installed.
- **Repositories → Inspect** proposes settings without a PR, even if setup fails.
  **Runs → Proposal → Apply** validates and saves the selected settings, merges
  environment variables without deleting them, and starts a setup-only verify run.
- Add missing package domains to `config/proxy/allowlist.txt`, then
  `make restart S=proxy`. Domain approvals do not update the allowlist automatically.
- Push inside a VM with `git push origin HEAD:$YF_BRANCH`; other branches are rejected.
- Restarting `yfactory` keeps ready VMs; in-progress runs become failed.
  Restarting `sandbox` stops all VM processes but keeps disks. Terminal access
  boots a VM for a command; opening VS Code starts it again.

## Configuration
Non-secret operator settings live in `config/` and `.env`. UI-managed repositories,
environments and scripts live in `data/yfactory/projects/`; back them up with `data/`.

| File | Content |
|---|---|
| `.env` | Service and VM image versions (`YF_VERSION`, `YF_VM_VERSION`), bind address (`YF_BIND`), KVM group (`KVM_GID`) |
| `config/yfactory/yfactory.json` | `maxRunning`, `runTimeout` (seconds); `make restart` applies it |
| `config/yfactory/providers.json` | Git providers, edited only here (see below) |
| `config/yfactory/opencode.json` | agent config (model, LiteLLM provider, LSP, permissions) copied into each new VM; its LiteLLM models are the models a run may choose and must exist in `config/litellm/litellm.yaml` |
| `data/yfactory/projects/` | `projects.json` (environments, repositories), `environments/<name>/{setup,maintenance}.sh`, `setup/<owner>/<repo>.sh`; written by the UI |
| `config/litellm/litellm.yaml` | models |
| `config/proxy/squid.conf`, `config/proxy/allowlist.txt` | package proxy and its domains |
| `config/garage/garage.toml` | S3 |
| `config/victoriametrics/scrape.yml` | metric targets |
| `config/grafana/` | Grafana data sources and the `yfactory` dashboard |
| `compose.yml`, `services/*.yml` | networks, and one file per service included from `compose.yml` |

| Object | Fields |
|---|---|
| provider (`providers.json`) | `kind` (`github`, `forgejo`, `gitlab`), `url`, `tokenEnv`, optional `user` and `api`. Default user: `x-access-token`, or `oauth2` for GitLab. Token variable: `GITHUB_TOKEN`, `FORGEJO_TOKEN` or `GITLAB_TOKEN`, optionally with `_SUFFIX` |
| environment (UI) | `setup` (root, `/`, before clone), `maintenance` (root, `/workspace`, every run before the agent), `env`. Name: lowercase, digits, dashes. Cannot be deleted while used |
| repository (UI) | `provider`, `environment` (default `default`), `setup` (root, `/workspace`, after clone; empty: `.yfactory/setup.sh` from the repository), `env` (never secrets, the agent sees them), `base` (empty: default branch), `model` and `models` (default and allowed models), `reviewPublish` (`draft` or `auto`; default `draft`, findings wait in the UI) |

Script output goes to S3 at `runs/<id>/setup.log` and is available through the
UI's **Setup log** button. Script failures fail ordinary runs; inspect runs continue.

There is one VM image (Node, Python, PHP, JDK 21, Maven, Composer, LSP servers). VMs download packages only through squid and `allowlist.txt`; LAN, host and containers stay blocked.
