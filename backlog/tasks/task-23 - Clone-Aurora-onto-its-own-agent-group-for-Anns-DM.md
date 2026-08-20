---
id: TASK-23
title: Clone Aurora onto its own agent group for Ann's DM
status: Needs Review
assignee: []
created_date: '2026-08-20 15:01'
updated_date: '2026-08-20 16:35'
labels:
  - aurora
  - matrix
  - deferred
dependencies:
  - TASK-8
references:
  - docs/isolation-model.md
priority: medium
ordinal: 23000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found in Claude Code session 9bcadaf6-3351-4862-8bee-85cc8b8f9834 (2026-08-20). DEFERRED BY OPERATOR: do this only after Aurora itself is fixed (venv, cron move, Discord teardown, fresh sessions).

Operator rule established this session: one agent group per destination, 1-to-1. Aurora currently serves two Matrix DMs from one agent group:

  wiring 35671fb9-...  mg-1783608739461-4om0w9   matrix @hammer  (shared)  -> sess-1783609624398-smn6q9
  wiring 95b041ba-...  f2cfdd4d-...              matrix @ann     (shared)  -> NO SESSION EVER CREATED

This supersedes TASK-8's line 'Aurora KEEPS both Matrix wirings and both Matrix destinations'.

Cheap to build: Ann's wiring has never instantiated a session, so there is nothing to migrate. Confirmed via: SELECT id FROM sessions WHERE agent_group_id='ag-1782273071167-th1q6f' AND messaging_group_id='f2cfdd4d-...' -> empty.

OPEN QUESTIONS -- resolve with the operator before building:
- Does Ann's clone get its own morning-report schedule, or is it chat-only on demand?
- If it gets a report: which category_id scopes her chores? Aurora hardcodes '11606604' (Dad) in CLAUDE.local.md. Ann needs her own.
- Same report format and sections, or a different shape?
- Does the clone need its own Skylight venv/token, or does TASK-6's shared-provisioning work land first? Two agent groups means two container images and two venvs under the current layout.

Clone mechanics: new agent group (own folder under groups/), copy CLAUDE.local.md with the person-scoped bits changed, own container_configs row (the skylight MCP block with SKYLIGHT_* env), repoint wiring 95b041ba at the new group, drop 'ann' from Aurora's destinations.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Ann's DM is served by its own agent group, not Aurora's
- [ ] #2 Aurora's destinations no longer include ann; each group has exactly one destination
- [ ] #3 Open questions above answered and recorded before implementation starts
- [ ] #4 Ann receives a live test message through the new group
<!-- AC:END -->
