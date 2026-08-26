---
id: TASK-26
title: Make the Skylight MCP bootstrap line a single source of truth
status: In Progress
assignee:
  - '@orchestrator'
created_date: '2026-08-20 23:07'
updated_date: '2026-08-26 18:23'
labels:
  - aurora
  - skylight
  - infra
  - tech-debt
dependencies: []
priority: medium
ordinal: 26000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found during TASK-5 (orchestrator session fe8a8e37, 2026-08-20). TASK-5's own description flagged this: 'this shell line lives in a DB column, not in any file under version control - anyone auditing the repo will not find it. That is arguably the deeper issue and may deserve its own task.'

After TASK-5 it is worse in one respect: the same ~1.5KB bash line now exists in THREE places that must be kept byte-identical by hand:

  1. container_configs.mcp_servers -> skylight.args[1] in data/v2.db   (authoritative, what runs)
  2. scripts/setup-aurora-agent.ts                                      (the seeder that writes it)
  3. docs/runbooks/aurora-skylight-mcp.md                               (quoted verbatim for operators)

They were verified in sync at TASK-5 merge time (73cbd113) and the runbook's Known-rough-edges section warns they must be synced by hand. That warning is not a mechanism.

Options to consider:
- Move the line into a version-controlled shell script under the read-only Skylight mount or a nanoclaw-owned path, and reduce the DB column to an invocation of it.
- Generate the DB value from the seeder at spawn/startup so the seeder is authoritative by construction.
- Add a startup check that compares the live column against the seeder's output and warns on drift.
- At minimum, a test that fails when the three copies diverge.

Note the constraint that shaped the current design: /workspace/extra/skylight is mounted READ-ONLY, so nothing can be written there, and the venv is per-session under /workspace.
<!-- SECTION:DESCRIPTION:END -->
