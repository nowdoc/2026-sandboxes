# API

The UI, the CLI (`yf`) and the management MCP server all use this one HTTP API on `:8080` (host `<host>:8090`). There is no login (the lab is behind a VPN). Requests that change anything must be `Content-Type: application/json` (a cross-site form cannot send it). Errors are `{ "error": "..." }`.

A **session** in the UI is a **run**: one prompt (or a terminal-only VM, or an inspect run) against one repository, with its VM, its branch and pull request, and the opencode session(s) it produced. Sessions belong to a repository.

## Runs
| Method and path | Purpose |
|---|---|
| `GET /api/runs?repo=<owner/repo>&limit=<n>` | runs, newest first, optionally of one repository (default limit 200) |
| `GET /api/runs/<id>` | one run |
| `POST /api/runs` `{repo, prompt?, model?, base?, keep?}` | start a run; no prompt = terminal-only VM (kept). `202` with the run |
| `POST /api/runs` `{repo, pr, kind?: "review"\|"revise", prompt?, model?}` | review of a pull request (default), or a revise run: the agent addresses the unresolved review threads and its commits are pushed to the head branch of the PR (no force; `422` for a PR from a fork) |
| `POST /api/runs/<id>/cancel` | cancel a queued or running run (`409` when it is already finished) |
| `POST /api/runs/<id>/publish` | push the run branch and open the pull request (only a `ready` run) |
| `POST /api/runs/<id>/destroy` | export the sessions and remove the VM |
| `GET /api/runs/<id>/transcript?n=<k>` | opencode session `k` (default 0) as exported JSON; live from the VM while it runs, from S3 afterwards. `404` when there is none yet |
| `GET /api/runs/<id>/log` | setup log (text) |
| `GET /api/runs/<id>/files?path=` and `/file?path=` | read-only tree and file of `/workspace` in the VM |
| `POST /api/runs/<id>/ide` | start VS Code in the VM; answers `{port, path}` |
| `GET /api/runs/<id>/terminal` | WebSocket to a shell in the VM (same-origin only) |
| `POST /api/runs/<id>/apply` `{part: "repository"\|"environment"}` | apply a part of an inspect proposal and start a verify run |

## Review and agent requests
What the VM sends through the actions API of the task API (actions in the yfactory source, `orchestrator/api/ACTIONS.md`) waits here for a person.

| Method and path | Purpose |
|---|---|
| `GET /api/runs/<id>/review` | review run: `{target, publish, review, status, error, progress, finish, questions, domains, followups, artifacts}`. `publish` is the repository's `reviewPublish` (`draft` or `auto`). `404` when the run is not a review |
| `PUT /api/runs/<id>/review/findings/<n>` `{body?, severity?, deleted?}` | change or delete a finding of the draft |
| `POST /api/runs/<id>/review/publish` `{verdict?, summary?}` | post the draft as one review (`409` when already published) |
| `GET /api/runs/<id>/actions` | any run: `{kind, status, capabilities, count, progress, finish, questions, requests, artifacts, events}`; `requests` are `comment`, `thread_resolve`, `request_domain`, `propose_followup` with their `decision` once made |
| `POST /api/runs/<id>/actions/<action id>/decide` `{decision: "approve"\|"reject", note?}` | approve: post the comment or reply, resolve the thread, create the issue (a domain is only acknowledged, the allowlist stays by hand); `409` when already decided or the forge cannot do it, `502` when the forge refused. The VM gets an `action_result` event |
| `POST /api/runs/<id>/answer` `{question_id, option_id?, text?}` | answer a question of the agent (event `answer`) |

Run fields: `id, repo, base, branch, prompt, model, kind ("inspect"\|"verify"\|"review"\|"revise"\|absent), target (review and revise: the PR), requests (count of what waits for a person), actions (count of actions the VM sent), status ("queued"\|"running"\|"ready"\|"done"\|"failed"), vm, pr, error, sessions (S3 keys), environment, keep, proposal, applied, createdAt, startedAt, finishedAt` (times in ms). Secrets (`tokenHash`, `llmKey`) are never returned.

Transcript shape (opencode export): `{ info: {id, title, model, tokens, cost, time}, messages: [{ info: {role: "user"\|"assistant", time}, parts: [...] }] }`. Part types: `text {text}`, `reasoning {text}`, `tool {tool, state: {status, input, output, title, time}}`, `step-start`, `step-finish {tokens, cost}`.

## Repositories and environments
| Method and path | Purpose |
|---|---|
| `GET /api/repos` | `{repos, providers, models, environments}` |
| `PUT /api/repos` `{repo, provider, base, environment, model, models, setup, env, reviewPublish?}` | create or update a repository. `reviewPublish` is `auto` or, when omitted or anything else, `draft`. Fields not sent are stored as their defaults, so a partial update resets the ones left out |
| `DELETE /api/repos/<owner>/<repo>` | remove it |
| `POST /api/repos/<owner>/<repo>/inspect` `{model?}` | inspect run: the agent proposes repository and environment settings |
| `GET /api/environments`, `PUT /api/environments` `{name, setup, maintenance, env}`, `DELETE /api/environments/<name>` | environments |
| `GET /api/config` | read-only: providers (no tokens), models, limits (`maxRunning`, `maxVms`, `runTimeout`) |

Repository fields added for the UI: `model` (default model of new sessions, `null` = first available), `models` (models a session may use, `[]` = all) and `reviewPublish` (`draft`: findings wait in the UI; `auto`: the agent's review is posted when the run submits, and that post never approves). The MCP tool `put_repository` does not take `reviewPublish`, so a repository saved through it stays `draft`.

## Other
`GET /health`, `GET /metrics`.

## MCP
`POST /mcp` on the same port is a management MCP server (streamable HTTP, JSON responses). Its tools are thin wrappers of the endpoints above, so everything the UI does an agent can do: `list_repositories`, `put_repository`, `delete_repository`, `inspect_repository`, `list_environments`, `put_environment`, `delete_environment`, `create_session`, `list_sessions`, `get_session`, `get_transcript`, `cancel_session`, `publish_session`, `delete_session_vm`, `apply_proposal`, `review_pull_request`, `revise_pull_request`, `get_review`, `edit_finding`, `publish_review`, `get_actions`, `decide_action`, `answer_question`, `get_config`, `health`. Requests carrying an `Origin` header of another host are rejected, so a web page cannot drive it. Client configuration: `{"type": "http", "url": "http://<host>:8090/mcp"}`.
