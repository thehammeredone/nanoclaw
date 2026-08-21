---
id: TASK-11
title: Decommission the Coder agent group
status: Done
assignee:
  - '@orchestrator'
created_date: '2026-07-31 02:50'
updated_date: '2026-08-21 00:31'
labels:
  - coder
dependencies:
  - TASK-9
references:
  - scripts/delete-cli-agent.ts
priority: medium
ordinal: 11000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
agent group:  54c8dbdf-7703-4567-801c-da5a830cb7fd  "Coder"
  folder:       groups/coder/ (20K -- CLAUDE.md, CLAUDE.local.md, .claude-shared.md, .claude-fragments/, container.json)
  session:      sess-1779715155692-4dh4dv -- messaging_group_id NULL, agent-to-agent only, never channel-wired
  session dir:  data/v2-sessions/54c8dbdf-7703-4567-801c-da5a830cb7fd/
  container_config: provider = opencode (the only row in container_configs with a non-null provider)
  OneCLI agent: c982a432-fbc5-4b76-83f2-f0f9262e9828  identifier ag-54c8dbdf-...
  Inbound reference: Mjollnir's "coder" destination -- handled by TASK-9.
  No per-group docker image tag, no wirings, no members.

Same tool as TASK-10: pnpm exec tsx scripts/delete-cli-agent.ts --folder coder.

DECIDED (Hammer, 2026-07-30): the opencode provider install STAYS. Coder is its only current consumer,
but the local-model and coding-agent ideas are being revisited in a different form later. Do not remove
src/providers/ opencode support or anything installed by /add-opencode as part of this teardown.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 agent_groups row and every dependent row for 54c8dbdf removed
- [x] #2 groups/coder/ and data/v2-sessions/54c8dbdf-.../ deleted from disk
- [x] #3 OneCLI agent c982a432 deleted along with its secret assignments
- [x] #4 opencode provider install left intact (decided 2026-07-30 — revisit planned)
<!-- AC:END -->









## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Provenance: Claude Code session 9934a222-4185-48a6-8de2-07b8bbe71cf7 (2026-07-30). Discovery data and reasoning: docs/work-records/2026-07-30-decommission-planning-aurora-discord-wiring-and-four-agent-groups.md and docs/state-discovery.md

RESOLVED 2026-08-20 (orchestrator session fe8a8e37).

Verified independently after deletion:
  dependent rows across all 10 agent_group_id tables: 0    agent_groups row: 0
  PRAGMA foreign_key_check clean, integrity_check ok
  groups/coder/ and data/v2-sessions/54c8dbdf-.../ both gone
  git diff = exactly one path, groups/coder/CLAUDE.local.md
  5 agent groups remain: Terminal Agent, Mjollnir, local-qwen3.6, Aurora, Radar
  5 OneCLI agents remain (Coder's c982a432 deleted; it held only the SHARED Anthropic
  secret assignment, so the vault secret itself is untouched)

THE ROOT-OWNED MOUNT-STUB PROBLEM DID FIRE HERE, as anticipated from TASK-8.
delete-cli-agent.ts completed the DB transaction and removed groups/coder/, then threw
EACCES on the session dir: extra/, extra/code/ and group/ were root-owned Docker bind-mount
targets. Cleared with a throwaway alpine:3 container running as uid 0, bind-mounted ONLY to
that group's session dir and guarded by a shell case-match on the exact id suffix, then
rmdir'd from the host. This is the second confirmed occurrence -- TASK-10's group had none,
so it depends on which mounts a group used. The guidance is already recorded in TASK-14 and
TASK-17; this occurrence proves delete-cli-agent.ts genuinely needs the fix rather than it
being hypothetical.

AC#4 (opencode stays) PROVEN, not asserted: all 7 install files still present,
src/providers/index.ts:7 still imports './opencode.js', and all four suites pass --
pnpm test 339/339, host tsc clean, container tsc clean, bun test 102/102 including
opencode.factory.test.ts and mcp-to-opencode.test.ts.

PRESERVED DELIBERATELY: Coder's container_configs row was the ONLY row in that table with a
non-null provider, i.e. the sole worked example of how an opencode-backed group is configured.
Verified after deletion that the table now has zero non-null provider rows. The decoded row is
saved outside the repo at <scratchpad>/task11/coder-container-config-PRESERVED.md for whoever
revisits the local-model idea. A secret scan found nothing needing redaction (this schema has
no env column; mcp_servers was {}).

REVIEW NOTE: spec compliance verified by the orchestrator against the live DB, disk, OneCLI,
and all four test suites. No code-quality gate -- the diff is a single file deletion.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Deleted the Coder agent group, its session, and OneCLI vault agent c982a432. Zero rows remain across all ten agent_group_id tables; foreign_key_check and integrity_check clean; diff is a single file deletion. The root-owned Docker mount-stub problem predicted by TASK-8 fired here for the first time - delete-cli-agent.ts threw EACCES on the session dir - and was cleared with a guarded throwaway-container removal. AC#4 proven rather than asserted: the opencode provider install is fully intact, with all four test/typecheck suites passing including the Bun-side opencode factory tests. Coder's container_configs row, the only non-null-provider row in the install, was preserved outside the repo as the sole worked example of an opencode group config.
<!-- SECTION:FINAL_SUMMARY:END -->
