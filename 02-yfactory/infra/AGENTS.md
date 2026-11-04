# AGENTS.md

This directory runs yfactory like production and is self-contained: everything except the Docker images lives here, including status and plans. No source code, no builds, no references to other directories on the host.

## Project docs
| File | Content |
|---|---|
| `README.md` | addresses, ports, credentials, commands, configuration |
| `docs/SERVICES.md` | each service: purpose, inputs, outputs, ports, what it is not for |
| `docs/ARCH.md` | architecture and trust boundaries |
| `docs/*.svg` | diagrams, generated from the yfactory source |

- What was done, verified and not verified goes into the commit message.
- A service change updates `docs/SERVICES.md` and `README.md`.
- `docs/` holds only `*.md` and `*.svg`, no scripts.

## Conventions
- Terms: **VM** is the microVM of a run, `sandbox` is only the service that drives VMs (see the Terms table in `README.md`). Never call a VM a sandbox.
- English everywhere: code, comments, commit messages, docs, UI.
- Comments only for a non-obvious *why*. No headers restating the file name, no comments that repeat the code.
- Same thing, same way: before adding something, copy how the existing services do it (volumes, secrets, healthchecks, logging, names). An exception needs a comment with the why.
- Simple wins: one Compose file, one script. Every operation goes through `yfactory.sh`; the `Makefile` only calls it.
- Images are `ynfra/yfactory:<service>-<version>` (`orchestrator`, `sandbox`) and `ynfra/yfactory:vm-<vm version>` with its own counter, referenced by tag only, no `build:`. A version is `v1`, `v2`, ..., never a hash; the commit is in the image label `org.opencontainers.image.revision`. Third-party images are pinned to a version.
- Config lives in `config/<service>/<file>`, one directory per service (`config/yfactory/`, `config/proxy/`, ...), mounted read-only at `/config`. A setting is a key in a config file, not an environment variable passed through `services/*.yml`. What the UI edits is state in `data/`, not config.
- One file per service in `services/`, included from the root `compose.yml`, which holds the networks.
- Mounts are plain bind mounts of `./config` and `./data/<name>`, no named volumes.
- Credentials only in `yfactory`. `sandbox` has `/dev/kvm` and nothing else.

## Secrets
- `secrets/` is owned by the user who runs `yfactory.sh` through sudo (mode 600, so you can read and edit the files) and never committed. Do not print or copy values; refer to variables by name.
- Every secret is a `KEY=VALUE` line in `secrets/<name>.env`, given to a container only with `env_file`. No mounted secret files, no `*_file` options, no secrets in `config/`, `compose.yml` or `.env`.
- One file per service (`yfactory.env`, `litellm.env`); a file shared by several services is named after the credential (`s3.env`, `sandbox.env`). A value needed by two services with different other secrets (`LITELLM_MASTER_KEY` in `yfactory.env` and `litellm.env`) is the one allowed duplicate; `init` writes both from one generation. Variables use the names the image expects (`GARAGE_RPC_SECRET`, `GF_SECURITY_ADMIN_PASSWORD`).
- `init` creates every file: generated values, or an empty `KEY=` for what the user fills in. It never overwrites an existing file.
- After a change: `make restart S=<service>`.
- VMs get only a per-run virtual LiteLLM key and a run token. The provider token, the LiteLLM master key and the S3 keys stay in the orchestrator.

## Changes
- New version: `make deploy V=<version>` (and `VM=<vm version>` when `vm/` changed), commit `.env`.
- Config change: edit `config/`, `make restart S=<service>` (recreates the container so `secrets/` changes apply), commit.
- Verify after a change: `make status`, one run with a prompt, `make runs`.
- Do not open services to the internet. The UI has no login and relies on the LAN behind VPN.
