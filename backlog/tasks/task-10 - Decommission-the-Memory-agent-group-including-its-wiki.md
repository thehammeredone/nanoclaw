---
id: TASK-10
title: Decommission the Memory agent group including its wiki
status: In Progress
assignee:
  - '@orchestrator'
created_date: '2026-07-31 02:50'
updated_date: '2026-08-21 00:25'
labels:
  - memory
dependencies:
  - TASK-9
references:
  - scripts/delete-cli-agent.ts
  - docs/db-central.md
priority: medium
ordinal: 10000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Delete the Memory agent group outright. Hammer confirmed the wiki and files go too -- no archive, no export.

  agent group:  f09aa5a1-bea7-410a-a319-f20da1549703  "Memory"
  folder:       groups/memory/ (84K)
                  wiki/index.md, wiki/log.md
                  wiki/insights/ (4 files), wiki/lessons/ (1), wiki/behaviors/mjollnir.md
                  plans/agent-usage-dashboard.md, sources/ (empty)
                  CLAUDE.md, CLAUDE.local.md, .claude-shared.md, .claude-fragments/, container.json
  session:      sess-1779408615722-vkahs4 -- messaging_group_id is NULL. Memory was never wired to a
                channel; it only ever existed as an agent-to-agent destination.
  session dir:  data/v2-sessions/f09aa5a1-bea7-410a-a319-f20da1549703/
  container_config row (ON DELETE CASCADE, so it goes automatically)
  OneCLI agent: 48d0d710-48a6-424c-8cbf-c42d98ff0bdd  identifier f09aa5a1-...
  No per-group docker image tag exists for this group.
  No wirings, no members, no roles scoped to it.

Tooling: pnpm exec tsx scripts/delete-cli-agent.ts --folder memory does the right thing for the group
itself -- it sweeps every table carrying an agent_group_id column, deletes the agent_groups row, and
removes both groups/memory/ and the session dir. Despite the name it is not specific to the CLI agent.

It does NOT handle: the inbound references in TASK-9, or the OneCLI agent. Do TASK-9 first.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 agent_groups row and every dependent row for f09aa5a1 removed
- [ ] #2 groups/memory/ and data/v2-sessions/f09aa5a1-.../ deleted from disk
- [ ] #3 OneCLI agent 48d0d710 deleted along with its secret assignments
- [ ] #4 No surviving agent references memory as a destination
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Provenance: Claude Code session 9934a222-4185-48a6-8de2-07b8bbe71cf7 (2026-07-30). Discovery data and reasoning: docs/work-records/2026-07-30-decommission-planning-aurora-discord-wiring-and-four-agent-groups.md and docs/state-discovery.md

RESOLVED 2026-08-20 (orchestrator session fe8a8e37).

Ran scripts/delete-cli-agent.ts --folder memory. Verified independently afterwards:
  dependent rows across all 10 agent_group_id tables: 0
  agent_groups row: 0        (6 groups remain, was 7)
  PRAGMA foreign_key_check: clean     PRAGMA integrity_check: ok
  groups/memory/ and data/v2-sessions/f09aa5a1-.../ both gone
  git diff touches ONLY groups/memory/ -- 10 files, 671 deletions

AC#4 WAS ALREADY SATISFIED before this task ran: TASK-9 deleted the inbound
agent_destinations rows, so SELECT COUNT(*) ... WHERE target_id='f09aa5a1-...' was already 0.
The dependency ordering the task insisted on is what made this clean -- delete-cli-agent.ts
only sweeps OUTBOUND edges (rows where agent_group_id = the group being deleted), so had
TASK-9 not run first, Mjollnir and Terminal Agent would still be pointing at a group that no
longer exists.

AC#3: OneCLI agent 48d0d710 deleted. It had exactly one secret assigned --
6387482f 'Anthropic' (api.anthropic.com), which is the SHARED key used by every agent. Only
the assignment went away; the vault secret itself is intact. 6 OneCLI agents remain
(Default, Radar, Aurora, Coder, Terminal Agent, Mjollnir), matching the 6 agent groups.

The root-owned Docker mount-stub problem seen in TASK-8 did NOT occur here -- this group's
session dir had no bind-mount targets. The guidance stays in TASK-14/TASK-17 for the groups
that do.

A disposable pre-delete backup (db snapshot + tars of both directories + a row dump) was
written to the session scratchpad OUTSIDE the repo. That is operator insurance for the delete
window, not an archive -- the operator confirmed the wiki and files go with no archive or
export, and nothing was retained in-repo.

Note this install DOES track per-group wiki/CLAUDE.local.md content in git (only CLAUDE.md
and container.json are gitignored), which is why a decommission that looked like it would
have no repo diff produced a 10-file deletion.

REVIEW NOTE: spec compliance verified by the orchestrator directly against the live DB, disk,
and OneCLI. No code-quality gate: the diff is a pure deletion of a decommissioned group's
markdown, with no correctness surface for code-review to read.
<!-- SECTION:NOTES:END -->
