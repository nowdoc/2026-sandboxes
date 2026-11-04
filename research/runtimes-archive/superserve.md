# Superserve (repo main, 2026-11)

**Verdict:** Blocked: only the client side is open source, the backend is a hosted service (api.superserve.ai), self-hosting is not possible.

Apache-2.0 (repo), requires an account and an API key (BRIEF forbids accounts), KVM not tried.

## Does not work
- The repo contains only SDKs (TS/Python), CLI, a Next.js console (Supabase auth, billing), MCP, docs; no control plane, no Firecracker orchestrator and no installer.
- README/CONTRIBUTING have no self-hosting. The SDK points at https://api.superserve.ai, `SUPERSERVE_API_KEY` (ss_live_...); `SUPERSERVE_BASE_URL` can be overridden, but there is no server.

## Not tested
- Everything (tests 1-10). Source only a reading of the README and the repo tree github.com/superserve-ai/superserve, nothing downloaded or installed. Secrets with per-host rules only from docs (read), only from the console.
