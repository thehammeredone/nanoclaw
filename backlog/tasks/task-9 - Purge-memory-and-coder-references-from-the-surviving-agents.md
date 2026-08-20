---
id: TASK-9
title: Purge memory and coder references from the surviving agents
status: In Progress
assignee:
  - '@orchestrator'
created_date: '2026-07-31 02:50'
updated_date: '2026-08-20 23:43'
labels:
  - aurora
dependencies: []
references:
  - docs/db-session.md
  - scripts/send-to-memory.ts
priority: high
ordinal: 9000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Must land before the Memory and Coder groups are actually deleted (TASK-10, TASK-11), otherwise the surviving agents keep calling destinations that no longer resolve.

Prose instructions in surviving groups:
- groups/dm-with-hammer/CLAUDE.local.md (Mjollnir) -- line ~11 says "Before responding to any message from Hammer, query memory for behavioral guidance. This is mandatory, not optional." Plus a full "## Memory Agent" section (~line 24) and coder references. Left in place, every single Mjollnir turn tries to send to a dead destination.
- groups/skylight-morning/CLAUDE.local.md (Aurora) -- "## Memory Agent" section at ~line 145 with the same mandatory pre-response query.

agent_destinations rows pointing AT the deleted groups. target_id has NO foreign key (it holds either a messaging group id or an agent group id), so these will not fail on delete and will not be caught by scripts/delete-cli-agent.ts -- that script only deletes rows where agent_group_id = the group being removed, i.e. outbound edges, never inbound ones:
  Mjollnir       ag-1779381936325-6ki38t  local_name "memory" -> f09aa5a1-...
  Mjollnir       ag-1779381936325-6ki38t  local_name "coder"  -> 54c8dbdf-...
  Terminal Agent ag-1779227551242-zf47au  local_name "memory" -> f09aa5a1-...

Mirrored per-session destinations tables inside each surviving session's inbound.db (host writes these; they are a copy of agent_destinations, see docs/db-session.md):
  12 Mjollnir sessions each list: assistant, coder, hammer, memory
  1 Terminal Agent session lists:  local-cli, memory
Confirm whether the host rewrites these on next spawn or whether they need a manual sweep.

Code:
- scripts/send-to-memory.ts hardcodes MEMORY_AGENT_GROUP_ID = 'f09aa5a1-bea7-410a-a319-f20da1549703'. Delete the script.

Also worth deciding: Mjollnir's behavioral profile currently lives in groups/memory/wiki/behaviors/mjollnir.md. If anything in it should outlive the wiki, it has to move into Mjollnir's own CLAUDE.local.md before TASK-10 deletes it.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Mjollnir CLAUDE.local.md no longer instructs querying memory or coder
- [ ] #2 Aurora CLAUDE.local.md Memory Agent section removed
- [ ] #3 All three inbound agent_destinations rows removed
- [ ] #4 Per-session destinations tables in surviving sessions no longer list memory or coder
- [ ] #5 scripts/send-to-memory.ts deleted
- [ ] #6 Anything worth keeping from wiki/behaviors/mjollnir.md moved into Mjollnir's own instructions, or explicitly dropped
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
AMENDED 2026-08-20 (session 9bcadaf6-3351-4862-8bee-85cc8b8f9834). Re-verified against the live DBs; the operator specifically asked whether the memory wiring is still real. It is not, for Aurora.

CONFIRMED -- Aurora has NO memory destination at either layer:
  central agent_destinations for ag-1782273071167-th1q6f:
    hammer -> mg-1783608739461-4om0w9
    ann    -> f2cfdd4d-...
  session destinations (sess-1783609624398-smn6q9):
    ann    | channel |
    hammer | channel |
No type='agent' row anywhere for Aurora. So every 'query memory' call from Aurora's CLAUDE.local.md fails to resolve. AC#2 is confirmed necessary.

STILL LIVE elsewhere (so AC#3/#4 still have real work): sweeping all sessions for type='agent' destinations returns memory and coder rows in 12 Mjollnir sessions (ag-1779381936325-6ki38t) and memory in 1 Terminal Agent session (ag-1779227551242-zf47au). Central table still has the three inbound rows the description lists.

WHY THIS MATTERS MORE THAN IT LOOKS: Aurora's CLAUDE.local.md says 'Before responding to any message from Hammer, query memory ... Wait for the reply. Apply any returned guidance before composing your response.' That is a mandatory blocking step at the top of every turn that always fails. It also says to send every behavioural correction to memory -- so every correction the operator has given Aurora has gone to a dead address. This is a direct mechanical explanation for 'corrections do not stick', independent of the venv outage. Cross-ref TASK-24.

QUERY GOTCHA for whoever picks this up: the destinations table column is 'type', NOT 'kind'. A sweep using 'kind' errors out and, if stderr is suppressed, silently returns nothing -- which reads as 'no agent destinations anywhere' and is wrong. Schema: name, display_name, type, channel_type, platform_id, agent_group_id.

CORRECTION 2026-08-20 (orchestrator session fe8a8e37), verified against source:

The open question 'does the host rewrite per-session destinations on spawn?' is already
answered: YES, unconditionally. writeDestinations (src/modules/agent-to-agent/write-destinations.ts)
ends by calling replaceDestinations, which is a full DELETE + re-insert inside a transaction
(src/db/session-db.ts:66-76: 'DELETE FROM destinations' then INSERT for each resolved row).

So every session's inbound.db destinations table is rebuilt from the central agent_destinations
rows on each spawn. Fixing the central rows is sufficient; hand-editing live inbound.db files
is unnecessary and will be overwritten anyway. AC #4 should pass trivially once the central
rows are correct.

RESOLVED 2026-08-20 (orchestrator session fe8a8e37). One review round.

Central agent_destinations: all three target_type='agent' rows deleted by exact tuple.
ZERO agent-type destinations remain anywhere; the 5 surviving rows are all channel-type,
including Aurora's hammer + ann (untouched).

Prose purged from THREE files, not the two the ACs named:
  groups/dm-with-hammer/CLAUDE.local.md   (Mjollnir)       -57 lines
  groups/skylight-morning/CLAUDE.local.md (Aurora)         -29 lines
  groups/_ping-test/CLAUDE.local.md       (Terminal Agent) -56 lines
  scripts/send-to-memory.ts                                 deleted

REVIEW CAUGHT A GAP THE ACs MISSED. The ACs named only Mjollnir and Aurora, but the task's
own description names Terminal Agent's memory destination row -- which this task deleted.
Its instruction file still carried the mandatory 'query memory before responding' block and
the full Memory Agent section. That left the two halves contradictory: on next spawn the
agent boots with a system prompt advertising only 'local-cli' (writeDestinations rewrites
the table at container-runner.ts:119-121) while its own instructions insist it must send to
'memory' before any other work and wait for a reply. Every turn would have opened with
'Unknown destination "memory". Known: local-cli'. Fixed.

Also merged Mjollnir's two overlapping reply-routing rules into one paragraph.

AC#6: the wiki's single behavioral correction ('reply to thread, not DM', 2026-05-25) was
folded into Mjollnir's Reply Routing section in the agent's own imperative voice rather than
pasted with its Date/Correction/Context wiki scaffolding. groups/memory/ itself untouched
(TASK-10's scope).

AC#4 TICKED BY MECHANISM, NOT BY LITERAL STATE. All 13 surviving sessions (12 Mjollnir,
1 Terminal Agent) still list memory/coder in their inbound.db destinations tables right now.
They are corrected automatically at next spawn: spawnContainer calls writeDestinations
unconditionally (src/container-runner.ts:119-121), which calls replaceDestinations -- a
transactional DELETE FROM destinations + re-insert with no early return on an empty set
(src/db/session-db.ts:66-76). Verified no Mjollnir or Terminal Agent container is currently
running, so no stale-read window is open. Belt and braces: routeAgentMessage re-validates
against the CENTRAL table (agent-route.ts:167-174) and throws 'unauthorized agent-to-agent',
so even a stale local row cannot produce a successful send. The central deletion is the
load-bearing fix.

OPERATIONAL FOLLOW-UP (not actioned here): CLAUDE.local.md is injected once per SDK session.
Every one of the 13 affected sessions has a continuation:claude row, so none of these prose
edits take effect until those continuations are cleared. Clearing them is the remaining step
before the behaviour actually changes.

NOTE FOR TASK-10: this purge removes the only mechanism by which behaviour corrections were
persisted anywhere in this install. That is presumably intended, but it should be a
deliberate decision rather than a side effect.
<!-- SECTION:NOTES:END -->
