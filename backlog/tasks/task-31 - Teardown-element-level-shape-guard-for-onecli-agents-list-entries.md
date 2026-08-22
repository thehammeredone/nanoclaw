---
id: TASK-31
title: 'Teardown: element-level shape guard for onecli agents list entries'
status: To Do
assignee: []
created_date: '2026-08-22 17:49'
labels: []
dependencies: []
ordinal: 31000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up from TASK-29 validation sweep (orchestrator session be31f486). Non-blocking residual, out of TASK-29's AC scope.

The shape guard added in TASK-29 (src/teardown/agent-group-teardown.ts:636-650) validates only the top level: parsed is a non-null object with an Array data field. Elements inside that array are still trusted.

Verified by direct execution against the merged code:
- '{"data":[null]}' throws TypeError: Cannot read properties of null (reading 'identifier') out of findOnecliAgent at agent-group-teardown.ts:652 — the same uncaught-exception-mis-surfaced-as-exit-1 failure mode the TASK-14 round-2 fix was written to close, one level deeper.
- '{"data":[{"identifier":"ag-doomed"}]}' (no id field) returns agent.id === undefined, which would drive a delete call with an undefined id. That call's failure is still caught by collectIncomplete, so it degrades safely — but it is a wasted/garbage call, not a clean unknown.

Both require onecli emitting element-level garbage behind exit 0, which is outside the failure TASK-29 was written against. Filed rather than fixed inline so the TASK-29 merge stayed scoped.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Non-object / null elements in the agents list array route to unknown:true rather than throwing out of findOnecliAgent
- [ ] #2 An element missing 'id' does not produce a delete call with an undefined id — it routes to unknown:true or is skipped with a warning
- [ ] #3 Tests cover {data:[null]}, {data:[scalar]}, and {data:[{identifier only}]}
<!-- AC:END -->
