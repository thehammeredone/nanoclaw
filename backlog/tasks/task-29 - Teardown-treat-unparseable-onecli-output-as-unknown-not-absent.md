---
id: TASK-29
title: 'Teardown: treat unparseable onecli output as unknown, not absent'
status: In Progress
assignee:
  - '@orchestrator'
created_date: '2026-08-21 13:41'
updated_date: '2026-08-22 14:56'
labels: []
dependencies: []
ordinal: 29000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up from TASK-14 round-2 review (orchestrator session c34ccecb). Narrow residual of a bug class that was otherwise closed.

findOnecliAgent in src/teardown/agent-group-teardown.ts sets unknown:true only when the exec itself fails. If 'onecli agents list' SUCCEEDS but returns output JSON.parse cannot handle, unknown stays false, so the plan renders 'WILL DELETE - OneCLI vault agent: (none)' and collectIncomplete does not flag it. Same end state the round-2 fix was written to prevent: a live vault agent still holding injectable credentials for a deleted group, behind exit 0 - just reached through a parse failure instead of an exec failure.

Not fixed inline because it is entangled with test fixtures: the shared fakeExec in src/teardown/agent-group-teardown.test.ts returns {ok:true, stdout:''} for unmocked 'onecli agents list' calls, so marking the parse path unknown makes several existing tests fail their toEqual([]) assertions against collectIncomplete. The fixture needs a default that parses, or the assertions need updating - a mechanical but non-trivial change that did not belong in a round-2 critical fix.

Same question likely applies to findImageTags if its output is ever malformed rather than absent - check both while in here.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 findOnecliAgent sets unknown:true when onecli output cannot be parsed, not just when exec fails
- [ ] #2 findImageTags audited for the same parse-vs-exec distinction and fixed if it shares the gap
- [ ] #3 Test fixture default for unmocked onecli calls returns parseable output, and existing collectIncomplete assertions still pass
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Closed the parse-vs-exec gap in findOnecliAgent: a JSON.parse failure now sets unknown:true (AC#1). Review round 1 found the same silent-(none) hole still reachable through well-formed JSON of an unexpected shape ([], scalars, null, {data:{}}) — two of those additionally threw a TypeError out of planTeardown and surfaced as exit 1. A single shape guard (parsed is a non-null object with an Array data field) now routes all of them to unknown:true with an 'unexpected onecli agents list shape' warning. findImageTags was audited and deliberately left alone (AC#2): it never parses — docker --format output is split/trimmed/filtered, nothing can throw, and malformed-but-exit-0 output is indistinguishable from a genuine empty result, so an unknown state there would be a false-positive heuristic rather than a fix. findContainers shares that shape and was likewise left alone. The shared fakeExec default for unmocked 'onecli agents list' calls now returns JSON.stringify({data:[]}) (AC#3), which matches the real onecli envelope; no existing assertion was weakened or deleted (zero deletion lines in the test diff). Unknown-semantics wording was swept across the module header, the findOnecliAgent and TeardownPlan.onecliUnknown docstrings, the exit-code block in scripts/delete-agent-group.ts, and docs/runbooks/agent-group-teardown.md. 402 tests pass, tsc --noEmit clean.
<!-- SECTION:NOTES:END -->
