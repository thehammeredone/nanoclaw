---
id: TASK-12
title: Decommission the Terminal Agent and decide the fate of the CLI messaging group
status: To Do
assignee: []
created_date: '2026-07-31 02:50'
updated_date: '2026-07-31 03:18'
labels:
  - setup
dependencies: []
references:
  - setup/auto.ts
  - scripts/delete-cli-agent.ts
priority: medium
ordinal: 12000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The "terminal one". This group is the leftover scratch agent from setup's ping-pong test that was never
cleaned up -- setup/auto.ts:340 creates it with --folder _ping-test, and setup/auto.ts:365 is supposed to
remove it again via scripts/delete-cli-agent.ts --folder _ping-test. Running that script by hand is
exactly the intended teardown path.

  agent group:  ag-1779227551242-zf47au  "Terminal Agent"
  folder:       groups/_ping-test/
  wiring:       mga-1779227551244-ohvhz7 -> cli messaging group mg-1779227551244-r6tvmp "Local CLI"
                (shared / pattern ".") -- the only wiring on the cli channel
  session:      sess-1779382715745-e8sfih
  session dir:  data/v2-sessions/ag-1779227551242-zf47au/
  destinations: local-cli (channel -> mg-1779227551244-r6tvmp) and memory (agent -> f09aa5a1-...)
  OneCLI agent: 58026a01-33b1-4485-a804-f897fa6e6d61
  No per-group docker image tag.

Open decision -- the cli messaging group. delete-cli-agent.ts deliberately leaves messaging groups intact
so a future CLI agent can reuse them. Once this wiring is gone, mg-1779227551244-r6tvmp has no agents and
scripts/chat.ts has nothing to talk to. Either delete it too, or keep it and accept a dangling row.
Confirm that a future `pnpm exec tsx scripts/init-cli-agent.ts` / setup run recreates whatever it needs.

Note for later: the Claude Code memory file feedback_not_terminal_agent.md is named after this group. Its
actual content (the host Claude Code session has no agent-runner MCP tools) stays true, but the framing
should be reworded once "Terminal Agent" no longer exists.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 agent_groups row, wiring, session and destinations for ag-1779227551242-zf47au removed
- [ ] #2 groups/_ping-test/ and data/v2-sessions/ag-1779227551242-zf47au/ deleted from disk
- [ ] #3 OneCLI agent 58026a01 deleted
- [ ] #4 Explicit decision on keeping or deleting cli messaging group mg-1779227551244-r6tvmp
- [ ] #5 Confirmed a fresh setup run still provisions its ping-test agent correctly
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Provenance: Claude Code session 9934a222-4185-48a6-8de2-07b8bbe71cf7 (2026-07-30). Discovery data and reasoning: docs/work-records/2026-07-30-decommission-planning-aurora-discord-wiring-and-four-agent-groups.md and docs/state-discovery.md
<!-- SECTION:NOTES:END -->
