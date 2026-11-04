# Brief for testing a single sandbox runtime

This is the assignment each runtime was tested against on 2026-11-01. The
adapters that resulted are TypeScript in `orchestrator/adapters/`. The
scorecard is [`../../README.md`](../../README.md#runtimes).

Goal: find out whether the runtime fits a simple self-hosted software factory.
We are in a PoC: the simple solution wins. Assess truthfully; "does not work" is a valid result.

## Environment
- Linux, nested `/dev/kvm`, `sudo -n`, Docker.
- The base runs in `01-factory-poc`: Forgejo, LiteLLM, gateway (`factory-llm-gw`:4000, `factory-pkg-gw`:3128).
- Read `orchestrator/adapters/index.ts`, `orchestrator/adapters/docker.ts`, `tests/probe.py`, `tests/compose_probe.sh`, `fixture/compose.yml`.

## Boundaries
- Write only to `runtimes/<name>/` and `orchestrator/adapters/<name>.ts`. Do not edit `factory.ts`, other adapters or `tests/`.
- Others are testing in parallel. Do not touch containers and networks that are not yours. Name your resources with the runtime name as a prefix.
- Do not restart Docker and do not change `/etc/docker/daemon.json`, `/etc/docker` or the host firewall. If the runtime requires it, record it as a finding and continue as far as possible.
- No `pkill -f` with a broad pattern (it would kill your shell too).
- Read install scripts before running them. Keep downloaded files in your own empty directory under `/tmp/`.
- Do not create accounts, do not log in to external services and do not use real keys. If the runtime requires a login, record it as a finding and stop with whatever can be verified without it.
- Use only the fake value `FAKE-SECRET-<name>-123` as a secret. Do not read `orchestrator/.env` or `litellm/.env`.
- Limit: roughly 60 minutes of work. What is not finished is "unverified", not "works".
- At the end, clean up after yourself: sandboxes, networks and processes. Leave installed binaries and list them.

## What to test (only for real, assume nothing)
1. **install**: exact steps, dependencies, number of daemons, license, whether an account is required.
2. **headless**: can it be controlled without a TTY from a script, as root and without interaction?
3. **adapter**: write `orchestrator/adapters/<name>.ts` with `create/exec/destroy` per the `SandboxRuntime` in `adapters/index.ts`, if possible. Does tar over stdin into `exec` work?
4. **cold_start_s**: creation → first `exec`, 3 measurements (median). **ram_idle_mb** from the host's point of view.
5. **egress**: default-deny with only selected destinations allowed. Try a direct IP (`1.1.1.1:443`), DNS `example.com`, metadata `169.254.169.254`, LAN `192.168.1.1`, the host `<host>:22`. Run a modified `tests/probe.py`, or a copied variant of it in `runtimes/<name>/`.
6. **credentials**: can `FAKE-SECRET` be injected from the host into an HTTP header so that it is not readable in the sandbox (env, files, /proc)? Verify with an echo server on the host. Also try sending the placeholder to a disallowed host.
7. **gateway**: can the sandbox reach the LLM gateway and the package proxy? Can the host tell which sandbox is calling? Describe how a task identity could be assigned (the gateway currently maps source IP to key).
8. **compose**: Docker Compose with `fixture/compose.yml` inside: how many services are healthy out of 15, in how long, does `nslookup web.cz.test 172.30.0.2` work? Without `--privileged` if possible; if it needs privileged, say so.
9. **isolation**: two sandboxes at once, do they see each other over the network? Do they share a disk? Can the host be reached?
10. **lifecycle**: does destroy clean up after itself? Pause/resume, snapshot, if they exist. 3 parallel sandboxes.

## Output
- `runtimes/<name>/NOTES.md`: very brief steps, what worked, what did not, and error messages.
- `runtimes/<name>/results.json`: `{"runtime","version","status":"works|partial|blocked","kvm_used":bool,"tests":{"<test>":{"result":"pass|fail|partial|untested","detail":"..."}},"cold_start_s","ram_idle_mb","compose_healthy","needs_account":bool,"daemons":n,"verdict":"2 sentences"}`
- Final answer: max 10 lines, the most important findings and what remained unverified. Distinguish what you measured from what you only read in the documentation.
