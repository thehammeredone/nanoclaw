---
id: TASK-13
title: Decommission the local-qwen3.6 agent group
status: To Do
assignee: []
created_date: '2026-07-31 02:51'
updated_date: '2026-08-20 22:30'
labels:
  - ollama
dependencies: []
references:
  - docs/ollama.md
priority: low
ordinal: 13000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The "local one" -- the Ollama-backed experiment. Smallest surface of the four; nothing depends on it.

  agent group:  103c34dd-8610-4bd6-9fa0-b9b98f79941d  "local-qwen3.6"
  folder:       groups/local-qwen3.6/ -- container.json only, no CLAUDE.md was ever written
  container_config row (cascades)
  session dir:  data/v2-sessions/103c34dd-8610-4bd6-9fa0-b9b98f79941d/ exists on disk even though there
                is NO sessions row for this group in the central DB. The directory has to be removed by
                hand; a DB-driven sweep will not find it.
  No wirings, no destinations (in or out), no members, no OneCLI agent, no docker image tag.

Keep, do not remove: the Ollama provider support itself. The env / blockedHosts fields on ContainerConfig
and docs/ollama.md are generic host capability, not group-specific. Removing the group must not touch them.

Note for later: the Claude Code memory file project_ollama_provider.md is largely about this group and goes
stale on deletion -- but it also records the correct systemd service name (nanoclaw-v2-b3501fc6), which is
still needed. Rewrite rather than delete.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 agent_groups row and container_configs row for 103c34dd removed
- [ ] #2 groups/local-qwen3.6/ and the orphaned data/v2-sessions/103c34dd-.../ directory deleted
- [ ] #3 Ollama provider support in ContainerConfig and docs/ollama.md left untouched
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Provenance: Claude Code session 9934a222-4185-48a6-8de2-07b8bbe71cf7 (2026-07-30). Discovery data and reasoning: docs/work-records/2026-07-30-decommission-planning-aurora-discord-wiring-and-four-agent-groups.md and docs/state-discovery.md

CORRECTION 2026-08-20 (orchestrator session fe8a8e37), verified against source:

'The directory has to be removed by hand; a DB-driven sweep will not find it' is false.
scripts/delete-cli-agent.ts:70-72 keys its removal on the AGENT GROUP ID, not on sessions rows:
  const sessionsDir = path.join(DATA_DIR, 'v2-sessions', ag.id);
  fs.rmSync(sessionsDir, { recursive: true });
and it resolves ag via getAgentGroupByFolder(--folder). local-qwen3.6 still has its
agent_groups row (103c34dd-8610-4bd6-9fa0-b9b98f79941d, folder 'local-qwen3.6'), so
'pnpm exec tsx scripts/delete-cli-agent.ts --folder local-qwen3.6' removes the session
directory along with groups/local-qwen3.6/.

The ordering constraint that does matter: it looks the group up by folder, so it must run
BEFORE the agent_groups row is deleted, not after. docs/state-discovery.md:205-209 already
describes this behavior correctly.
<!-- SECTION:NOTES:END -->
