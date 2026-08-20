---
id: TASK-9
title: Purge memory and coder references from the surviving agents
status: In Progress
assignee:
  - '@orchestrator'
created_date: '2026-07-31 02:50'
updated_date: '2026-08-20 23:31'
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
<!-- SECTION:NOTES:END -->
