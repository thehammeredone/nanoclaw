---
id: TASK-8
title: Kill Aurora's Discord wiring and retire the skylight sessions
status: To Do
assignee: []
created_date: '2026-07-31 02:49'
updated_date: '2026-08-20 22:30'
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
AMENDED 2026-08-20 (session 9bcadaf6-3351-4862-8bee-85cc8b8f9834).

SUPERSEDED: the description says 'Aurora KEEPS both Matrix wirings and both Matrix destinations.' The operator has since established a one-agent-group-per-destination rule. Aurora keeps ONLY the @hammer DM (wiring 35671fb9). Ann's DM (wiring 95b041ba) moves to a cloned agent group -- TASK-23, deferred until Aurora is fixed.

So the end state is:
  Aurora  ag-1782273071167-th1q6f  -> @hammer DM only, destinations: hammer
  new group (TASK-23)              -> @ann DM only,    destinations: ann

Sequencing: this task may still delete the Discord wiring and the three Discord sessions without waiting on TASK-23. Do NOT delete wiring 95b041ba here -- leave Ann pointed at Aurora until the clone exists, or Ann loses service in the gap. Dropping 'ann' from Aurora's destinations belongs to TASK-23, not here.

Confirmed still accurate on 2026-08-20: the three Discord sessions are b2yjgn (holds the cron), whzaig, ah2yj4; Ann has never had a session at all, so nothing of hers is at risk in this teardown.

CORRECTION 2026-08-20 (orchestrator session fe8a8e37), verified against source:

The sequencing note 'sessions.agent_group_id and .messaging_group_id are real FKs with
foreign_keys=ON, so the session rows need raw SQL' has the reasoning inverted. Those are
OUTBOUND FKs on the row being deleted -- they constrain what the row may point at and never
block its own DELETE.

The real inbound blockers on a 'DELETE FROM sessions' are:
  pending_questions.session_id   REFERENCES sessions(id), no ON DELETE -> NO ACTION -> blocks
  pending_approvals.session_id   REFERENCES sessions(id), no ON DELETE -> NO ACTION -> blocks
Neither table has an agent_group_id column, so neither appears in a group-scoped sweep.
Clear both before deleting the session rows.

Checked live: both are currently 0 rows for all three sessions in scope
(sess-1782319186963-b2yjgn, sess-1782785033830-whzaig, sess-1783527491016-ah2yj4), so the
delete will succeed today. Re-check immediately before executing -- an approval or question
raised in between would block it.

The conclusion 'needs raw SQL' still stands, for the other reason given in the same sentence:
ncl sessions is a read-only resource (list/get only, src/cli/resources/sessions.ts:45).
<!-- SECTION:NOTES:END -->
