---
id: TASK-22
title: Run scheduled tasks on a fresh SDK session (daily context rollover)
status: To Do
assignee: []
created_date: '2026-08-20 15:00'
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
