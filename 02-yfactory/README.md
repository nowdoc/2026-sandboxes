# 02-yfactory — prompt → microVM agent → pull request

yfactory is what the [PoC](../01-factory-poc/) turned into once the runtime
was chosen. A prompt against a configured repository starts a
[Microsandbox](https://github.com/microsandbox/microsandbox) microVM, runs
[opencode](https://opencode.ai) inside it on LiteLLM, and comes back as a run
branch and a pull request. The VM never holds a real credential.

Architecture and trust boundaries: [`infra/docs/ARCH.md`](infra/docs/ARCH.md).

## Layout

```
02-yfactory/
  build.sh             # builds ynfra/yfactory:<service>-<version> and the VM image vm-vN
  orchestrator/        # Node 24 TypeScript, no build step: UI, HTTP API, MCP server, task API, git checks, review mode
    api/               # what the VM may ask the orchestrator to do: ACTIONS.md, JSON schema, examples
    ui/                # dark-only UI modelled on Devin (sessions, composer, terminal, files)
  sandbox/             # the service that creates and drives microVMs (msb); has /dev/kvm, no credentials
  vm/                  # VM image: opencode, LSP, language profiles (default, php, java), proxy settings
  tests/               # security.ts (escape/egress suite), actions + review e2e tests, vm_probe.py
    results/           # last security run: v28, 161/161
  diagrams/            # generates infra/docs/*.svg from the source
  infra/               # the deployment ("ynfra"): compose, services/, config/, docs/, Makefile
```

## Trust model in one paragraph

The orchestrator (`yfactory` container) holds the provider token, the LiteLLM
master key and the S3 keys. VMs run in a separate `sandbox` container that has
`/dev/kvm` but no credentials and no route to the core network. A VM reaches
only the orchestrator's task API (LLM routes and the git repository of its own
run, authenticated with a run token) and a squid package proxy with a domain
allowlist; everything else is blocked by msb default-deny egress. The VM may
push only `yfactory/<id>`; the orchestrator checks every commit before it
pushes to the provider and opens the PR. The check rejects `.git`, `.github`,
`.gitea`, `.forgejo`, `.gitlab-ci.yml`, `.gitmodules` and `.gitattributes`,
plus symlinks, submodules and merge commits, and more than 200 commits.
`.gitignore` is allowed. Sessions and run metadata go to S3 (Garage) even when
a run fails. Providers are GitHub, Forgejo and GitLab.

## Run it

Needs Docker, `/dev/kvm` and a user with passwordless `sudo` for Docker
(`build.sh` and `yfactory.sh` call `sudo`).

```bash
cd 02-yfactory
./build.sh dev                 # prints "<version> <vm version>", e.g. "dev vm-v1"
cd infra
cp .env.example .env           # YF_VERSION=dev, YF_VM_VERSION=v1, YF_BIND=<your LAN IP>, KVM_GID
make init                      # creates data/ and secrets/ with random values
$EDITOR secrets/litellm.env    # OPENAI_API_URL / OPENAI_API_KEY of your model provider
$EDITOR secrets/yfactory.env   # GITHUB_TOKEN_<PROVIDER>: fine-grained PAT, Contents + Pull requests rw
$EDITOR config/yfactory/providers.json config/yfactory/yfactory.json config/litellm/litellm.yaml
make up
make status
```

UI on `http://<YF_BIND>:8090`, VS Code of a run on `:8092`, Grafana on `:8091`.
All commands are in [`infra/README.md`](infra/README.md).

`build.sh` uses git tags of the repository it lives in (`vN`, `vm-vN`), so run
it from a git checkout. The model names in `config/` (`GLM-5.3`,
`GLM-5.3-Flash`) are what our LiteLLM upstream offered; change them to yours.

## Tests

```bash
node --test tests/actions.test.ts tests/review_e2e.test.ts
node tests/security.ts --infra ./infra --ui http://<host>:8090 --ide http://<host>:8092
```

The security suite needs a running deployment and starts real VMs.

## Runs

A prompt starts an implement run: the agent edits the repo and the orchestrator
opens the pull request. The same API also starts a review (the agent only
reads, findings wait in the UI), a revise (the agent addresses unresolved
review threads and the orchestrator pushes to the pull request's head branch),
and an inspect (the agent proposes repository and environment settings). The
contract for what the VM may ask is
[`orchestrator/api/ACTIONS.md`](orchestrator/api/ACTIONS.md).

## Not built

- Starting a run from an issue, a PR comment or a webhook. Input is a prompt, or an explicit review or revise call.
- A second pass when CI fails or the pull request head moves.
- A budget on the virtual LiteLLM key. Left off on purpose.
- A check that the provider token cannot approve or merge. The documented token is Contents and Pull requests; that limit is the token, not the orchestrator.
- Build or test outside the VM before the pull request.
- An approved `request_domain` does not edit the proxy allowlist. An operator changes `config/proxy/allowlist.txt`.

Publishing was verified against Forgejo standing in for GitHub. The GitHub and
GitLab clients are implemented and tested against a stub of their APIs.
