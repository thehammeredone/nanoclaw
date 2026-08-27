---
id: TASK-28
title: >-
  Daily session rollover effectively stops conversations/ archiving for Aurora
  and Radar
status: In Progress
assignee:
  - '@orchestrator'
created_date: '2026-08-21 00:21'
updated_date: '2026-08-27 05:39'
labels:
  - agent-runner
  - aurora
  - radar
  - docs
dependencies: []
priority: medium
ordinal: 28000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found during TASK-22 review (orchestrator session fe8a8e37, 2026-08-20).

TASK-22 makes any batch containing a kind='task' row start a FRESH SDK session. That bounds
context to ~24h, which was the goal. But it has a consequence the task's AC#5 did not
anticipate.

PreCompact (container/agent-runner/src/providers/claude.ts, in the hook registered on every
sdkQuery) is the SOLE writer to groups/<folder>/conversations/. It fires only when the SDK
auto-compacts, and the compact window is ~165k tokens. Observed archive cadence shows
compaction firing only after roughly 1-3 weeks of accumulated context:
  Radar:  2026-07-13, 07-23, 07-30, 08-10
  Aurora: 2026-06-30, 07-17
A single day's fresh session will essentially never reach 165k. So for the two agents that
carry scheduled tasks, conversations/ archiving effectively STOPS, and each day's abandoned
transcript becomes unrecoverable -- the continuation id is overwritten with no record of the
prior one.

This matters because two places promise the opposite:
  container/CLAUDE.md:21   'searchable transcripts of past sessions'
  groups/main/CLAUDE.md:40 same promise

DELIBERATELY NOT FIXED IN TASK-22. The operator has already explicitly declined moving the
PreCompact hook to Stop/SessionEnd once (recorded in the 2026-08-20 work record as
over-engineering). This task exists so the consequence is a decision rather than a silent
side effect.

Options:
 (a) Accept it. Amend AC#5's wording and the two CLAUDE.md promises to match reality.
 (b) Archive at the point the continuation is dropped -- i.e. when shouldRunFresh() clears the
     in-memory id, write the outgoing transcript out first. This is the natural seam and does
     not require touching PreCompact at all.
 (c) Move archiving to a Stop/SessionEnd hook so it fires per session rather than per compact.
     Previously declined.

Note (b) did not exist as an option before TASK-22 -- the rollover created the seam.
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-08-27 (orchestrator): IMPLEMENTATION COMPLETE AND REVIEWED, BUT NOT MERGEABLE YET -- the usage window hit FINISH_ONLY before a fix round could be dispatched. Do NOT merge this branch: spec has an open AC#2 failure and there are two open Important findings. All implementer work is committed (1861bf6f, c4940ddd, 278a9027, b8e2cfc9) and the tree is clean.

DECISION MADE: option (b) from the description -- archive at the seam where the rollover drops the continuation id. Option (c) is the one the operator declined as over-engineering and was not touched; option (a) would have degraded a promise the docs make in two places. PreCompact is byte-unchanged; the only deletion in the whole implementation diff is an unused import.

RESUME BY dispatching a fresh sonnet fix-applier with the finding list below (do NOT re-review, do NOT re-implement, do NOT resume the implementer), then a delta-verifier, then finish_task.

SPEC -- AC#2 FAILS, two ways:
1. container/agent-runner/src/poll-loop.ts:217 -- the same session can be archived TWICE. Rollover drops the in-memory id but never calls clearContinuation, so the store keeps it. If the fresh query dies before init (the documented 06:00 OneCLI-gateway-contention case) line 260 restores it, and the next day's rollover re-archives the same session as <day2>-rollover-<same-id>.md. The existsSync dedupe guard is keyed on the UTC day, so it does not catch this. Reviewer reproduced it in a temp dir.
2. container/agent-runner/src/providers/claude.test.ts:88 -- the naming half of the naming/idempotency rule is not actually tested. The test asserts .includes('-rollover-') against three STRING LITERALS, imports nothing from the implementation, and cannot fail for any change to either writer -- contradicting its own comment. (Idempotency, test 3, IS genuinely tested.)

QUALITY -- CHANGES REQUESTED:
- [Important] poll-loop.ts:148 -- /clear drops the continuation (in-memory AND clearContinuation) with no archive, two lines away from the primitive that now exists. A user who chats all day then types /clear loses the transcript, exactly the loss the new code's own comment says must not happen.
- [Important] providers/claude.test.ts:88 -- the tautological test above.
- [Minor] providers/claude.ts:313 -- filename date is UTC, body timestamp is local, so 2026-08-27-rollover-*.md can contain 'Archived: Aug 26, 8:35 PM'. Pre-existing in PreCompact, but newly load-bearing because the dedupe guard keys on the UTC day.
- [Minor] poll-loop.ts:217 -- the archive await has no timeout; a catch cannot rescue a hang on a stalled bind mount, so 'NEVER breaks the turn' is not strictly true. Measured 15ms on a real 404KB transcript, so low risk.
- [Minor] docs/agent-runner-details.md:698 -- 'fires once, at the daily seam' overstates: shouldRunFresh() fires for ANY task batch, so an hourly recurrence would write 24 single-turn files a day into an RW dir with no GC.

VERIFIED NON-ISSUES (do not re-litigate): getSessionMessages is public documented SDK surface (sdk.d.ts:684) at the installed 0.2.138, so no minor-bump risk; the extraction is byte-faithful against a real Aurora transcript; /home/node/.claude is a persistent bind mount so yesterday's transcript really is readable at 06:00; no host src/ was touched so skipping pnpm test/build was legitimate; the 'other providers archive after each query' claim really was false before (opencode.ts never wrote to conversations/); no transcript content is logged or committed. Mutation testing confirmed the other 8 tests are real. bun test 111/0, tsc --noEmit clean. Full detail: .orchestrate-backlog/task-28-review.md

2026-08-27 orchestrator: fix round applied and independently delta-verified (098b069f, 47ef9bb3, 2402724d, 770a8d99). All six findings RESOLVED, no regressions -- shouldRunFresh() and everything in claude.ts from the Provider marker onward (constructor, compaction threshold, sdkQuery setup, createPreCompactHook) confirmed byte-identical by diff, so the second writer is purely additive.

The blocking AC#2 defect and its fix, worth remembering: the dedupe guard was keyed on the UTC day, but the rollover drops only the IN-MEMORY continuation id -- clearContinuation is never called -- so a fresh query that dies before init (the 06:00 gateway-contention case) restores the id from the store and the next day's rollover archives the same session again under a new date. The fix moves the 'already archived' fact off the date entirely: the guard now scans conversations/ for any *-rollover-<sessionId>.md regardless of date, so it is a durable session-id-keyed fact on disk that survives the restore-from-store path. Verified by reproducing the two-file outcome against the pre-fix code and one file against the post-fix code.

Also fixed: /clear dropped the continuation (in-memory AND clearContinuation) with no archive -- a user who chatted all day then typed /clear lost the transcript, the exact loss this task exists to prevent. It now routes through the same archive path, and a throwing archiveSession still lets /clear complete. The archive await is bounded by a 10s timeout (the hung promise is not cancelled -- no cancellation API exists -- inherent to a race-based timeout, not a new defect). Rollover filenames now use a local date stamp matching the body's local Archived: timestamp; collision safety rests on the -rollover- token, not the date, so PreCompact staying UTC is harmless.

The naming test that could not fail was replaced: it now derives the rollover filename from a real archiveSession() call, and asserts the PreCompact side via source text scoped between real markers -- the delta-verifier confirmed createPreCompactHook's target dir is genuinely hardcoded (claude.ts:228, no injection point), so the source-text technique was necessary rather than convenient, and proved it goes red by injecting a colliding name into PreCompact's fallback branch.

KNOWN, DELIBERATELY NOT FIXED: conversations/ still has no GC, and shouldRunFresh() fires for ANY task batch, so an hourly recurrence would write 24 single-turn files a day. The dedupe scan is O(n) linear over that directory. The docs now say this instead of promising a once-daily seam.

bun test 113 pass / 0 fail; tsc -p container/agent-runner/tsconfig.json --noEmit clean. No host src/ touched. No container restarted, no real groups/ or ~/.claude/projects/ written.
<!-- SECTION:NOTES:END -->
