---
id: TASK-31
title: 'Teardown: element-level shape guard for onecli agents list entries'
status: In Progress
assignee:
  - '@orchestrator'
created_date: '2026-08-22 17:49'
updated_date: '2026-08-27 06:35'
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-08-27 orchestrator review gate: spec COMPLIANT on first pass (all three ACs verified by execution across 23 payload shapes, and unknown:true traced end-to-end -- findOnecliAgent -> planTeardown -> the single guarded 'onecli agents delete' call site -> collectIncomplete -> exit 2, so no delete call with an undefined id is reachable). Code quality CHANGES REQUESTED: 3 Important + 3 Minor, all fixed in one round (061773cc, 123e4fc2, cc7dd286, 3a4e05b2).

The three that mattered, all the same shape -- a guard that looked right but let a case through:
1. '!match.id' was a truthiness check, so a non-string id (12345, {}, ['x'], true) passed it and flowed into env.exec('onecli',['agents','delete','--id',<non-string>]). execFileSync then throws ERR_INVALID_ARG_TYPE, which is caught and becomes exit 2 -- safe, but exactly the 'wasted/garbage call, not a clean unknown' this task was filed to eliminate. Now typeof-checked.
2. An object element with a missing or non-string identifier (undefined, 1234, null, {}) yielded unknown:false, agent:null and NO warning -- a silent (none) for a record whose ownership cannot be determined. The implementer's asymmetry ('a missing-id element for a different agent is data this call never touches') only holds for records that positively identify as some OTHER agent; a record identifying as nothing at all might be the target. Such elements now poison the result.
3. CREDENTIAL-LEAK PATH: the element-shape warning interpolated JSON.stringify(badElement) into plan warnings and stdout, and this same file documents that those rows carry accessToken. An array-shaped (columnar) element would have been printed verbatim. Now reports index + type only.

Also corrected: this branch had ADDED a false claim to docs/state-discovery.md -- a NOTE asserting the reconcile recipe's a['identifier'] lookup 'throws here instead of resolving to UNKNOWN'. The reviewer extracted the snippet verbatim and ran it: [null,{...}] and ['scalar'] both correctly exit 2 via the existing try/except. Documenting a nonexistent gap in the exact place the doc insists 'never conflate no-orphans with couldn't-check' would have invited a fix for a non-bug. Removed.

PROCESS CAVEAT, stated plainly: no independent delta-verifier ran for this fix round -- the usage window hit FINISH_ONLY first. The orchestrator verified the six fixes directly instead, by grepping for each changed construct (typeof guards present, JSON.stringify(badElement) gone, unreachable fallback gone, false NOTE gone) and running the suite: pnpm test 492 passed / 1 skipped, pnpm run build clean, tree clean. That is weaker evidence than a fresh adversarial pass, and the fixes were narrow and well-specified, but it is not equivalent. If anything in this area later misbehaves, this is the task whose fix round went unverified by a second agent.

No live onecli or docker commands, no DB writes, no container restarts.
<!-- SECTION:NOTES:END -->
