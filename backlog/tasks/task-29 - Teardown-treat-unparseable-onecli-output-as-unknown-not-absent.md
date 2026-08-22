---
id: TASK-29
title: 'Teardown: treat unparseable onecli output as unknown, not absent'
status: Done
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
- [x] #1 findOnecliAgent sets unknown:true when onecli output cannot be parsed, not just when exec fails
- [x] #2 findImageTags audited for the same parse-vs-exec distinction and fixed if it shares the gap
- [x] #3 Test fixture default for unmocked onecli calls returns parseable output, and existing collectIncomplete assertions still pass
<!-- AC:END -->







## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Closed the parse-vs-exec gap in findOnecliAgent: a JSON.parse failure now sets unknown:true (AC#1). Review round 1 found the same silent-(none) hole still reachable through well-formed JSON of an unexpected shape ([], scalars, null, {data:{}}) — two of those additionally threw a TypeError out of planTeardown and surfaced as exit 1. A single shape guard (parsed is a non-null object with an Array data field) now routes all of them to unknown:true with an 'unexpected onecli agents list shape' warning. findImageTags was audited and deliberately left alone (AC#2): it never parses — docker --format output is split/trimmed/filtered, nothing can throw, and malformed-but-exit-0 output is indistinguishable from a genuine empty result, so an unknown state there would be a false-positive heuristic rather than a fix. findContainers shares that shape and was likewise left alone. The shared fakeExec default for unmocked 'onecli agents list' calls now returns JSON.stringify({data:[]}) (AC#3), which matches the real onecli envelope; no existing assertion was weakened or deleted (zero deletion lines in the test diff). Unknown-semantics wording was swept across the module header, the findOnecliAgent and TeardownPlan.onecliUnknown docstrings, the exit-code block in scripts/delete-agent-group.ts, and docs/runbooks/agent-group-teardown.md. 402 tests pass, tsc --noEmit clean.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Closed the last silent-(none) hole in OneCLI vault-agent discovery during agent-group teardown. findOnecliAgent now reports unknown:true whenever 'onecli agents list' fails to produce a usable answer — a non-zero exit (pre-existing), a JSON.parse failure behind exit 0 (AC#1), or well-formed JSON of an unexpected shape such as a bare array, a scalar, null, or a non-array data field (found by review round 1; two of those previously threw a TypeError out of planTeardown and surfaced as a miscategorised exit 1). The plan renders '(COULD NOT CHECK ...)' and collectIncomplete drives exit 2 in every one of those cases, so an operator can no longer read 'no vault agent' from a check that never actually answered. findImageTags was audited and deliberately left unchanged (AC#2): it has no parse step, its docker --format output is split/trimmed/filtered with nothing able to throw, and malformed-but-exit-0 output is indistinguishable from a genuine empty result — an unknown state there would be a false-positive heuristic, not a fix; findContainers shares that shape and was left alone for the same reason. The shared fakeExec default for unmocked 'onecli agents list' calls now returns the real envelope shape JSON.stringify({data:[]}) (AC#3), so no existing collectIncomplete assertion had to be weakened — the test diff contains zero deletion lines. Unknown-semantics wording was swept across the module header, the findOnecliAgent and TeardownPlan.onecliUnknown docstrings, the exit-code block in scripts/delete-agent-group.ts, and docs/runbooks/agent-group-teardown.md. Seven new tests cover the finder, the rendered plan text, and the exit-code signal. 402 tests pass; tsc --noEmit clean.
<!-- SECTION:FINAL_SUMMARY:END -->
