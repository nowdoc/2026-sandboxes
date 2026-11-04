# Research: software factory / background coding agents (as of 2026-11-01)

Markers: [P] primary source (engineering blog, documentation, own data), [S] secondary (third party, aggregator), [M] marketing / own claim without methodology. Date = date of the source. Numbers are always claims of the given source, not verified.
Method: web search + page fetch; the fetch returns a summary by a small model, so quotes are paraphrases. What could not be found is stated explicitly.

The critique in section 3 is of the PoC on this date. What yfactory later built from it is summarized in [README.md](README.md).

## 1. Real projects

### Stripe Minions
- Triggers: Slack thread, internal docs/feature-flag/ticket UI, CI (a button next to a flaky test), CLI, web. [P] https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents (2026-02-09)
- Sandbox: "devbox" (EC2, the same machine engineers use), pre-warmed pool, start ~10 s, no access to production or the internet, hence no permission prompts. [P] same; Part 2 https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents-part-2 (2026-02-19)
- Orchestration: "blueprints" = code that alternates deterministic nodes (lint, git push) and agentic nodes; the agent is a fork of Block goose; rules per subdirectory; MCP "Toolshed" (400+ tools / ~500, sources differ). [P] Part 1 and 2
- Validation: local check <5 s on every push; CI max 1-2 rounds (diminishing returns); then back to a human. [P] Part 1
- Review: always a human; PR from a template; iteration by further instructions, the minion pushes an update. [P] Part 1
- Numbers: 1000+ (Part 1), 1300+ (Part 2) merged PRs per week "entirely from minions". Merge rate and incidents: not stated. Git identity: not stated.

### Ramp Inspect
- Triggers: Slack, web, Chrome extension; follow-ups are queued, not injected into a running session. [P] https://builders.ramp.com/post/why-we-built-our-background-agent (no date in the text)
- Sandbox: Modal VM with a full dev stack (Postgres, Redis, Temporal…), per-repo image rebuilt every 30 min as a snapshot; the snapshot is kept after the agent finishes for follow-ups; OpenCode as the agent. [P] Ramp blog; [P] https://modal.com/blog/how-ramp-built-a-full-context-background-coding-agent-on-modal (2026-02-19, Modal is a vendor, so partly marketing)
- Git identity (the only source describing it in detail): clone via a GitHub App token, commit with the requester's user.name/email, the sandbox pushes a branch and the API opens the PR with the user's token, so the PR author is a human and cannot approve their own PR. [P] Ramp blog
- Verification: backend tests + telemetry + feature flags, frontend screenshots/preview. [P]
- Share of PRs: 30 % (Ramp blog), "roughly half" (Modal, 2026-02-19), "more than half" (Ona white paper [M] https://ona.com/files/background_agents_white_paper.pdf, 2026-02), 75 % (rywalker.com, refers to an interview from August) [S] https://rywalker.com/research/in-house-coding-agents. Mismatch: different data and definitions. Merge rate/incidents: not stated.

### Spotify Honk
- The agent replaces scripts in Fleet Management (container jobs opening PRs across repos); internal CLI, swappable agents/LLMs. [P] https://engineering.atspotify.com/2025/11/spotifys-background-coding-agent-part-1 (2025-11-06)
- Sandbox: heavily restricted container, few binaries, almost no outside access; push, Slack and prompts are handled by external infrastructure (the agent does not push). [P] Part 3 https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3 (2025-12-09)
- Validation: deterministic verifiers (build/test/format) called via MCP + a stop hook (without passing, no PR is opened) + an LLM judge that vetoes ~a quarter of sessions, from which the agent recovers about half the time. The judge has no evals. [P] Part 3
- Failure modes by their account: no PR (tolerable) < PR fails in CI < PR passes CI but is functionally wrong (worst). [P] Part 3
- Numbers: 1500+ merged PRs; 60-90 % time saved on migration. Merge rate and incidents: not stated. (Addition [S] rywalker: 240 PRs / ~1800 pipelines, 10 engineering weeks, own estimate.)

### Shopify River
- Only a secondary index (Port) summarizing Shopify blogs: Slack-native, public channels only; hosting "Aquifer" split into a persistent session (Postgres), a disposable harness and a disposable sandbox; the harness is outside the sandbox; "deterministic code owns credentials and git operations". [S] https://software-factories.port.io/shopify (updated 2026-09-08, internally inconsistent data)
- Numbers (own, no methodology): 3,536 PRs in 30 days, 1 in 8 merged PRs. I did not read the primary Shopify blogs.

### Uber Minion
- Secondary only: dev pod with a full build, "70 % of PRs from agents", they abandoned the "years saved" ROI metric. [S] https://rywalker.com/research/in-house-coding-agents, https://openclawdatabase.com/news/videos/2026-08-21-uber-agentic-sdlc-software-factory/ (2026-08-21). Primary blog not found. The 70 % figure is not confirmed by a second source.

### GitHub Copilot coding agent
- Documentation: sandbox in Actions (59 min limit) or cloud sandbox; one branch, one PR per task; firewall allowlist; a ruleset can block the agent. [P] https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent (date not determined). Commit identity and workflow approval are not described in this text.
- The best public operational data there is: Microsoft .NET, dotnet/runtime, 2025-05-19 to 2026-03-22. [P] https://devblogs.microsoft.com/dotnet/ten-months-with-cca-in-dotnet-runtime/ (2026-03-23)
  - 878 PRs, 535 merged, 253 closed, 90 open; success rate 67.9 % = 535/(535+253). (Other sources give 61 % = 535/878; it is just a different denominator.) Microsoft people 87.1 %, community 79.7 %.
  - Revert 0.6 % (3/535) vs 0.8 % for others; the author: statistically insignificant.
  - Trend 41.7 % (May 2025) → ~71 % (last quarter). Before setup instructions were added to the repo 38.1 %, after 69 % (observational, not an experiment).
  - Tasks: cleanup/removal 84.7 %, tests 75.6 %, bugfixes 69.4 %, features 64.5 %, performance 54.5 %.
  - Failures: native C++ and platforms other than Linux, architecture, unverified performance claims; 44 % of closed PRs were auto-closed/abandoned drafts.
  - Review load: on average 16.5 comments per merged CCA PR vs 12.4 for humans; PRs with human commits succeeded in 86.2 % vs 55.1 % without them. Every PR also gets an AI review.

### OpenAI Codex cloud
- A task has its own workspace; install script configuration, internet modes (everything / package managers only / allowlist), secrets (HTTP secrets, env, OIDC); PR/commit only after inspection. [P] https://learn.chatgpt.com/docs/cloud (date not determined; the page gives no container details).
- Vulnerability: command injection in the Codex cloud environment, reported by BeyondTrust 2026-03-30 [S] https://scour.ing/p/https:/blog.barrack.ai/openai-codex-command-injection-github-token/ (not verified with OpenAI).

### Cursor Cloud (formerly Background) Agents
- Repo clone, separate branch, push; environment from a snapshot / agent-led setup / Dockerfile in .cursor/environment.json; secrets injected at start; outbound domain restrictions; triggered from Slack, Linear, an @cursor comment, API. [P] https://cursor.com/docs/cloud-agent (date not determined). There is no prompt injection warning there. Merge rate, incidents: not stated. CVE-2026-26268 (bare-git RCE in Cursor) only [S] https://codex.danielvaughan.com/2026/05/02/spring-2026-ai-coding-agent-vulnerabilities-cursor-rce-comment-control-codex-cli-defence/

### Devin (Cognition)
- Marketing annual report: 67 % of PRs merged (34 % the previous year). Strong: clearly specified tasks of "4-8 hours for a junior", migrations, security fixes, first tests. Weak: unclear specification, changing the specification mid-task. [M, own data] https://cognition.com/blog/devin-annual-performance-review-2025 (2025-11-14). They do not publish architecture or identity (not found).

### Open SWE (LangChain)
- Original version: Manager/Planner/Programmer+Reviewer, Daytona sandbox, tools run outside the sandbox (keys are not in the sandbox), ability to send input at runtime. [P] https://blog.langchain.com/introducing-open-swe-an-open-source-asynchronous-coding-agent (2025-08)
- Current README: triggered from a GitHub issue/PR, Slack, Linear, plan; persistent sandbox per thread (LangSmith default, pluggable), installation GitHub App token, approval of detected git pushes (not of all writes), project "under active development, no external contributions, may break". [P] https://github.com/langchain-ai/open-swe (date not determined). Merge rates not stated.

### Anthropic Claude Code on the web
- Credentials (git, signing keys) are never in the sandbox; the git client has a scoped credential, the proxy verifies the request (push only to the assigned branch) and adds the real token. [P, own claim without audit] https://www.anthropic.com/engineering/claude-code-sandboxing (2025-10-20). User bugs around the proxy: [S] https://claudeissues.com/issue/57925-bug-claude-code-on-web-git-push-fails-local-git-proxy-missing-credential-bridge

### Coder Tasks
- Each task = its own Coder workspace; a GitHub Action starts the task after a `coder` label on an issue; they recommend a separate template with limited rights; the user's GitHub token is passed to the agent. [P] https://coder.com/docs/ai-coder/github-to-tasks. Warning in the documentation: Tasks are to be removed from v2.37 (2026-09-01) in favor of "Coder Agents" (see the docs version snippet; current state not verified).

### OpenHands
- Resolver: label `openhands` or @openhands on an issue → comment → PR only if the agent considers itself done (a missing PR = failure). [P] https://docs.all-hands.dev/usage/cloud/cloud-issue-resolver (date not determined). Resolver success rate not found.

### StrongDM "software factory" + Dan Shapiro + Simon Willison
- Rules: code is neither written nor reviewed by humans; "scenarios" = end-to-end user stories stored outside the repo (holdout, because tests in the repo can be rewritten or the agent bypasses them); a "satisfaction" metric instead of green CI; "Digital Twin Universe" = clones of Okta/Jira/Slack for testing; benchmark ≥ 1000 USD of tokens per engineer per day. They state that agents took shortcuts (e.g. return true) and that tests could be reward-hacked. Incidents not published. [P, own claims] https://factory.strongdm.ai/ (2026-02-06); Attractor is a repo with only a specification (3 markdown files).
- Simon Willison: the no-review rule is jarring, skeptical of 1000 USD/day (~20,000 USD/month/engineer), rates DTU as a strong idea. [S, commentary] https://simonwillison.net/2026/feb/7/software-factory/ (2026-02-07)
- Dan Shapiro: 5 levels, level 5 = "dark factory", no quantitative data, "small teams are already doing it" is an anecdote. [P, opinion essay] https://www.danshapiro.com/blog/2026/01/the-five-levels-from-spicy-autocomplete-to-the-software-factory/ (2026-01-23)
- Criticism on accountability: [S] https://law.stanford.edu/2026/02/08/built-by-agents-tested-by-agents-trusted-by-whom/ (2026-02-08)

### Others (secondary only)
- Cloudflare (131,246 review runs, ~1.19 USD/run), Coinbase Forge, Harvey, Browserbase (a proxy keeps most credentials away from the agent): [S] https://rywalker.com/research/in-house-coding-agents. The author himself warns about selection bias and an unverified Coinbase demo.
- Forgejo specifically: the closest project found is a sandboxed OpenCode bot for Forgejo, read-only token, the agent cannot push or merge, triggered by a comment (not a label): [S, README not read] https://git.pleroma.social/opencode-beta/opencode-forgejo-bot

### Not found
Factory.ai (only press releases and funding, no architecture/merge rate), Sweep (nothing usable), Sourcegraph (nothing usable), primary Shopify and Uber blogs, merge rates at Stripe, Spotify, Ramp, Shopify, Cursor, Codex, any published incidents of production factories (apart from the security vulnerabilities below).

## 2. Security incidents (all [S], verify with vendors)
Prompt injection through issue/comment content against agents in CI/cloud: Clinejection (issue title), Comment and Control (hidden HTML comment in an issue against the Copilot agent), GitLost (2026-07), Snowflake Cortex (CVE-2026-6442). Common conclusion of the sources: prompt defenses are not enough, scoped tokens and network isolation help. https://labs.cloudsecurityalliance.org/research/csa-research-note-clinejection-prompt-injection-cicd-cache-p/ ; https://codex.danielvaughan.com/2026/05/02/spring-2026-ai-coding-agent-vulnerabilities-cursor-rce-comment-control-codex-cli-defence/

## 3. Assessment of our design (judgment, not a source)

Agreement with practice (good): sandbox per task (Stripe, Ramp, Open SWE, Coder); credentials and push outside the agent (Spotify Part 3, Anthropic, Shopify [S]); trigger by label (Coder, OpenHands); human PR review (Stripe, Ramp). Your "patch only goes out" is stricter than anything I found; nobody describes exactly this variant.

What others do differently:
- The agent runs with a full dev environment (services, DB, build) and is validated inside the loop: lint/tests before the push (Stripe <5 s, Spotify verifiers with a stop hook). You omit validation.
- A limited number of CI rounds (Stripe max 2) and then handover to a human.
- Pre-warmed/snapshotted environment (Stripe 10 s, Ramp 30-min snapshot). Unnecessary for our PoC.
- Rules/instructions in the repo per directory (Stripe), setup instructions (dotnet: 38 % → 69 %).
- PR author: Ramp deliberately makes a human the author so that they cannot approve their own PR.
- Orchestration is deterministic code with agentic steps (Stripe blueprints), not just "run the agent".

What we are missing (based on the evidence):
1. Independent validation after the patch is applied. It need not be outside the sandbox itself: it is enough that the PR runs CI on Forgejo (or the orchestrator runs the tests in a clean clone). Reason: Spotify (worst failure = passed but wrong), StrongDM (the agent takes shortcuts and bypasses tests).
2. Repo context / setup instructions: the dotnet data show the largest single jump in success rate (observationally). "We are not dealing with it yet" is fine, but expect a low merge rate until it exists.
3. A check on who may trigger (both the label and the /factory comment) and that issue content is untrusted input (Clinejection, Comment and Control). Without it the webhook is an entry point for prompt injection.
4. A patch filter before applying: forbid changes to `.forgejo/workflows/`, git hooks, `.gitmodules`, symlinks, mode changes, binaries/too-large diffs; `git apply --check`. A patch from the agent is untrusted input even though the sandbox is isolated.
5. Sandbox restrictions: no git credentials, network only to the LLM API (or a proxy; do not leave the secret model key in the sandbox), time and token cap, cleanup. Cursor/Codex have network allowlists, Spotify "almost no outside access".
6. Idempotency and a lock (the same label twice, two /factory at once on one branch) and task state; even without queues at least a lock per PR. Ramp queues follow-ups.
7. An iteration cap and a stop condition (Stripe 2 CI rounds; Devin degrades when the task changes, [M]).
8. Run logs/traces and a basic metric (merged / closed / abandoned). Without it you cannot tell whether the PoC works; dotnet shows that 44 % of closed PRs were abandoned drafts.

What is unnecessary (for the PoC): warm pools and snapshots, a multi-agent planner/reviewer, an LLM judge (Spotify does not even have it evaluated), an MCP tool catalog, Slack/multiplayer, digital twins, "dark" without review. Also there is no point in copying StrongDM without review: it is an opinion/marketing result with no published incidents or data.

What is wrong or risky in the design:
- "Git patch only" loses the agent's artifacts and signal (test log, why it failed). At least a log/summary must be returned into the PR comment; otherwise a /factory iteration has nothing to build on. Generate the patch with `git diff --binary` against a known base commit and pin the base (otherwise conflicts during iteration).
- The `factory-bot` identity as both author and pusher: if the same account can approve or merge, you lose the separation (Ramp solves it the opposite way). Minimum: branch protection, the bot must not approve or merge, require human approval.
- "Validation only in the sandbox" means the agent grades itself; that is exactly the pattern both Spotify and StrongDM warn about.
- Iteration through a comment: it must not be "continue in the running sandbox"; safer is a new sandbox from the current branch + the comments as input (Devin has a documented problem with a changed task mid-run, Ramp queues follow-ups and snapshots after the run). This is a recommendation, not a documented fact about their success.

## 4. Source mismatches (summary)
- Ramp share of PRs: 30 % / ~50 % / >50 % / 75 % (see above).
- Stripe: 1000+ → 1300+ per week (two dates, not a dispute); Toolshed 400+ vs ~500 (Part 1 vs Part 2).
- Copilot/dotnet: 61 % vs 67.9 % is a difference in denominator; 67.9 % is from the primary source.
- Devin 67 % merge is its own marketing number; dotnet CCA 67.9 % is independent, but on a different population of tasks (tasks are chosen by humans).
- StrongDM "1000 USD" without "per day" in one search-engine summary; the primary page and Simon say per engineer per day.
- Shopify, Uber: aggregators only, their numbers without methodology, and the Port page is internally inconsistent.
