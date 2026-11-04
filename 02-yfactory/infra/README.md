# ynfra

Test lab running yfactory: a prompt against a configured repository runs opencode in a microVM and comes back as a branch and a pull request. This directory has everything except the Docker images.

| Doc | Content |
|---|---|
| [docs/SERVICES.md](docs/SERVICES.md) | each service: purpose, inputs, outputs, ports, what it is not for |
| [docs/ARCH.md](docs/ARCH.md) | architecture and trust boundaries, diagrams |
| [docs/API.md](docs/API.md) | the HTTP API and the management MCP server (`http://<host>:8090/mcp`) |
| [AGENTS.md](AGENTS.md) | conventions for changes here |

## Terms
| Term | Means |
|---|---|
| VM | the microVM of one run (`yf-<id>`): agent, `/workspace`, terminal, VS Code. One VM per run, removed with the run |
| `sandbox` | only the service (container) that creates and drives VMs; it has `/dev/kvm` and no credentials. It is never a word for a VM |
| `vms` network | the internal network `10.99.0.0/24` the VMs leave through |
| run | one task: prompt, repository, VM, branch, pull request |

## Addresses
Host `<host>`, LAN behind VPN only, no login.

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

Networks: `core` (services and internet), `control` (internal), `vms` `10.99.0.0/24` (internal, the only one VMs reach), `egress` (default route for msb), `monitoring` (VictoriaLogs, VictoriaMetrics, Grafana, cAdvisor). This table is the one place for addresses and ports.

Every service has a `healthcheck`; `make status` shows `healthy`. Every container logs through the Docker `syslog` driver to VictoriaLogs (30 days, field `app_name` = container); `docker logs` still works from the daemon's local cache.

## Credentials
All in `secrets/`, root only, never committed. Read a value with `sudo cat secrets/<file>`.

| File | Variables | Used by | Created by |
|---|---|---|---|
| `yfactory.env` | `LITELLM_MASTER_KEY`, one token per provider named by its `tokenEnv`: e.g. `GITHUB_TOKEN_EXAMPLE`, `GITHUB_TOKEN_ACME` | `yfactory` | `make init` (tokens: you) |
| `litellm.env` | `LITELLM_MASTER_KEY` (same value as in `yfactory.env`), `OPENAI_API_URL`, `OPENAI_API_KEY` | `litellm` | `make init` (upstream: you) |
| `db.env` | `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `DATABASE_URL` | `db`, `litellm` | `make init` |
| `s3.env` | `S3_ACCESS_KEY`, `S3_SECRET_KEY` (bucket `yfactory`, region `garage`) | `yfactory` | `make init` |
| `garage.env` | `GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN` | `garage` | `make init` |
| `sandbox.env` | `SANDBOX_TOKEN` | `yfactory`, `sandbox` | `make init` |
| `grafana.env` | `GF_SECURITY_ADMIN_PASSWORD` (user `admin`) | `grafana` | `make init` |

A VM gets only a run token and a virtual LiteLLM key, both revoked when the run is deleted.

GitHub token: fine-grained PAT for the configured repositories with Contents (read/write), Pull requests (read/write) and Metadata (read). Without Workflows, GitHub itself rejects changes to `.github/workflows`. Without the token the UI works but runs are refused.

Several GitHub accounts or organisations: one provider per account in `providers.json`, each with its own `tokenEnv`, the token in `secrets/yfactory.env`, then `make restart`. A repository picks its account through `provider`.

```bash
sudo sh -c 'echo GITHUB_TOKEN_ACME=github_pat_... >> secrets/yfactory.env'
```

## Commands
```bash
make up                                    # first start: secrets, S3 bucket, all services
make status
make logs S=<service>
make restart S=<service>                   # recreate after editing config/ or secrets/; VMs survive a yfactory restart
make deploy V=<version> [VM=<vm version>]  # v1, v2, ...; images ynfra/yfactory:<service>-<version> and vm-<vm version> must be in the local Docker; the previous version stays for a rollback, older ones and the build cache are removed
make runs
make new REPO=owner/repo PROMPT="Add a health endpoint"
make new REPO=owner/repo                   # VM only, for the terminal
make shell ID=<id>                         # bash in the VM
make publish ID=<id>                       # run branch -> provider and PR
make rm ID=<id>                            # sessions to S3, delete the VM
```
In the UI a ready run has Terminal, Files and VS Code buttons (shell as `agent`, read-only tree of `/workspace`, code-server in the VM opened in a new tab on `:8092`); the terminal size is fixed when it opens. Extensions cannot be installed (Open VSX is not in the allowlist).

Inspect environment: Repositories → Inspect starts a run without a PR. Setup scripts that fail do not stop it; the agent reads `setup.log` and the project (manifests, CI, `.devcontainer`), tries install, build and test as `agent`, and writes a proposal. Runs → Proposal shows current and proposed repository and environment settings side by side; Apply saves one part through the normal validation (`env` is merged: variables are added or changed, never dropped) and starts a verify run (setup only, VM removed). Domains the agent says are missing go into `config/proxy/allowlist.txt` by hand (`make restart S=proxy`). Every run has a Setup log button.

Inside a VM, push with `git push origin HEAD:$YF_BRANCH`; other branches are rejected. Restarting `sandbox` stops the processes of every VM (`msb ls`: `crashed`) but keeps their disks: session export and the terminal still work (a bare `msb exec` boots the VM for one command), and the VS Code button starts the VM again.

## Configuration
Operator settings are files under `config/` and `.env`, committed. What the UI edits (environments, repositories, their scripts) is state in `data/yfactory/projects/`, not in git: back it up with `data/`.

| File | Content |
|---|---|
| `.env` | `YF_VERSION` (`v1`, `v2`, ...; commit: `docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' yfactory`), `YF_VM_VERSION` (the VM image `vm-v1`, `vm-v2`, ...; changes only when `vm/` changes), `YF_BIND`, `KVM_GID` |
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

```json
{
  "example": { "kind": "github", "url": "https://github.com", "tokenEnv": "GITHUB_TOKEN_EXAMPLE" },
  "acme":       { "kind": "github", "url": "https://github.com", "tokenEnv": "GITHUB_TOKEN_ACME" }
}
```

| Object | Fields |
|---|---|
| provider (`providers.json`) | `kind` (`github`, `forgejo`, `gitlab`), `url`, optional `user` (empty: `x-access-token`, or `oauth2` for GitLab), `tokenEnv` (variable in `secrets/yfactory.env`, must match `GITHUB_TOKEN`, `FORGEJO_TOKEN` or `GITLAB_TOKEN` with an optional `_SUFFIX`), optional `api`. Then `make restart`; a missing token is logged at start and the UI marks the provider |
| environment (UI) | `setup` (root, `/`, before clone), `maintenance` (root, `/workspace`, every run before the agent), `env`. Name: lowercase, digits, dashes. Cannot be deleted while used |
| repository (UI) | `provider`, `environment` (default `default`), `setup` (root, `/workspace`, after clone; empty: `.yfactory/setup.sh` from the repository), `env` (never secrets, the agent sees them), `base` (empty: default branch), `model` and `models` (default and allowed models), `reviewPublish` (`draft` or `auto`; default `draft`, findings wait in the UI) |

Script output goes to S3 `runs/<id>/setup.log`; a failing script fails the run.

There is one VM image (Node, Python, PHP, JDK 21, Maven, Composer, LSP servers). VMs download packages only through squid and `allowlist.txt`; LAN, host and containers stay blocked.
