# Sandbox actions

The VM tells the orchestrator what it needs or wants to do through one small API on the task API (`:9001`, run token, same as git and LLM routes). The VM only proposes; the orchestrator validates, stages, publishes and holds every credential. Schema: [actions.schema.json](actions.schema.json), examples (valid and invalid): [examples.json](examples.json).

| Endpoint | Direction | Body |
|---|---|---|
| `GET /yf/context` | orchestrator → VM | `Context`: run kind, input (ticket or PR with threads), allowed action types, limits |
| `POST /yf/actions` | VM → orchestrator | one `Action`, answered with `ActionResult` |
| `GET /yf/events?after=<seq>&wait=<s>` | orchestrator → VM | `Event[]`, long poll up to 30 s |

The VM always initiates; there is no inbound connection to the VM. Events cover everything the orchestrator has to say later: a person answered, a new comment arrived, the PR head moved, the run was cancelled.

## Actions

| Type | Purpose | Effect |
|---|---|---|
| `comment` | general comment or reply on a PR or ticket | review: part of the draft; other runs: a person approves, then it is posted (a reply in the thread on GitHub and GitLab) |
| `review_comment` | inline finding (path, line, severity, category, suggestion) | staged, anchor checked against the diff |
| `review_submit` | verdict and summary, once per run | publishes the staged findings as one review |
| `thread_resolve` | proposes closing a review thread | a person approves, then the thread is resolved (GitHub, GitLab; Forgejo has no API for it) |
| `progress` | phase and message for the UI | none outside the orchestrator |
| `artifact` | named result kept with the run (inline or pulled from the VM) | stored in S3 with the run |
| `finish` | outcome, summary, proposed PR title and body | ends the agent part, the orchestrator runs its own checks |
| `question` | asks a person, answer comes as an `answer` event | blocks only the agent, not the orchestrator |
| `fetch_context` | read-only query: PR, comments, CI, ticket, file at ref, Slack thread | data in `ActionResult.result`, sanitized and capped |
| `request_domain` | asks for egress allowlist entries | `pending` until a person decides; approving only acknowledges it, the allowlist is changed by an operator |
| `propose_environment` | environment and repository setup change (replaces `.yf-proposal.json`) | a person applies it |
| `propose_followup` | out-of-scope finding as a suggested ticket | an issue is created only when a person approves it |

## Allowed per run kind

`capabilities` in `Context` is the authoritative list; anything else is rejected with `not_allowed_for_kind`.

| Action | implement | review | revise | inspect | verify |
|---|---|---|---|---|---|
| `comment` | ticket only | ✅ | ✅ | | |
| `review_comment`, `review_submit` | | ✅ | | | |
| `thread_resolve` | | | ✅ | | |
| `progress` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `artifact` | ✅ | ✅ | ✅ | | ✅ |
| `finish` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `question` | ✅ | ✅ | ✅ | ✅ | |
| `fetch_context` | ✅ | ✅ | ✅ | | |
| `request_domain` | ✅ | | ✅ | ✅ | |
| `propose_environment` | | | | ✅ | |
| `propose_followup` | ✅ | ✅ | ✅ | | |

`review` has no git write access (the pre-receive hook rejects every push), so its only output is actions. `implement` and `revise` still deliver code by pushing `yfactory/<id>`; actions carry everything else.

## Rules

- **Idempotent.** `id` is chosen by the VM; a retry with the same id returns `duplicate` with the first result.
- **Rejected is not an error.** Every processed action gets HTTP 200. `rejected` carries `code` and `message` (for example `invalid_anchor: line 42 is not in the diff`), so the agent fixes the action in the same session instead of the run failing at the end.
- **Pending is not a failure.** `pending` means a person or policy decides. Whether comments publish at once or as a draft is orchestrator policy per repository, not part of the payload. The outcome arrives as an `action_result` event.
- **Everything in both directions is untrusted text.** Outgoing: images, external links, `@mentions` and secrets are stripped. Incoming events and `input` are marked `untrusted` and may contain a prompt injection.
- **Limits** come from `Context.limits` (actions per run, review comments, body size, artifact size); exceeding one gives `limit_exceeded`. Flooding gets HTTP 429.
- **No capability in the payload.** Which repository, which PR and which thread are fixed by the run token, so an action cannot address another run.

## Decisions of a person

`comment` (outside a review), `thread_resolve`, `request_domain` and `propose_followup` answer `pending` and wait. A person decides through the orchestrator API (`GET /api/runs/<id>/actions`, `POST /api/runs/<id>/actions/<action id>/decide {decision: "approve"|"reject", note?}`), the Requests tab of the UI or the MCP tool `decide_action`. Approving runs the effect first (post the comment, resolve the thread, create the issue); if the forge refuses, nothing is recorded and the person can try again. Each decision reaches the VM as an `action_result` event with the note of the person. Questions are answered with `POST /api/runs/<id>/answer` (event `answer`).

## Status

Implemented in `orchestrator/`: `schema.ts` (validator for this schema), `actions.ts` (rules, staging, decisions), `yf.ts` (the three endpoints), `review.ts` (agent prompts of review and revise, `yf-act` helper, the review as published), review and revise runs in `main.ts` (`POST /api/runs {repo, pr, kind?}`), the draft API (`GET /api/runs/<id>/review`, `PUT .../review/findings/<n>`, `POST .../review/publish`, `POST .../answer`), the actions API (`GET .../actions`, `POST .../actions/<id>/decide`), providers GitHub, Forgejo and GitLab in `services.ts` (review, comment, reply, resolve thread, issue), the Review and Requests tabs of the UI, MCP tools in `mcpadmin.ts`. Inspect runs send their proposal with `propose_environment` (the file `.yf-proposal.json` is the fallback). Tests in [`../../tests/`](../../tests/): `actions.test.ts` (unit, forge requests against a stub, real git, HTTP and `yf-act`) and `review_e2e.test.ts` (the orchestrator process from API to a published review, a revise run pushed to the PR branch, decisions, inspect, MCP).

Revise: `POST /api/runs {repo, pr, kind: "revise", prompt?}`. The VM clones the PR head, works on `yfactory/<id>` and may push only that branch to the run repository; the orchestrator checks the new commits like a new PR and pushes them to the head branch of the PR without force (refused if the PR moved). PRs from forks are refused (422).

Decided: review runs only read code (no setup scripts, no tests); draft in the UI is the default per repository (`reviewPublish`: `draft` or `auto`); an automatic publish never approves; nothing a revise or implement run asks for reaches the forge without a person.

Not done: triggers (webhook, `/review` comment); re-review of a new head (`head_changed`); an approved `request_domain` does not change the allowlist; MCP wrapper for the VM (the schema is the contract). The calls to GitHub, Forgejo and GitLab are checked against a stub that mirrors our understanding of their APIs, not against the real services.
