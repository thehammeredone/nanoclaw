---
sid: fa20d2b7-69d3-458c-a971-2594a2d83a21
pwd: /home/hammer/git/nanoclaw-v2
model: Sonnet 4.6
date: 2026-06-29
tags: [work-record]
---

# Work Record — Skylight MCP auth redesign planning

## Purpose / Intent of the session

Continued from a prior context window (same sid) that set up Aurora's Discord wiring and attempted to mount `~/.config/skylight` into the Aurora container writably. The mount never surfaced correctly. The user pivoted: instead of fixing the mount, redesign the whole Skylight MCP auth model to eliminate the tangled credential paths (static token env var + credentials file + mounted config dir + symlink hack) and converge on one clean flow — credentials via env vars only → `authenticate` tool captures + caches a token → `token.env` is the sole cross-session persistence mechanism.

## Major steps taken

1. Reviewed all relevant Skylight source: `server/config.py` (env-wins-then-file `_get`), `server/tools/__init__.py` (confirmed `authenticate` reads `credentials.env` file, not env), `server/token_capture.py` (`read_credentials_file`, `write_env_file`).
2. Confirmed the core conflict: `SKYLIGHT_TOKEN` baked as a static env var always shadows any freshly cached `token.env`, so `authenticate` refresh never sticks across sessions.
3. Confirmed `load_settings()` is called per tool call — `os.environ` injection in `authenticate` takes effect mid-session without restart.
4. Queried live Aurora DB config — confirmed static SKYLIGHT_TOKEN/AUTH_SCHEME env vars and `skylight-config` writable mount + symlink are all currently live.
5. Resolved two open design questions with the user: (a) 401 handling = manual (agent calls `authenticate`, retries); (b) Claude Code credentials go in user-scoped `~/.claude.json`, not git-tracked `.mcp.json`.
6. Wrote and got approval for the full implementation plan in `/home/hammer/.claude/plans/glittery-sprouting-sketch.md` (overwrote stale Matrix plan).
7. Wrote `docs/runbooks/skylight-mcp-auth-redesign-resume.md` with exact diffs, commands, and verification steps.
8. Started grepping test references to `read_credentials_file` when user paused for runbook + work record.

## Major outcomes

- Approved implementation plan at `/home/hammer/.claude/plans/glittery-sprouting-sketch.md` — all three user requirements encoded, both consumers (Claude Code + NanoClaw container) covered.
- Runbook at `docs/runbooks/skylight-mcp-auth-redesign-resume.md` — sufficient to pick up cold with zero session context.
- No code changes this session (pure planning).

## Artifacts

### Git commits

No commits this session. Repo is at `6f630e35` from prior sessions.

Remote: `https://github.com/nanocoai/nanoclaw.git`

Most recent relevant commits (prior sessions):

| Hash | Summary |
|------|---------|
| `6f630e35ebd1b2f49e4a4a83838f13adc9fd6bab` | Merge branch 'task-3-create-aurora-decisions-and-assumptions-audit-log' (task 3) |
| `4d196e0e2f2aead0ed5a380138e75ce5522298be` | docs: add Aurora decisions and assumptions audit log |
| `237cc78ef26faf94d55be9048cb4a51d71287558` | feat: write Aurora morning report instructions |
| `e321ea882d1e266792d0498389de6c292b16c23c` | fix: use python venv + relative mounts + env-var token for Skylight MCP |
| `6a85bc0dcb5b755e1a2cb227fc13027b0a658dee` | feat: add Aurora agent group scaffold and setup script |

### Uncommitted changes

```
M groups/skylight-morning/CLAUDE.local.md
```

### Other artifacts

- `/home/hammer/.claude/plans/glittery-sprouting-sketch.md` — approved implementation plan (overwrote stale Matrix plan)
- `docs/runbooks/skylight-mcp-auth-redesign-resume.md` — resume runbook (this session)
- Live DB (not in git): Aurora wired to Discord `#skylight` (wiring `f75dc4b4-b9ef-4d60-b9f8-af1abcea85f2`, pattern/`.`/per-thread) — from prior session

## Rejections, negations & lessons learned

- **Mounting `~/.config/skylight` writable into the container** — attempted via a `skylight-config` mount + symlink in prior context window. Never surfaced at `/home/node/.config/skylight` inside the container. Root cause not debugged; user decided to eliminate the approach entirely in favor of env-var credentials. Lesson: env-only credentials are cleaner and more portable than file-mount secrets for MCP servers.
- **Static `SKYLIGHT_TOKEN` in env var** — the original workaround for the missing mount. Works for the first session but token refresh via `authenticate` never sticks because the static env var always overrides `token.env` in the next session. This is the core bug the redesign fixes.
- **Matrix homeserver plan** — paused/blocked from a prior session on WAN DNS/port-forward (Windows side). Still valid; runbook at `docs/runbooks/matrix-homeserver-resume.md`. Plan file was overwritten by this session's auth plan.
