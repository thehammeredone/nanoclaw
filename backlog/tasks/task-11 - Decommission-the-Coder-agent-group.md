---
id: TASK-11
title: Decommission the Coder agent group
status: To Do
assignee: []
created_date: '2026-07-31 02:50'
updated_date: '2026-07-31 03:18'
labels:
  - coder
dependencies:
  - TASK-9
references:
  - scripts/delete-cli-agent.ts
priority: medium
ordinal: 11000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
agent group:  54c8dbdf-7703-4567-801c-da5a830cb7fd  "Coder"
  folder:       groups/coder/ (20K -- CLAUDE.md, CLAUDE.local.md, .claude-shared.md, .claude-fragments/, container.json)
  session:      sess-1779715155692-4dh4dv -- messaging_group_id NULL, agent-to-agent only, never channel-wired
  session dir:  data/v2-sessions/54c8dbdf-7703-4567-801c-da5a830cb7fd/
  container_config: provider = opencode (the only row in container_configs with a non-null provider)
  OneCLI agent: c982a432-fbc5-4b76-83f2-f0f9262e9828  identifier ag-54c8dbdf-...
  Inbound reference: Mjollnir's "coder" destination -- handled by TASK-9.
  No per-group docker image tag, no wirings, no members.

Same tool as TASK-10: pnpm exec tsx scripts/delete-cli-agent.ts --folder coder.

DECIDED (Hammer, 2026-07-30): the opencode provider install STAYS. Coder is its only current consumer,
but the local-model and coding-agent ideas are being revisited in a different form later. Do not remove
src/providers/ opencode support or anything installed by /add-opencode as part of this teardown.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 agent_groups row and every dependent row for 54c8dbdf removed
- [ ] #2 groups/coder/ and data/v2-sessions/54c8dbdf-.../ deleted from disk
- [ ] #3 OneCLI agent c982a432 deleted along with its secret assignments
- [ ] #4 opencode provider install left intact (decided 2026-07-30 — revisit planned)
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Provenance: Claude Code session 9934a222-4185-48a6-8de2-07b8bbe71cf7 (2026-07-30). Discovery data and reasoning: docs/work-records/2026-07-30-decommission-planning-aurora-discord-wiring-and-four-agent-groups.md and docs/state-discovery.md
<!-- SECTION:NOTES:END -->
