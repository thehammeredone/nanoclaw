---
id: TASK-12
title: Decommission the Terminal Agent and decide the fate of the CLI messaging group
status: In Progress
assignee:
  - '@orchestrator'
created_date: '2026-07-31 02:50'
updated_date: '2026-08-21 00:36'
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

RESOLVED 2026-08-20 (orchestrator session fe8a8e37).

AC#4 DECISION: DELETE the CLI messaging group mg-1779227551244-r6tvmp. Decided on evidence,
not preference. scripts/init-cli-agent.ts:128-141 does a get-or-create on the CLI messaging
group keyed by (channel_type='cli', platform_id='local'):
    let cliMg = getMessagingGroupByPlatform(CLI_CHANNEL, CLI_PLATFORM_ID);
    if (!cliMg) { cliMg = {...name:'Local CLI'...}; createMessagingGroup(cliMg); }
and the same get-or-create for the wiring at :143-160 via getMessagingGroupAgentByPair.
setup/auto.ts:340 invokes exactly that script. So deletion is SELF-HEALING -- the next setup
or init-cli-agent run recreates group and wiring from nothing. Keeping it would have left a
permanently agentless row with unknown_sender_policy='public'.

Confirmed nothing else depends on that specific id: scripts/chat.ts uses a Unix socket with no
hardcoded id; src/channels/cli.ts:45 resolves dynamically by (channel_type, platform_id), not
by row id, and was NOT touched -- it is main-shipped infrastructure and the adapter stays
registered. user_dms / unregistered_senders / pending_sender_approvals /
pending_channel_approvals all had zero rows for that mg, so nothing dangled
(unregistered_senders matters here: it has NO FK and would have dangled silently).

AC#5 verified by code trace, not by running setup: setup/auto.ts:340 ->
init-cli-agent.ts, which creates agent group (:105-119), filesystem scaffold (:120-125),
messaging group (:128-141) and wiring (:143-160) -- all three from nothing.

Verified after deletion: 0 dependent rows across all 10 agent_group_id tables, agent_groups
row gone, messaging_groups row gone, ZERO cli messaging groups remain, foreign_key_check
clean, integrity_check ok. 4 agent groups left (Mjollnir, local-qwen3.6, Aurora, Radar) and
4 OneCLI agents (Default, Radar, Aurora, Mjollnir). All 4 surviving agent_destinations rows
are channel-type and resolve.

The root-owned mount-stub problem did NOT occur here (it did in TASK-11, not in TASK-10/12) --
it depends on which mounts a group actually used.

setup/auto.ts:14,61 still defines CLI_AGENT_NAME = 'Terminal Agent'. Left deliberately: that
names the NEXT scratch agent setup will create, so it is forward-looking and still correct.
The operator's own Claude Code memory file feedback_not_terminal_agent.md was left to the
orchestrator to reword (it lives outside this repo).
<!-- SECTION:NOTES:END -->
