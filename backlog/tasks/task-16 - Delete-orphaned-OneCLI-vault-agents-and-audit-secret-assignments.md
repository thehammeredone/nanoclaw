---
id: TASK-16
title: Delete orphaned OneCLI vault agents and audit secret assignments
status: In Progress
assignee:
  - '@orchestrator'
created_date: '2026-07-31 03:19'
updated_date: '2026-08-22 17:50'
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
<!-- SECTION:NOTES:END -->
