---
id: TASK-16
title: Delete orphaned OneCLI vault agents and audit secret assignments
status: In Progress
assignee:
  - '@orchestrator'
created_date: '2026-07-31 03:19'
updated_date: '2026-08-22 17:57'
labels:
  - security
dependencies: []
references:
  - src/container-runner.ts
  - docs/state-discovery.md
priority: medium
ordinal: 16000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Every agent group gets a OneCLI vault agent auto-created on first container spawn (ensureAgent, src/container-runner.ts:429, identifier = agent group id with an "ag-" prefix when the id starts with a digit). Nothing ever removes one. So decommissioning a group leaves behind a vault agent that still holds secret assignments -- real credentials attached to an identity nanoclaw no longer knows about.

Dead ends created by the current decommission:
  Memory          48d0d710-48a6-424c-8cbf-c42d98ff0bdd
  Coder           c982a432-fbc5-4b76-83f2-f0f9262e9828
  Terminal Agent  58026a01-33b1-4485-a804-f897fa6e6d61
(local-qwen3.6 never spawned a container, so it has no vault agent.)

These are also ACs on TASK-10/11/12; this task is the sweep that confirms nothing was missed and establishes the general check.

While here: audit secret assignments across ALL agents. Every current agent is secretMode "all", meaning any vault secret with a matching host pattern is injected into every container. Worth confirming that is still the intent now that the agent roster is shrinking, rather than something that got set once to unblock a 401 (see the CLAUDE.md gotcha about selective mode).

Reconcile with:
  onecli agents list                          -> identifiers
  ncl groups list  (or the agent_groups query in docs/state-discovery.md)
Anything in the first list with no match in the second is an orphan.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 No OneCLI agent exists without a matching agent_groups row
- [ ] #2 Secret assignments for deleted agents are gone, not just the agent record
- [ ] #3 secretMode=all confirmed as intentional for each surviving agent, or narrowed
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Provenance: Claude Code session 9934a222-4185-48a6-8de2-07b8bbe71cf7 (2026-07-30). Discovery data: docs/work-records/2026-07-30-decommission-planning-aurora-discord-wiring-and-four-agent-groups.md and docs/state-discovery.md

## TASK-16 sweep — evidence

Pre-existing state confirmed (no destructive onecli commands run):
- `onecli agents list --fields=identifier,name,secretMode` -> 4 agents: default (Default Agent, secretMode=all), ag-740a6fb3-5aff-42e8-b5dd-0a8a57d6b4a5 (Radar, all), ag-1782273071167-th1q6f (Aurora, all), ag-1779381936325-6ki38t (Mjollnir, all).
- `select id, name from agent_groups` -> 4 rows: 103c34dd-...(local-qwen3.6), 740a6fb3-...(Radar), ag-1779381936325-6ki38t(Mjollnir), ag-1782273071167-th1q6f(Aurora).
- The three orphans named in the task description (Memory, Coder, Terminal Agent) are already gone — cleaned up by earlier teardown work (TASK-10/11/12) prior to this sweep. AC#1 held before this task started.
- `onecli agents secrets --id <id>` for Radar/Aurora/Mjollnir each returns the single vault secret id (6387482f-2fac-4ce4-a1bf-eb34633576b3, "Anthropic", host pattern api.anthropic.com); Default Agent's list is empty. No assignment references a nonexistent agent. AC#2 held before this task started.

Identifier rule verified against source (src/container-runner.ts:136-140, mirrored at src/teardown/agent-group-teardown.ts:606-609 `onecliIdentifier`): identifier = agentGroup.id when it starts with a letter (case-insensitive), else `ag-${id}`.

Wrote a real reconcile script (docs/state-discovery.md, "Orphan detection" section) that: fetches onecli agents via `--fields=identifier,name,secretMode` (never bare `onecli agents list`, which includes accessToken), fetches agent_groups via scripts/q.ts (no sqlite3 CLI), applies the exact identifier rule in python3, treats `default` as built-in (not orphan), and treats an agent_groups row with no matching identifier as normal (never spawned) rather than orphaned.

Ran the exact snippet as it now appears in the doc (extracted verbatim via sed, executed standalone):
  OK: 0 orphans. 4 onecli agents (incl. default) reconcile against 4 agent_groups rows.
  NOTE: no vault agent yet for (never spawned a container — not an orphan): local-qwen3.6

Verified the going-forward guarantee (AC-adjacent, TASK-14/29 claim in the task prompt):
- src/teardown/agent-group-teardown.ts:1016-1024 (step 10, not step 9 — the doc's pre-existing teardown-order list had 9/10 swapped vs. the actual source comments at lines 1009 "9. Per-group image tags" and 1016 "10. OneCLI vault agent"; fixed both the list and my new prose to say step 10) deletes the vault agent via `onecli agents delete --id <id>` and removes secret assignments; shared vault secrets survive.
- src/teardown/agent-group-teardown.ts:624-666 `findOnecliAgent` treats exec failure, JSON parse failure, or unexpected response shape as `unknown: true` (distinct from `agent: null` = confirmed absent).
- src/teardown/agent-group-teardown.ts:1064-1069 `collectIncomplete` surfaces `onecliUnknown` as an incomplete-teardown line.
- scripts/delete-agent-group.ts:153-162 exits 2 when `collectIncomplete` returns anything nonempty.
Confirmed: a teardown run that cannot verify vault-agent state cannot exit 0. The orphan class is closed at the source; the reconcile script is now a backstop, not the primary control.

secretMode audit (AC#3, decision reserved for the human/orchestrator, not changed here): every non-default agent is secretMode=all with exactly one vault secret in existence, so `all` and "selective, assigned to that one secret" are functionally identical today. Recorded in docs/state-discovery.md that this equivalence breaks the moment a second secret is added (auto-injects into every agent, no opt-in). Made no changes to secret mode or assignments.

Files changed: docs/state-discovery.md only. No code change — none was needed; AC#1 and AC#2 already held. Commit: 0977363f on branch task-16-delete-orphaned-onecli-vault-agents-and-audit-secret-assignments.

AC#3 resolved by the owner during orchestrator session be31f486 (2026-08-22): narrow rather than confirm. Radar (e8feaf79), Aurora (7d42c23f) and Mjollnir (956d711e) were set to secretMode=selective via 'onecli agents set-secret-mode --id <agent-id> --mode selective'; all three returned {"mode":"selective","status":"updated"}. Verified after the change: 'onecli agents list' reports selective for all three (default remains all), and 'onecli agents secrets --id <id>' still returns exactly ['6387482f-2fac-4ce4-a1bf-eb34633576b3'] for each — so the narrowing was a verified no-op for current behaviour. The built-in 'default' agent was deliberately left at 'all': it maps to no agent group, holds no explicit assignments, and is not on any group's container injection path. docs/state-discovery.md was swept for the stale 'all' claim in both places it appeared (the audit table's secretMode column and the prose paragraph).
<!-- SECTION:NOTES:END -->
