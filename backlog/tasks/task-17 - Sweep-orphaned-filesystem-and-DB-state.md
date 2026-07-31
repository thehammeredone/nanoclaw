---
id: TASK-17
title: Sweep orphaned filesystem and DB state
status: To Do
assignee: []
created_date: '2026-07-31 03:19'
labels:
  - hygiene
dependencies: []
references:
  - docs/state-discovery.md
priority: low
ordinal: 17000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Loose ends found while mapping the decommission. None of these are caused by it -- they are pre-existing drift that the same sweep should catch.

Filesystem with no DB row:
  groups/main/ -- CLAUDE.md + CLAUDE.local.md, no agent_groups row has folder='main'. Origin unknown; decide whether it is a template worth keeping or dead weight.
  data/v2-sessions/103c34dd-8610-4bd6-9fa0-b9b98f79941d/ -- session directory for local-qwen3.6 with NO sessions row in the central DB. A DB-driven sweep will never find it. Check for others.

Messaging groups with no wiring: after TASK-8 and TASK-12 land, discord 2f7de85e-e40d-4dbb-8ef2-c64639b94384 (#skylight) and cli mg-1779227551244-r6tvmp (Local CLI) both drop to zero wired agents. Decide delete-or-keep for each and then sweep for any others.

unregistered_senders -- 5 rows, the dropped-message cache:
  discord:1507060501665022012 x3 with NULL agent_group_id, x1 against Aurora
  matrix:@aurora:thehammeredone.ddns.net x1 with NULL agent_group_id (Aurora's own bot account being seen as an unknown sender -- worth understanding, not just clearing)
Decide whether this table needs any retention policy at all.

Detection queries are in docs/state-discovery.md under "Orphan detection".
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 groups/main resolved — kept with a stated purpose or deleted
- [ ] #2 Session directories with no sessions row identified and removed
- [ ] #3 Messaging groups with no wiring resolved
- [ ] #4 unregistered_senders reviewed; the matrix:@aurora self-sender entry explained
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Provenance: Claude Code session 9934a222-4185-48a6-8de2-07b8bbe71cf7 (2026-07-30). Discovery data: docs/work-records/2026-07-30-decommission-planning-aurora-discord-wiring-and-four-agent-groups.md and docs/state-discovery.md
<!-- SECTION:NOTES:END -->
