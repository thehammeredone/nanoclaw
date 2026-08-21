---
id: TASK-29
title: 'Teardown: treat unparseable onecli output as unknown, not absent'
status: To Do
assignee: []
created_date: '2026-08-21 13:41'
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
