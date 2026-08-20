---
id: TASK-7
title: Move Aurora morning-report schedule off the Discord session
status: In Progress
assignee:
  - '@orchestrator'
created_date: '2026-07-31 02:49'
updated_date: '2026-08-20 23:17'
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
AMENDED 2026-08-20 (session 9bcadaf6-3351-4862-8bee-85cc8b8f9834). Two corrections and an urgency change.

CORRECTION -- the delivery premise in the description is wrong. This task implies the brief is posting OUTBOUND to Discord #skylight. It is not, and never was. Session b2yjgn's destinations table contains exactly two rows:
  ann    | channel | matrix | matrix:@ann:thehammeredone.ddns.net
  hammer | channel | matrix | matrix:@hammer:thehammeredone.ddns.net
Both Matrix. Discord is only the INBOUND wiring and the session's routing identity. So the reports have been reaching Matrix correctly this whole time. Moving the schedule is about ownership and surviving TASK-8's teardown -- NOT about fixing a misdelivered report. AC#1 still stands; the reasoning behind it changes.

The host-sweep point in the description remains correct and load-bearing: host-sweep iterates getActiveSessions() and never consults messaging_group_agents, so deleting the wiring alone leaves the schedule firing.

URGENCY -- this is now an active outage, not hygiene. b2yjgn's Skylight venv is broken (see TASK-5); every report since 2026-08-16 has been degraded. Moving the schedule to the Matrix session sess-1783609624398-smn6q9, whose venv is intact, RESOLVES THE OUTAGE as a side effect. That makes this the fastest path back to working reports and it should run before TASK-5's permanent guard fix.

INTERACTION with TASK-22 -- once scheduled tasks run on fresh SDK sessions, recreating this schedule is also the moment the frozen-prompt problem stops mattering as much, but the recurrence content is still copied verbatim by insertRecurrence. Write the new schedule's prompt to defer entirely to CLAUDE.local.md (the current one already does) and keep credentials out of it per AC#4 / TASK-19.
<!-- SECTION:NOTES:END -->
