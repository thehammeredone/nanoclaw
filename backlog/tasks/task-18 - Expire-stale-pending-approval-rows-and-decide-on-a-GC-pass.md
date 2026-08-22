---
id: TASK-18
title: Expire stale pending approval rows and decide on a GC pass
status: In Progress
assignee:
  - '@orchestrator'
created_date: '2026-07-31 03:20'
updated_date: '2026-08-22 20:19'
labels:
  - approvals
dependencies: []
references:
  - src/host-sweep.ts
  - docs/db-central.md
priority: medium
ordinal: 18000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
There is a live pending_channel_approvals row created 2026-07-09 -- three weeks stale at time of writing -- for Aurora on the Matrix hammer DM. Its options_json still enumerates every agent group that existed that day, including Coder, Memory, Terminal Agent and local-qwen3.6. If it is still actionable, picking one of those options after the decommission connects a channel to a group that no longer exists.

pending_approvals has an expires_at column; pending_channel_approvals and pending_sender_approvals do not. Nothing observed sweeps any of them. host-sweep (src/host-sweep.ts) handles processing_ack, stale detection, due-message wake and recurrence -- not approval expiry.

Current counts: pending_approvals 0, pending_questions 0, pending_sender_approvals 0, pending_channel_approvals 1.

Two questions to answer:
1. Is a 3-week-old channel approval still clickable, or is it inert because the platform message is gone? Determines whether this is a correctness bug or just clutter.
2. Should there be a GC pass in host-sweep, and what TTL. An approval that outlives the roster it was rendered against is stale by definition.

Note that these tables also matter for teardown: pending_questions references sessions(id) but has no agent_group_id column, so it is invisible to group-scoped sweeps and can block a sessions delete unexpectedly. It happens to be empty today. See TASK-14.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The stale 2026-07-09 pending_channel_approvals row is cleared
- [ ] #2 Answered whether a stale approval is still actionable
- [ ] #3 GC/TTL for the pending_* tables either implemented in host-sweep or explicitly declined with a reason
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Provenance: Claude Code session 9934a222-4185-48a6-8de2-07b8bbe71cf7 (2026-07-30). Discovery data: docs/work-records/2026-07-30-decommission-planning-aurora-discord-wiring-and-four-agent-groups.md and docs/state-discovery.md
<!-- SECTION:NOTES:END -->
