---
id: TASK-10
title: Decommission the Memory agent group including its wiki
status: To Do
assignee: []
created_date: '2026-07-31 02:50'
updated_date: '2026-07-31 03:18'
labels:
  - memory
dependencies:
  - TASK-9
references:
  - scripts/delete-cli-agent.ts
  - docs/db-central.md
priority: medium
ordinal: 10000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Delete the Memory agent group outright. Hammer confirmed the wiki and files go too -- no archive, no export.

  agent group:  f09aa5a1-bea7-410a-a319-f20da1549703  "Memory"
  folder:       groups/memory/ (84K)
                  wiki/index.md, wiki/log.md
                  wiki/insights/ (4 files), wiki/lessons/ (1), wiki/behaviors/mjollnir.md
                  plans/agent-usage-dashboard.md, sources/ (empty)
                  CLAUDE.md, CLAUDE.local.md, .claude-shared.md, .claude-fragments/, container.json
  session:      sess-1779408615722-vkahs4 -- messaging_group_id is NULL. Memory was never wired to a
                channel; it only ever existed as an agent-to-agent destination.
  session dir:  data/v2-sessions/f09aa5a1-bea7-410a-a319-f20da1549703/
  container_config row (ON DELETE CASCADE, so it goes automatically)
  OneCLI agent: 48d0d710-48a6-424c-8cbf-c42d98ff0bdd  identifier f09aa5a1-...
  No per-group docker image tag exists for this group.
  No wirings, no members, no roles scoped to it.

Tooling: pnpm exec tsx scripts/delete-cli-agent.ts --folder memory does the right thing for the group
itself -- it sweeps every table carrying an agent_group_id column, deletes the agent_groups row, and
removes both groups/memory/ and the session dir. Despite the name it is not specific to the CLI agent.

It does NOT handle: the inbound references in TASK-9, or the OneCLI agent. Do TASK-9 first.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 agent_groups row and every dependent row for f09aa5a1 removed
- [ ] #2 groups/memory/ and data/v2-sessions/f09aa5a1-.../ deleted from disk
- [ ] #3 OneCLI agent 48d0d710 deleted along with its secret assignments
- [ ] #4 No surviving agent references memory as a destination
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Provenance: Claude Code session 9934a222-4185-48a6-8de2-07b8bbe71cf7 (2026-07-30). Discovery data and reasoning: docs/work-records/2026-07-30-decommission-planning-aurora-discord-wiring-and-four-agent-groups.md and docs/state-discovery.md
<!-- SECTION:NOTES:END -->
