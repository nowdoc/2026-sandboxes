# Services

What each service is for, what it takes and gives, and what it is not for. Addresses, networks, ports and credentials at a glance are in [README.md](../README.md), the trust model in [ARCH.md](ARCH.md).

Every container logs through the Docker `syslog` driver (UDP) to VictoriaLogs; no service needs the Docker socket. Every service has a `healthcheck`; `yfactory` waits for a healthy `sandbox`, `litellm` and `garage`. VMs get addresses from `10.200.0.0/16` inside the `sandbox` container.

## yfactory (orchestrator)
| | |
|---|---|
| Image | `ynfra/yfactory:orchestrator-${YF_VERSION}`, Node 24 |
| For | UI, HTTP API and management MCP server (`POST /mcp`, see [API.md](API.md)), run queue and lifecycle, git mirrors and run repositories, commit checks, push and PR, LiteLLM keys per run, session export to S3, Inspect environment (an inspect run asks the agent for a proposal of repository and environment changes, a person applies it, a verify run checks the setup) |
| Not for | running code from repositories (that is `sandbox`), anything reachable from the internet |
| Ports | `8080` UI, API, `/metrics` and `/health` (200 or 503 with per-dependency status for `sandbox`, S3 and LiteLLM, no token, not reachable from VMs; host `<host>:8090`), `9001` task API for VMs on `vms` `10.99.0.10`, the only address and port a VM may reach (git over HTTP, LLM `/v1/chat/completions`, `/v1/messages`, `/v1/responses`, `/v1/models`; the run token is the only credential, `yfactory` swaps in the run's virtual LiteLLM key and streams the answer); `8081` VS Code of a run's VM, `/<run id>/` proxied to `sandbox` (host `<host>:8092`, its own origin so pages from the VM cannot call the UI API; WebSockets only with a same-host `Origin`) |
| Networks | `core`, `control` |
| Inputs | UI and API requests, `config/yfactory/` (`providers.json`, `yfactory.json`, `opencode.json`), `data/yfactory/projects/` (environments, repositories, scripts; written by the UI), the GitHub, Forgejo or GitLab API |
| Outputs | VMs through the `sandbox` API, branches and PRs on the provider, S3 `sessions/`, `runs/`, virtual keys in LiteLLM |
| Credentials | provider tokens (`GITHUB_TOKEN_<NAME>`, `FORGEJO_TOKEN_<NAME>` or `GITLAB_TOKEN_<NAME>`, one per account), `LITELLM_MASTER_KEY`, `S3_ACCESS_KEY`/`S3_SECRET_KEY`, `SANDBOX_TOKEN` |
| Data | `data/yfactory/` (mirrors, run repositories, `runs.json`, `projects/`) |
| Hardening | uid 1000, `cap_drop: ALL`, no `/dev/kvm`, no `docker.sock` |

## sandbox
| | |
|---|---|
| Image | `ynfra/yfactory:sandbox-${YF_VERSION}`, Node and `msb` (Microsandbox) |
| For | VMs (microVMs): create, exec, delete; the VM image loaded from a tar in `data/images/` |
| Not for | holding any credential, talking to the git provider, LiteLLM or S3 |
| Ports | `7000` API (`GET /vms`, `POST /vms/<name>`, `POST /vms/<name>/exec`, `POST /vms/<name>/start` (idempotent, boots a crashed or stopped VM and keeps it running), `DELETE /vms/<name>`, `POST /vms/<name>/shell`, any `/vms/<name>/http/<path>` as HTTP and WebSocket to code-server in the VM, with the token stripped), `Authorization: Bearer SANDBOX_TOKEN`; `/metrics` without a token (counts only); `/health` without a token (200 or 503, checks that `msb` answers) |
| Networks | `control`, `vms` `10.99.0.3`, `egress` |
| Inputs | calls from `yfactory`, the VM image `YF_VM_VERSION` |
| Notes | drops other VM images from msb at start (the tar changes only when `YF_VM_VERSION` does); each VM gets a host port `20000`–`20999` on `127.0.0.1` of this container for code-server (VM port `8443`), read back from `msb inspect` after a restart |
| Outputs | VMs that reach only `yfactory` `10.99.0.10:9001` and `proxy` `10.99.0.11:3128` |
| Credentials | `SANDBOX_TOKEN` |
| Data | `data/sandbox/` (msb state, VM disks) |
| Hardening | uid 1000, only `/dev/kvm`, `cap_drop: ALL`. Restarting it stops every VM |

## proxy (squid)
| | |
|---|---|
| Image | `ubuntu/squid:6.10-24.10_beta`, config `config/proxy/squid.conf`, `config/proxy/allowlist.txt` |
| For | package downloads from VMs, only to domains in `allowlist.txt`, HTTPS through `CONNECT :443` |
| Not for | general internet access |
| Ports | `3128` on `vms` `10.99.0.11` |
| Networks | `core`, `vms` `10.99.0.11` |
| Credentials | none |

## litellm
| | |
|---|---|
| Image | `ghcr.io/berriai/litellm:v1.106.6`, config `config/litellm/litellm.yaml` |
| For | one OpenAI-compatible LLM endpoint, a virtual key per run, revocable by alias; models `GLM-5.3-Flash`, `GLM-5.3`, `mock` |
| Not for | being reached by VMs directly (only through the task API of `yfactory`), budgets (none by decision) |
| Ports | `4000` on `core` |
| Inputs | requests with a virtual key, key management from `yfactory` with the master key |
| Outputs | upstream LLM `OPENAI_API_URL` |
| Credentials | `LITELLM_MASTER_KEY`, `OPENAI_API_URL`/`OPENAI_API_KEY`, `DATABASE_URL` |

## db (Postgres)
| | |
|---|---|
| Image | `postgres:17-alpine` |
| For | LiteLLM keys and spend log only |
| Not for | any yfactory data |
| Ports | `5432` on `core` |
| Credentials | `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` |
| Data | `data/litellm-db/` |

## garage (S3)
| | |
|---|---|
| Image | `dxflrs/garage:v2.4.1`, config `config/garage/garage.toml` |
| For | bucket `yfactory`: `sessions/<owner>/<repo>/<day>/<run>/<session>.json`, `runs/<run>.json`, `runs/<run>/setup.log`, `memory/<owner>/<repo>.json` |
| Not for | git data, anything reachable from VMs |
| Ports | `3900` S3 API (also host `127.0.0.1:3900`), `3901` RPC, `3903` admin, region `garage` |
| Networks | `core` |
| Credentials | `GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN` from `secrets/garage.env`; clients use `S3_ACCESS_KEY`/`S3_SECRET_KEY` |
| Data | `data/garage/` |

## victorialogs
| | |
|---|---|
| Image | `victoriametrics/victoria-logs:v1.26.0` |
| For | logs of every container, 30 days, LogsQL; stream field `app_name` is the container name |
| Not for | audit that must survive the host, logs from inside VMs (those are in S3 `runs/`) |
| Ports | `9428` HTTP on `monitoring`, `5140/udp` syslog on host `127.0.0.1` |
| Inputs | the Docker daemon through the `syslog` logging driver of each service |
| Data | `data/victorialogs/` |
| Hardening | uid 1000, `cap_drop: ALL`; logs over UDP are lost while it is down |

## victoriametrics
| | |
|---|---|
| Image | `victoriametrics/victoria-metrics:v1.122.0`, scrape targets `config/victoriametrics/scrape.yml` |
| For | metrics, 90 days, PromQL/MetricsQL, every 30 s from itself, VictoriaLogs, Grafana, cAdvisor, `yfactory` and `sandbox` (`yf_*`: runs, durations, queue, VMs, VM operations, task API denials) |
| Not for | host disk and CPU (no node exporter), container names and network (see `cadvisor`) |
| Ports | `8428` on `monitoring` |
| Networks | `monitoring`, `core` and `control` (to scrape services there) |
| Data | `data/victoriametrics/` |
| Hardening | uid 1000, `cap_drop: ALL` |

## cadvisor
| | |
|---|---|
| Image | `ghcr.io/google/cadvisor:v0.53.0` |
| For | CPU, memory and start time (uptime, restarts) of every Docker container on the host, from the cgroup tree; dashboard panels at the bottom of `yfactory` |
| Not for | container names, network and disk per container, host disk and CPU |
| Ports | `8080` on `monitoring`, not published |
| Mounts | only `/sys/fs/cgroup` read-only, host cgroup namespace; no `docker.sock`, no `/`, no `/var/lib/docker` |
| Notes | containers show as the first 12 characters of the container id (`docker ps --no-trunc`); naming them needs `docker.sock`, and cAdvisor v0.53 fails on Docker 29 with the containerd snapshotter anyway; sees every container on the host, also other stacks; most metric groups are disabled |
| Hardening | uid 1000, `cap_drop: ALL` |

## grafana
| | |
|---|---|
| Image | `grafana/grafana:12.1.0` with plugin `victoriametrics-logs-datasource`, data sources from `config/grafana/provisioning/` |
| For | Explore over logs and metrics, dashboard `yfactory` (services, runs, containers, errors) from `config/grafana/dashboards/`, later alerts |
| Ports | `3000` on `monitoring`, host `<host>:8091`; anonymous viewer, `admin` with `GF_SECURITY_ADMIN_PASSWORD` |
| Data | `data/grafana/` |

## VM (per run, not a compose service)
| | |
|---|---|
| Image | `ynfra/yfactory:vm-${YF_VM_VERSION}`, one image: Node, Python, PHP, JDK 21, Maven, Composer, LSP servers |
| For | opencode as the agent, git, the repository's tools, code-server (`/opt/code-server`, started on demand as `agent` from the UI); user `agent`, workspace `/workspace` |
| Not for | publishing (no provider token), reaching anything besides `yfactory:9001` and `proxy` |
| Inputs | run token through stdin into `~/.yf-env` (no LLM key), the task API address, environment and repository `env` |
| Outputs | pushes to `yfactory/<id>` in its run repository, opencode sessions exported on delete |
| Order of a run | create VM → environment `setup` (root, `/`) → clone → repository `setup` (root, `/workspace`) → environment `maintenance` (root, `/workspace`) → agent |
