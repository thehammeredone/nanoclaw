---
id: TASK-6
title: >-
  Share Skylight venv and auth token across Aurora sessions instead of
  per-session
status: Needs Review
assignee: []
created_date: '2026-07-29 13:50'
updated_date: '2026-08-20 16:35'
labels:
  - aurora
  - skylight
  - infra
  - efficiency
dependencies: []
references:
  - docs/runbooks/aurora-skylight-mcp.md
priority: low
ordinal: 6000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found in Claude Code session 9631a530-018f-4442-9ef7-a9f840c12812 (2026-07-29). Runbook: docs/runbooks/aurora-skylight-mcp.md

The skylight MCP bootstrap writes into /workspace, which is the SESSION directory (data/v2-sessions/<group>/<session>/), not a group-level one. Two consequences, both currently live:

1. Duplicated venvs. Every Aurora session pip-installs its own ~100MB copy of the wheel and its deps. Four session dirs exist today, each with its own .skylight-venv-0.2.1; smn6q9 now also has 0.2.2. Old version dirs are never garbage-collected, so a wheel bump adds a venv rather than replacing one.

2. Duplicated auth. SKYLIGHT_TOKEN_ENV_PATH is /workspace/.skylight/token.env, so each session captures and stores its own Skylight token via a full headless-Chromium login. A token captured in one session does nothing for another. As of this session smn6q9 has a token from 2026-07-29 while b2yjgn - the session that actually produces the scheduled morning report - still holds one from 2026-07-21. Each session independently re-authenticates on 401, meaning more real logins against the live account than necessary.

A group-scoped mount shared across sessions would fix both. Check whether container_configs.additional_mounts can express that, or whether it needs host-side support in container-runner.ts. Consider whether concurrent sessions writing one token.env introduces a race - the file is written whole, so probably benign, but worth confirming.

Related: docs/isolation-model.md, src/session-manager.ts (mount/heartbeat paths), src/container-runner.ts.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Aurora sessions share one provisioned venv rather than one per session
- [ ] #2 A token captured by any Aurora session is usable by the others
- [ ] #3 Concurrent-write behavior on the shared token file is confirmed safe or guarded
- [ ] #4 Stale per-session venvs from the current layout are cleaned up
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
AMENDED 2026-08-20 (session 9bcadaf6-...). Partly re-scoped by two later decisions:

1. TASK-23 splits Ann onto her own agent group (1-to-1 agent<->destination). That INCREASES the duplication this task describes -- two agent groups, two container images, two venvs -- so shared provisioning gets more valuable, not less.

2. Current venv inventory on disk (Aurora, 2026-08-20): b2yjgn has .skylight-env, -venv-0.2.1, -0.2.2, -0.2.3 (four); smn6q9 has -0.2.1, -0.2.2, -0.2.3 (three); whzaig and ah2yj4 have -0.2.1 each. Nine venv trees total. TASK-8 deletes three of those sessions outright, reclaiming most of it, so sequence this AFTER TASK-8 to avoid optimising storage that is about to be deleted.

3. Token-sharing half of this task is now lower value: with TASK-23 splitting the groups, per-group tokens are arguably CORRECT (separate people, separate Skylight scoping) even if the venv should still be shared. Re-scope before starting: the venv and the token halves may want to split into separate tasks.
<!-- SECTION:NOTES:END -->
