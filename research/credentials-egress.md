# Credentials outside the agent and network control: research (2026-11-01)

Legend: [P] primary source (vendor docs, author of the finding, official issue), [S] secondary (news, blogs), [M] marketing/vendor claim. Date = date of the source. Text marked "(judgment)" is my conclusion, not a claim of the source.

The assessment in sections 5 and 6 is of the PoC on this date. What yfactory later built from it is summarized in [README.md](README.md).

## 1. What is done in practice (confirmed)

- A credential injection proxy is a common pattern: the sandbox holds only a placeholder value, a proxy on the host rewrites the auth header. Docker Sandboxes: sentinel `proxy-managed`, or `sbx-cs-<rand>`; substitution only in HTTP headers, not in bodies; "OAuth passthrough" sends the real token into the sandbox. [P/M, vendor docs, no date] https://docs.docker.com/ai/sandboxes/configuration/credentials/
- Anthropic (Claude Code on the web): git credentials and signing keys are not in the sandbox; the sandboxed git client authenticates to the proxy with a scoped credential, the proxy verifies the operation (e.g. push only to the configured branch) and adds the real token. Network goes through a proxy outside the sandbox over a Unix socket. [P, 2025-10-20] https://www.anthropic.com/engineering/claude-code-sandboxing
- Other vendors (Gemini agent credentials, BoxLite, Blaxel, Onyx) describe the same; these are product texts, not independently verified. [M, no data] see the search for "credential injection proxy"; e.g. https://blaxel.ai/blog/egress-proxy-api-credentials-ai-agent-sandboxes
- GitHub App: the installation token expires after 1 hour and at issuance can be restricted to specific repositories (`repositories`, up to 500) and a subset of permissions (`permissions`). [P, no date] https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app (PAT vs App: I did not find a separate comparison; the advantages of the App follow from this page, judgment.)
- LiteLLM virtual keys: `max_budget`, `budget_duration`, `duration` (TTL), list of `models`, rpm/tpm limits, `allowed_routes`, block/unblock, `metadata`; the key can be read from a custom header (`litellm_key_header_name`). Key regeneration with a grace period is marked as Enterprise. [P, no date] https://docs.litellm.ai/docs/proxy/virtual_keys
- Envoy: a generic `credentialInjection` filter (Secret, `overwrite` option) and Envoy AI Gateway upstream auth (static keys in a K8s Secret, short-lived ones through an identity provider). I verified the page contents only through search results, not by reading them. [P, no date] https://gateway.envoyproxy.io/docs/tasks/security/credential-injection and https://aigateway.envoyproxy.io/docs/capabilities/upstream-auth
- Portkey: Virtual Keys moved to the "Model Catalog" (budgets, rate limits, model allowlists); it states neither expiry nor what is OSS vs cloud. [P/M, no date] https://portkey.ai/docs/product/ai-gateway/virtual-keys

## 2. Incidents and attacks

- LiteLLM on PyPI: versions 1.82.7 and 1.82.8 uploaded directly to PyPI (no tag/CI), 2026-03-24. 1.82.8 added `litellm_init.pth` (runs on every Python start). The payload collects SSH keys, env, cloud/K8s credentials and sends them to `models.litellm.cloud`. Official team: the maintainer's PyPI account was taken over, entry through the Trivy dependency. The proxy Docker image reportedly unaffected (pins in requirements.txt). [P, issue closed 2026-10-09] https://github.com/BerriAI/litellm/issues/24518
  - Disagreement: secondary sources write about a compromised GitHub account/CI and about ~2 hours of availability; the official issue states a PyPI account and an estimate of 08:30 UTC with no confirmed duration. [S] https://www.comet.com/site/blog/litellm-supply-chain-attack/ , https://bastion.tech/blog/litellm-pypi-supply-chain-attack
- LiteLLM CVE-2026-42208: pre-auth SQL injection in the Bearer token check (1.81.16 to 1.83.6), allows reading stored upstream keys and changing keys/budgets. Fix 1.83.7 (2026-04-19), advisory GHSA-r75f-5x8p-qvmc (2026-04-20). Exploitation ~36 h after disclosure (CSA); CISA KEV 2026-05-08 (stated only by the secondary cert.ug). [P Bishop Fox / S CSA] https://bishopfox.com/blog/cve-2026-42208-pre-authentication-sql-injection-in-litellm-proxy , https://labs.cloudsecurityalliance.org/research/csa-research-note-litellm-pre-auth-sqli-20260428/ (CSA date 2026-04-30)
- CamoLeak (Copilot Chat): hidden comment in a PR description, character-by-character exfiltration through pre-signed Camo URLs (CSP bypass). Fix: disabling image rendering (2025-08-14). Published by Legit 2025-09-30. CVSS 9.6. Disagreement: CVE-2025-59145 is given by Petri/Register (2025-10), the Legit article does not give a CVE. [P/S] https://www.legitsecurity.com/blog/camoleak-critical-github-copilot-vulnerability-leaks-private-source-code , https://petri.com/github-copilot-chat-camoleak-vulnerability/
- PromptPwnd (Aikido): untrusted text (issue title, PR, commit) inserted into the prompt of AI actions in GitHub Actions with tokens. Gemini CLI action confirmed and fixed by Google within 4 days; Claude Code Action risky with `allowed_non_write_users: "*"`; Codex with `allow-users: "*"` + a wrong safety-strategy; confirmation from other vendors not found. [P (author of the finding), 2025-12-04, updated 2026-03-17] https://www.aikido.dev/blog/promptpwnd-github-actions-ai-agents
- CVE-2025-53773: prompt injection made Copilot write `chat.tools.autoApprove` into `.vscode/settings.json` (attack through agent output into configuration); fixed August 2025. Sources differ in CVSS and dates. [S, not verified with MSRC] https://www.wiz.io/vulnerability-database/cve/cve-2025-53773
- npm as an exfiltration channel: malware in packages published an archive of stolen data in pieces as new versions under the attacker's account. [S, OSV MAL-2026-*, no exact date] https://osv.dev/vulnerability/MAL-2026-10506 . An allowed registry is therefore not just "read".
- DNS: the Bedrock AgentCore Code Interpreter in "no network" mode still resolved DNS (a tunneling channel). Allowlists with wildcards (`*.amazonaws.com`) and Google Forms on an allowed domain effectively enable exfiltration. [S, 2026] https://www.csoonline.com/article/4146202/aws-bedrocks-isolated-sandbox-comes-with-a-dns-escape-hatch.html , https://www.promptarmor.com/resources/what-domains-should-i-add-to-my-allowlist
- Frameworks: Willison "lethal trifecta" (private data + untrusted content + external communication; he does not consider "95 %" guardrail products sufficient) [P, 2025-06-16] https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/ ; Meta Rule of Two (untrusted input / sensitive data / state change or external communication, at most two per session; not a substitute for defense in depth) [P, 2025-10-31] https://ai.meta.com/blog/practical-ai-agent-security/

## 3. Egress tools (what I verified)

- Squid: `ssl_bump` rules work in steps; a splice decided too early sees only the IP, peek is needed; a client without SNI can bypass rules keyed on SNI. [S, Squid wiki] https://wiki.squid-cache.org/Features/SslPeekAndSplice . The sources do not address domain fronting; my reasoning: without bump the inner Host cannot be inspected.
- Cilium `toFQDNs`: depends on the DNS proxy; the example allows all DNS queries (`"*"`); whether narrowing `matchPattern` blocks a DNS tunnel, the page does not confirm. [P, no date] https://docs.cilium.io/en/stable/security/dns/
- Smokescreen (Stripe): CONNECT proxy with a per-client ACL (identity from the client certificate), global allow/deny, recommends an allowlist, filters non-public IPs. Read from search results, README not opened. [P] https://github.com/stripe/smokescreen

## 4. Not found / not verified

- Per-VM identity at the gateway (SPIFFE, mTLS, vsock) for Firecracker/Kata: no source. Only a per-VM HMAC key over vsock in the cellos project and tap+nftables per VM. [S] https://docs.rs/crate/cellos-host-firecracker/
- DNS behavior in a Docker `internal` network (whether the embedded resolver forwards outward): I did not investigate.
- Exact GitHub App permissions for editing `.github/workflows` (the `workflows` permission), `pull_request_target`, attacks through symlinks/`.gitattributes`/submodules in a patch: not looked up in sources; below only as judgment to be verified.
- PAT vs App comparison from a primary source, Portkey OSS vs cloud, Claude Code and DNS exfiltration: not found.

## 5. Assessment of your design

Good:
- No git token in the sandbox and the push done by a bot from the host matches the Anthropic pattern (see 1). A patch as text is a narrower interface than a shared git repository.
- Per-task network, LLM through a gateway with budget and TTL, packages through an allowlist proxy: matches the recommendations of the sources above.
- `git am` in a clean clone: `git am` runs the hooks `applypatch-msg`, `pre-applypatch`, `post-applypatch`; `--no-verify` skips only the first two, not `post-applypatch`. So disabling hooks via `core.hooksPath` (pointing at an empty directory) is necessary; `--no-verify` is not enough. [P] https://git-scm.com/docs/git-am

Holes:
1. A webhook with no sender check = anyone can start the agent over untrusted text; exactly the PromptPwnd pattern (see 2). By the Rule of Two this is input A, plus the LLM key + repo content (B) + network through Squid / the patch (C): all three properties.
2. The orchestrator as root: compromising anything that processes sandbox output (patch parser, Docker API) is compromising the host (judgment). No source was needed for this.
3. IP→key: does not work for microVMs from the same IP; moreover nginx with the keys is the only point where a spoofed/shared IP allows using someone else's budget (judgment).
4. LiteLLM itself is a target: two incidents in 2026 (PyPI, SQLi), the DB holds upstream keys.
5. A registry allowlist is an exfiltration and delivery channel (see 2, npm).

## 6. Recommendations ordered by benefit/complexity for the PoC

1. Verify the webhook sender (GitHub HMAC signature + the user's permission on the repo/`author_association`) and run nothing for outsiders. Lowest complexity, biggest benefit. (Webhook signing was not read in this research, judgment.)
2. Do not run the orchestrator as root; create tasks through a narrow API, not through full access to the Docker socket (judgment).
3. LiteLLM: pin the Docker image version/digest (not `pip install litellm` without a pin), >= 1.83.7, no sandbox access to admin routes (`allowed_routes` per key), DB unreachable from the sandbox network. Sources: issue #24518, Bishop Fox.
4. Task identity: instead of IP, issue a per-task LiteLLM virtual key (budget, `duration`, `models`, `allowed_routes`) and put it into the sandbox as a scoped credential, the same as git in the Anthropic pattern. A leaked key is then limited by budget and TTL. Nginx can enforce/verify the key, but do not rely on IP. It is a compromise compared to a pure "sandbox has no key": the sources do not address this variant for LLM (judgment). Alternatives without a key in the sandbox: a unique IP/tap per microVM (nftables, needs network work) or mTLS per VM (source not found).
5. Squid: allow only exact domains (no wildcards like `*.amazonaws.com`), sandbox without its own DNS resolver, the proxy decides by name; log. Verify that a Docker `internal` network does not let DNS out.
6. Registries: prefer a read-only mirror/cache (one instance for npm/PyPI/Packagist/Docker Hub) over direct public registries; block write methods (PUT/POST to registries) where the proxy can, which for HTTPS requires bump (judgment; for the npm exfil case see 2). Without a mirror a residual risk of small-scale exfiltration remains; accept and document it.
7. CI protection in the PR: (a) on the host before `git am`, reject patches touching `.github/`, `.gitmodules`, `.gitattributes`, hooks, symlinks and mode changes (own check, judgment); (b) the bot as a GitHub App without the `workflows` permission (from my knowledge, not verified by this research) and with a token limited to one repo; (c) a "Restrict file paths" ruleset on `.github/workflows/**` (GitHub gives this example; plan limits: Team/Enterprise, applies to forks too) https://github.blog/changelog/2024-09-10-push-rules-are-now-generally-available-and-updates-to-custom-properties/ ; (d) CODEOWNERS for `.github/` + "Require review from Code Owners", also protect CODEOWNERS itself; the owner must have write access, the page says nothing about bots https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners ; (e) CI on a PR from the bot must not have secrets. Similarly watch tool configuration (`.vscode/`, `.claude/`, hooks) because of the CVE-2025-53773 pattern.
8. Later: human approval before merge (Rule of Two, "supervision"), DNS monitoring, mTLS identity of the microVM.

## 7. Notes on reliability

- Most "credential proxy" material is vendor documentation/marketing without independent verification. No independent analysis of the pattern was found.
- For several sources (Envoy, Smokescreen, Squid, CVE-2025-53773, DNS) I did not read the search results in full; marked above.
