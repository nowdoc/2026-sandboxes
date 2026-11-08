# yfactory

yfactory runs [opencode](https://opencode.ai) against a configured repository in a
[Microsandbox](https://github.com/microsandbox/microsandbox) microVM, using LiteLLM
for model access. A prompt produces a run branch and a pull request.
The VM never holds a real credential.

Architecture and trust boundaries: [`infra/docs/ARCH.md`](infra/docs/ARCH.md).

## Project structure

```
02-yfactory/
  build.sh             # builds service and VM images
  orchestrator/        # Node 24 TypeScript: UI, APIs, git validation and run management
    api/               # task API contract, schema and examples
    ui/                # sessions, terminal and files
  sandbox/             # microVM service with /dev/kvm, no provider credentials
  vm/                  # opencode, language tools and proxy settings
  tests/               # unit, integration and security tests; results/
  diagrams/            # generates infra/docs/*.svg
  infra/               # Docker Compose deployment, configuration and operations
```

## Getting started

Requires Linux, Docker Compose, `/dev/kvm` and passwordless `sudo` for Docker.
Use a git checkout to build the images:

```bash
cd 02-yfactory
./build.sh dev                 # prints "<version> <vm version>", e.g. "dev v1"
```

Then follow [deployment setup](infra/README.md#getting-started), using the
versions printed by the build. Keep services on a trusted LAN behind VPN;
the UI has no login.

Without an argument, `build.sh` uses or creates a `vN` tag on a clean checkout.
VM images have separate `vm-vN` tags and are rebuilt when `vm/` changes.

## Tests

```bash
node --test tests/actions.test.ts tests/review_e2e.test.ts
node tests/security.ts --infra ./infra --ui http://<host>:8090 --ide http://<host>:8092
```

The security suite needs a running deployment and starts real VMs.

## Runs

| Mode | Result |
|---|---|
| Implement | Edit the repository and open a pull request |
| Review | Read-only review; findings wait in the UI |
| Revise | Address unresolved review threads and update the PR head branch |
| Inspect | Propose repository and environment settings without a PR |

Git providers: GitHub, Forgejo and GitLab. See the
[task API contract](orchestrator/api/ACTIONS.md) and
[HTTP API and MCP reference](infra/docs/API.md).

## Limitations

- No issue, PR-comment or webhook triggers.
- No automatic retry after CI failure or a change to the PR head.
- No LiteLLM key budget.
- The orchestrator does not check whether the provider token can approve or merge. Restrict token permissions during setup.
- No build or test outside the VM before publishing.
- Package domain approvals require an operator to update the proxy allowlist.

Publishing was verified against Forgejo standing in for GitHub. The GitHub and
GitLab clients are implemented and tested against a stub of their APIs.
