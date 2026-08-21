---
id: TASK-28
title: >-
  Daily session rollover effectively stops conversations/ archiving for Aurora
  and Radar
status: To Do
assignee: []
created_date: '2026-08-21 00:21'
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
