---
id: TASK-8
title: Kill Aurora's Discord wiring and retire the skylight sessions
status: To Do
assignee: []
created_date: '2026-07-31 02:49'
updated_date: '2026-07-31 03:18'
labels:
  - cleanup
dependencies:
  - TASK-7
references:
  - docs/isolation-model.md
  - src/cli/resources/sessions.ts
priority: high
ordinal: 8000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Remove Aurora's Discord attachment. Aurora KEEPS both Matrix wirings and both Matrix destinations -- this is Discord-only.

To remove:
  wiring f75dc4b4-b9ef-4d60-b9f8-af1abcea85f2
    Aurora (ag-1782273071167-th1q6f) <-> messaging group 2f7de85e-e40d-4dbb-8ef2-c64639b94384 "#skylight"
    discord:1507061415775834204:1519379363689267303, per-thread / pattern "."

  sessions on that messaging group (all three under data/v2-sessions/ag-1782273071167-th1q6f/):
    sess-1782319186963-b2yjgn  channel-level  <- holds the morning-report schedule, see TASK-7
    sess-1782785033830-whzaig  thread 1521335440052064457
    sess-1783527491016-ah2yj4  thread 1524449528068178003

To keep:
  wiring 35671fb9-... matrix @hammer DM
  wiring 95b041ba-... matrix Ann DM
  destinations hammer + ann (both matrix)
  sess-1783609624398-smn6q9 (matrix)

Sequencing notes:
- ncl wirings delete handles the wiring row, but sessions is a read-only ncl resource (list/get only, src/cli/resources/sessions.ts:45). sessions.agent_group_id and .messaging_group_id are real FKs with foreign_keys=ON, so the session rows need raw SQL or the tool from TASK-14.
- Kill any running containers for those sessions before deleting rows.
- Session dirs on disk each carry a ~100MB Skylight venv (TASK-6); reclaiming that is a side benefit.
- messaging group 2f7de85e-... will have no agents wired once f75dc4b4 is gone. Decide: delete it, or leave it and let unknown_sender_policy drop stray #skylight traffic. Deleting is cleaner unless another agent is meant to take over the channel.
- There is one stale pending_channel_approvals row (2026-07-09) for Aurora on the Matrix messaging group whose options_json still enumerates every agent group, including the ones being deleted. Clear it as part of this work.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Wiring f75dc4b4 deleted; Aurora no longer receives Discord messages
- [ ] #2 All three Discord-attached Aurora sessions removed from the DB and from data/v2-sessions/
- [ ] #3 Both Matrix wirings and both Matrix destinations still work after the change (verified with a live message)
- [ ] #4 Decision recorded on whether messaging group 2f7de85e is deleted or left orphaned
- [ ] #5 Stale pending_channel_approvals row cleared
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Provenance: Claude Code session 9934a222-4185-48a6-8de2-07b8bbe71cf7 (2026-07-30). Discovery data and reasoning: docs/work-records/2026-07-30-decommission-planning-aurora-discord-wiring-and-four-agent-groups.md and docs/state-discovery.md
<!-- SECTION:NOTES:END -->
