---
id: TASK-9
title: Purge memory and coder references from the surviving agents
status: To Do
assignee: []
created_date: '2026-07-31 02:50'
updated_date: '2026-07-31 03:18'
labels:
  - aurora
dependencies: []
references:
  - docs/db-session.md
  - scripts/send-to-memory.ts
priority: high
ordinal: 9000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Must land before the Memory and Coder groups are actually deleted (TASK-10, TASK-11), otherwise the surviving agents keep calling destinations that no longer resolve.

Prose instructions in surviving groups:
- groups/dm-with-hammer/CLAUDE.local.md (Mjollnir) -- line ~11 says "Before responding to any message from Hammer, query memory for behavioral guidance. This is mandatory, not optional." Plus a full "## Memory Agent" section (~line 24) and coder references. Left in place, every single Mjollnir turn tries to send to a dead destination.
- groups/skylight-morning/CLAUDE.local.md (Aurora) -- "## Memory Agent" section at ~line 145 with the same mandatory pre-response query.

agent_destinations rows pointing AT the deleted groups. target_id has NO foreign key (it holds either a messaging group id or an agent group id), so these will not fail on delete and will not be caught by scripts/delete-cli-agent.ts -- that script only deletes rows where agent_group_id = the group being removed, i.e. outbound edges, never inbound ones:
  Mjollnir       ag-1779381936325-6ki38t  local_name "memory" -> f09aa5a1-...
  Mjollnir       ag-1779381936325-6ki38t  local_name "coder"  -> 54c8dbdf-...
  Terminal Agent ag-1779227551242-zf47au  local_name "memory" -> f09aa5a1-...

Mirrored per-session destinations tables inside each surviving session's inbound.db (host writes these; they are a copy of agent_destinations, see docs/db-session.md):
  12 Mjollnir sessions each list: assistant, coder, hammer, memory
  1 Terminal Agent session lists:  local-cli, memory
Confirm whether the host rewrites these on next spawn or whether they need a manual sweep.

Code:
- scripts/send-to-memory.ts hardcodes MEMORY_AGENT_GROUP_ID = 'f09aa5a1-bea7-410a-a319-f20da1549703'. Delete the script.

Also worth deciding: Mjollnir's behavioral profile currently lives in groups/memory/wiki/behaviors/mjollnir.md. If anything in it should outlive the wiki, it has to move into Mjollnir's own CLAUDE.local.md before TASK-10 deletes it.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Mjollnir CLAUDE.local.md no longer instructs querying memory or coder
- [ ] #2 Aurora CLAUDE.local.md Memory Agent section removed
- [ ] #3 All three inbound agent_destinations rows removed
- [ ] #4 Per-session destinations tables in surviving sessions no longer list memory or coder
- [ ] #5 scripts/send-to-memory.ts deleted
- [ ] #6 Anything worth keeping from wiki/behaviors/mjollnir.md moved into Mjollnir's own instructions, or explicitly dropped
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Provenance: Claude Code session 9934a222-4185-48a6-8de2-07b8bbe71cf7 (2026-07-30). Discovery data and reasoning: docs/work-records/2026-07-30-decommission-planning-aurora-discord-wiring-and-four-agent-groups.md and docs/state-discovery.md
<!-- SECTION:NOTES:END -->
