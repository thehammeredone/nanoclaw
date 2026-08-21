---
id: TASK-22
title: Run scheduled tasks on a fresh SDK session (daily context rollover)
status: In Progress
assignee:
  - '@orchestrator'
created_date: '2026-08-20 15:00'
updated_date: '2026-08-21 00:20'
labels:
  - aurora
  - radar
  - agent-runner
  - cost
dependencies: []
references:
  - container/agent-runner/src/poll-loop.ts
  - docs/SDK_DEEP_DIVE.md
priority: high
ordinal: 22000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found in Claude Code session 9bcadaf6-3351-4862-8bee-85cc8b8f9834 (2026-08-20).

Today every session resumes one long-lived Claude Agent SDK transcript forever. poll-loop.ts loads continuation:claude at startup and passes it as `resume` on every query; nothing ever clears it except a human typing /clear. Aurora's live transcript (9bbbc823) has been resuming since 2026-08-11 -- 170 lines, 985KB. Radar behaves the same way.

DECISION: any batch containing a kind='task' row runs WITHOUT resume.

The change is one line at poll-loop.ts:170. processQuery already persists the new session id on the 'init' event (poll-loop.ts:371), so the fresh session is stored automatically and the rest of the day's chat resumes IT. Net effect is a daily rollover:

  06:00 report -> no resume -> new session -> persisted on init
  09:00 chat   -> resumes that morning's session
  next 06:00   -> ignores stored id -> fresh again

Context is bounded to ~24h for reports AND interactive chat, which is the desired behaviour.

Scope decisions already taken (do not re-litigate):
- Applies to ALL kind='task' rows, not an opt-in column. Radar is meant to get this too.
- Mixed batches (a task and a chat arriving in the same poll) use .some(), not .every(). If a chat gets folded into the fresh session, that is acceptable. Do not build special handling.
- PreCompact archiving does NOT need to move. Sessions still persist and still compact on long days, so conversations/ archiving keeps working unchanged. (Verified: archives exist for Aurora 2026-06-30 and 2026-07-17, Radar 2026-08-10.)
- Radar's dedup is script-side on disk, so a cold session will not resurface old stories.

Secondary benefit: CLAUDE.local.md is loaded at SDK session init (settingSources: ['project','user'], claude.ts:304). A session resuming since Aug 11 has not re-read it since. Fresh-per-task means edits to the report procedure take effect the next morning without operator intervention. NOTE: whether `resume` re-reads project settings was NOT empirically verified -- the user chose to proceed without the experiment, so treat this as a likely benefit rather than a proven one.

Divergence warning: hammer has never modified container/agent-runner/src/providers/claude.ts or poll-loop.ts (git log mergebase..hammer is empty for both). This change creates a hammer-local divergence that the upstream rebase (see the rebase task) will have to carry.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A batch containing any kind='task' row runs without resume
- [ ] #2 The fresh session id is persisted so same-day chat resumes it
- [ ] #3 Verified end to end: two consecutive morning reports produce two different session ids, and a midday chat resumes the morning's id
- [ ] #4 Radar's 6:20 digest also runs fresh and still does not repeat stories
- [ ] #5 No change required to PreCompact archiving; conversations/ still receives archives
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
RESOLVED 2026-08-20 (orchestrator session fe8a8e37). One review round; the review found a regression the change itself introduced.

IMPLEMENTATION: exported predicate shouldRunFresh(messages) => messages.some(m => m.kind === 'task'),
evaluated on 'keep' (post pre-task-script gating, i.e. what is actually sent to the provider).
When true the loop clears the in-memory continuation, so provider.query() gets no resume.

CRITICAL REGRESSION CAUGHT IN REVIEW (C1). setContinuation fires unconditionally on the SDK
'init' event (poll-loop.ts:392), but the in-memory continuation was only updated AFTER a
successful query. So a fresh task run that died mid-stream left the DB holding the NEW id
while the loop held the OLD one -- and the next chat resumed the pre-rollover transcript,
silently defeating the rollover for the rest of the day, while a container restart would
resume the other session. Divergent state, directly contradicting AC#2.
This was benign BEFORE this change only because forkSession defaults false, so a resumed
query returns the same id and the two never diverged. Fixed by clearing the in-memory id in
the runFresh block, and re-syncing from the store in the catch BEFORE the isSessionInvalid
check -- ordering matters, because after the clear the guard would otherwise short-circuit on
undefined and never clear a genuinely dead fresh session.

AC#1 HOLE ALSO CAUGHT (I2). The follow-up push path (poll-loop.ts ~302-365) polls for new
rows mid-stream and pushes them into the LIVE query with no kind gate, so a task falling due
while a query was streaming got folded into the RESUMED session. Concretely: operator chats
at 06:19, Radar's '20 6 * * *' fires at 06:20 into the existing ~985KB transcript -- exactly
the unbounded-context case this task exists to prevent. Fixed by mirroring the existing
runner-command precedent: end the stream, leave the rows pending, let the outer loop re-enter
and run them fresh.

THE FEATURE WAS INITIALLY UNTESTED, PROVEN BY MUTATION. Reverting the functional line left
all 98 tests green. Four integration tests were added and the mutation proof re-verified
INDEPENDENTLY by the orchestrator: removing the in-memory clear at poll-loop.ts:200 fails
exactly 3 tests (task-batch-no-resume, the C1 failure path, the I2 mid-stream gate);
restoring it returns 102 pass / 0 fail.

BONUS FIX: integration.test.ts was leaking a live poll loop per test against the shared test
DB (runPollLoop never returns), stealing messages from later tests and even other files --
visible as 'unable to open database file' noise in mcp-tools/core.test.ts. afterEach now ends
every query and awaits the loop's rejection.

Also: container MessageInKind union added (kind was a bare string, so a 'tasks' typo would
have compiled and silently disabled the feature). Docs corrected --
docs/agent-runner-details.md 'Session Resume' was already stale (described sessionId/resumeAt
and claimed the id lives in the central sessions table; it is actually the per-provider
continuation in outbound.db session_state) and now documents the rollover rule;
docs/db-session.md misnamed it as the Chat SDK session id.

AC#3/#4 REMAIN GENUINELY UNVERIFIED end-to-end and were deliberately not faked: they need two
consecutive real mornings. Triggering them would message the operator (Aurora) and post a
digest to a channel (Radar). Static argument is sound: forkSession defaults false, so resume
preserves the id, giving day1 S1 / same-day chat S1 / day2 S2 != S1. Confirm after tomorrow's
06:00 (Aurora row task-1787267541212-gro4qg) and 06:20 (Radar row task-1787221329073-sb062b).

AC#5 SPLIT VERDICT: no code change was needed (true), but the second clause is now false
going forward -- a fresh daily session will essentially never reach the 165k auto-compact
window that drives PreCompact, which is the sole writer to conversations/. Archive cadence for
Aurora and Radar effectively stops. NOT fixed here: the operator previously declined moving
the PreCompact hook. Filed separately.

NOT YET LIVE: this is agent-runner source running on Bun inside the container image. It takes
effect only after ./container/build.sh and a container restart/respawn. No groups/*/
agent-runner-src/ overlay shadows poll-loop.ts, so the rebuild is the only gate.

TASK-25 NOTE: this is hammer's first modification to poll-loop.ts. The rebase must carry it.
<!-- SECTION:NOTES:END -->
