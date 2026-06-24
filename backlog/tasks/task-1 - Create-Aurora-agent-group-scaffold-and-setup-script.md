---
id: TASK-1
title: Create Aurora agent group scaffold and setup script
status: To Do
assignee: []
created_date: '2026-06-24 03:47'
labels:
  - setup
  - skylight
  - aurora
dependencies: []
priority: high
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Create the skylight-morning agent group in nanoclaw-v2. Aurora is a morning briefing assistant powered by the Skylight MCP. This task creates the setup script (scripts/setup-aurora-agent.ts) that idempotently provisions the agent group in the central DB with the Skylight MCP server configured, and seeds the group filesystem at groups/skylight-morning/. The Skylight MCP token is already captured at ~/.config/skylight/token.env and config.env (SKYLIGHT_FRAME_ID=3964300, SKYLIGHT_AUTH_SCHEME=bearer). The host is running (systemctl active) so ncl is available.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 scripts/setup-aurora-agent.ts exists and compiles without TypeScript errors (pnpm exec tsc --noEmit)
- [ ] #2 Script creates agent group named 'Aurora' with folder 'skylight-morning' in the DB (idempotent — uses get-or-create pattern)
- [ ] #3 Script configures Skylight MCP server in the container config using the bash -lc pattern: bash -lc 'source ~/.config/skylight/config.env 2>/dev/null; source ~/.config/skylight/token.env 2>/dev/null; exec uv run python -m server' with cwd /home/hammer/git/Skylight
- [ ] #4 groups/skylight-morning/ directory exists and is committed to git
- [ ] #5 groups/skylight-morning/CLAUDE.local.md exists (may be seeded with placeholder — full content is Task 2)
<!-- AC:END -->
