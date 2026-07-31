---
id: TASK-15
title: 'Document nanoclaw state-discovery: what shifts, what doesn''t'
status: Done
assignee: []
created_date: '2026-07-31 03:15'
updated_date: '2026-07-31 03:20'
labels:
  - meta
dependencies: []
references:
  - docs/db-central.md
  - docs/db.md
  - scripts/q.ts
priority: high
ordinal: 15000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Session 9934a222-4185-48a6-8de2-07b8bbe71cf7 (2026-07-30) burned ~36 shell commands just to answer "what agent groups exist and what would deleting four of them touch". Most of that was rediscovering the shape of the install, not learning anything new. That cost should be paid once.

Two deliverables:

1. A discovery reference under docs/ that splits install state into two categories and treats them differently:
   - VOLATILE (changes between sessions) -> capture the CALL, not the answer. The exact query or command that produces current truth, with the gotchas that cost time this session: scripts/q.ts collapses duplicate column names in joins so alias every column; column names must be read from sqlite_master rather than guessed (folder not folder_name, process_after not due_at, container_configs has no config column).
   - STABLE (structural, rarely changes) -> capture the DATA inline. Which tables carry agent_group_id, which FKs cascade and which block, which references have no FK at all, the delete-order that follows from that, where per-group state lives on disk vs in the DB vs in the OneCLI vault.

2. A work record for this session via the work-record skill.

The test for whether this worked: the next session that needs the same picture should get there in a handful of commands, and should not re-learn the same gotchas.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Discovery doc exists under docs/ separating volatile state (commands captured) from stable state (data captured inline)
- [ ] #2 Every scripts/q.ts and schema gotcha hit this session is written down
- [ ] #3 Stable structural data — agent_group_id table list, FK cascade vs block behavior, no-FK references, teardown order, per-group state locations — recorded inline
- [ ] #4 Work record for session 9934a222 written to docs/work-records/
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Provenance: Claude Code session 9934a222-4185-48a6-8de2-07b8bbe71cf7 (2026-07-30). Discovery data and reasoning: docs/work-records/2026-07-30-decommission-planning-aurora-discord-wiring-and-four-agent-groups.md and docs/state-discovery.md
<!-- SECTION:NOTES:END -->
