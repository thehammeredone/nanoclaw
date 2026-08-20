---
id: TASK-7
title: Move Aurora morning-report schedule off the Discord session
status: Done
assignee:
  - '@orchestrator'
created_date: '2026-07-31 02:49'
updated_date: '2026-08-20 23:18'
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
- [x] #1 Morning brief runs from a session that survives Discord teardown (Matrix-routed)
- [x] #2 Verified firing end to end at least once, with real Skylight data
- [x] #3 Old recurring row and its series removed from the Discord session so the brief cannot double-post
- [x] #4 Skylight credentials no longer stored in plaintext in the scheduled prompt
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

RESOLVED 2026-08-20 (orchestrator session fe8a8e37). Live DB migration; no repo diff.

MIGRATION. The recurring brief now lives in the Matrix session:
  session   sess-1783609624398-smn6q9   (matrix @hammer DM, survives TASK-8 teardown)
  id        task-1787267541212-gro4qg   seq 36 (even = host parity)
  series_id task-1787267541212-gro4qg   (= own id, exactly what insertTask() does,
                                          src/modules/scheduling/db.ts:35)
  recurrence '0 6 * * *'   process_after 2026-08-21T10:00:00.000Z
  channel_type matrix   platform_id matrix:@hammer:...   thread_id NULL
TZ=America/New_York, EDT=UTC-4, so 10:00Z is 06:00 local. thread_id NULL matches the
session's current convention (older rows carried a room id).

The old pending row task-1787220068470-qnbqee was deleted from
sess-1782319186963-b2yjgn. Note its id had ROTATED from the one named in this task's
description -- insertRecurrence mints a new row id per firing under the same series_id.
The 38 completed rows were left as history: they all have recurrence IS NULL and
getCompletedRecurring() only clones rows where recurrence IS NOT NULL, so they are inert.
TASK-8 deletes the session anyway.

VERIFIED NO DOUBLE-POST. Across all four Aurora sessions, exactly ONE row can fire:
  b2yjgn 0, whzaig 0, ah2yj4 0, smn6q9 1.

AC#4 WAS ALREADY SATISFIED before this task ran -- the scheduled prompt contains no
credentials (LIKE scans for SKYLIGHT / @gmail.com / assword / token / Bearer all return 0)
and defers entirely to CLAUDE.local.md. A previous session had already fixed it. Nothing
changed. Moving credentials into the OneCLI vault remains TASK-19.

AC#2 verified with a real firing at 23:12Z: a one-off task row produced a genuine report
with 16 named chores carrying individually-resolved overdue dates, two calendar events with
per-event attendee lists, and live weather. NOT the empty-state failure signature the
runbook warns about. The Skylight MCP started clean off the healthy sentinelled venv (no
provisioning output, which is the correct healthy-venv path after TASK-5).

FINDING -- ANN HAS NEVER RECEIVED A REPORT. messages_out across all four Aurora sessions
contains ZERO rows to matrix:@ann:thehammeredone.ddns.net, ever. Delivery history:
  b2yjgn   discord 101 rows (to 2026-07-16), then matrix @hammer 99 rows (from 2026-07-17)
  ah2yj4   discord 8 rows
  smn6q9   matrix @hammer 30 rows
The 'ann' destination row exists in both sessions' destinations tables, but CLAUDE.local.md
never instructs the agent to send to her, so it never has. This contradicts TASK-8's premise
('Aurora KEEPS both Matrix wirings and both Matrix destinations') and the 2026-08-20 work
record's claim that the cron delivered to 'hammer + ann'. Relevant to TASK-23 (Ann's clone)
and TASK-8. The verification run was deliberately scoped to Hammer only regardless.

REVIEW NOTE: spec compliance was verified by the orchestrator directly against live DB
state (primary evidence) rather than delegated. The code-quality gate did not run because
this task produced no repo diff -- there is nothing for code-review to read.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved Aurora's daily 06:00 brief from the Discord-wired session sess-1782319186963-b2yjgn to the Matrix session sess-1783609624398-smn6q9, so it survives TASK-8's Discord teardown. New recurring row task-1787267541212-gro4qg with matrix routing and even (host-parity) seq; old pending row deleted and its series left inert. Verified exactly one firing row remains across all four Aurora sessions, so the brief cannot double-post. AC#2 verified with a real end-to-end firing returning genuine Skylight data (16 chores with resolved overdue dates, two calendar events, live weather) rather than the empty-state failure signature. AC#4 was already satisfied before this task. Found that Ann has never received an Aurora report from any session.
<!-- SECTION:FINAL_SUMMARY:END -->
