---
id: TASK-7
title: Move Aurora morning-report schedule off the Discord session
status: To Do
assignee: []
created_date: '2026-07-31 02:49'
updated_date: '2026-07-31 03:18'
labels:
  - blocker
dependencies: []
references:
  - docs/db-session.md
  - src/host-sweep.ts
priority: high
ordinal: 7000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Aurora's daily morning brief is a recurring row in messages_in of session sess-1782319186963-b2yjgn -- which is Aurora's DISCORD #skylight session, not a Matrix one.

  id:            task-1785405733284-una1i5
  series_id:     task-1783352195211-y4arce
  recurrence:    0 6 * * *
  process_after: 2026-07-31T10:00:00.000Z
  channel_type:  discord
  platform_id:   discord:1507061415775834204:1519379363689267303

Two facts make the ordering load-bearing:

1. host-sweep iterates getActiveSessions() (src/host-sweep.ts:136) and wakes any session with due messages. It never consults messaging_group_agents. So deleting the Discord wiring row alone stops INBOUND Discord messages while the schedule keeps firing and keeps posting OUTBOUND to #skylight. The wiring and the schedule are independent.

2. Aurora's Matrix session sess-1783609624398-smn6q9 has zero scheduled rows. Nothing carries the brief over automatically.

Separately: the scheduled prompt embeds the Skylight account email and password in plaintext inside messages_in.content. Recreating the schedule is the natural moment to source those from the OneCLI vault instead of the prompt body.

Related: TASK-6 already documents that b2yjgn is the session that produces the scheduled report and holds a stale (2026-07-21) Skylight token.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Morning brief runs from a session that survives Discord teardown (Matrix-routed)
- [ ] #2 Verified firing end to end at least once, with real Skylight data
- [ ] #3 Old recurring row and its series removed from the Discord session so the brief cannot double-post
- [ ] #4 Skylight credentials no longer stored in plaintext in the scheduled prompt
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Provenance: Claude Code session 9934a222-4185-48a6-8de2-07b8bbe71cf7 (2026-07-30). Discovery data and reasoning: docs/work-records/2026-07-30-decommission-planning-aurora-discord-wiring-and-four-agent-groups.md and docs/state-discovery.md
<!-- SECTION:NOTES:END -->
