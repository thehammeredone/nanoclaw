---
id: TASK-19
title: Move Skylight credentials out of plaintext into the OneCLI vault
status: To Do
assignee: []
created_date: '2026-07-31 03:20'
labels:
  - skylight
dependencies: []
references:
  - docs/runbooks/aurora-skylight-mcp.md
priority: high
ordinal: 19000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The Skylight account email and password appear in plaintext in at least two places:

1. messages_in.content of the scheduled morning-brief row (session sess-1782319186963-b2yjgn). The prompt literally contains SKYLIGHT_EMAIL="..." SKYLIGHT_PASSWORD="..." as part of the shell command it tells the agent to run. Anything that dumps that row -- a debug query, a work record, a transcript -- leaks the account.
2. The Skylight MCP server's env block in container_configs, materialized to groups/skylight-morning/container.json at spawn.

Per project_aurora_agent memory, these have already been printed into session transcripts several times via .env reads, ps aux, and `ncl groups config get`.

This is exactly what the OneCLI vault exists for: secrets injected per request at the proxy, never in env vars and never in chat context (see the Secrets/Credentials section of CLAUDE.md). Skylight is the outlier.

Complication worth checking first: Skylight auth is a headless-Chromium login that produces a token, not a simple API key. Confirm the vault can hold the resulting token and that the capture flow can read credentials from the vault rather than from env, before committing to an approach.

TASK-7 rewrites the scheduled prompt anyway -- that is the natural moment to drop the credentials from it, whatever the longer-term storage answer turns out to be.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 No Skylight credentials in any messages_in row
- [ ] #2 No Skylight credentials in container_configs or a materialized container.json
- [ ] #3 Skylight auth works end to end through the vault, verified by a real morning report
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Provenance: Claude Code session 9934a222-4185-48a6-8de2-07b8bbe71cf7 (2026-07-30). Discovery data: docs/work-records/2026-07-30-decommission-planning-aurora-discord-wiring-and-four-agent-groups.md and docs/state-discovery.md
<!-- SECTION:NOTES:END -->
