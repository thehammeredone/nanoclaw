---
id: TASK-13
title: Decommission the local-qwen3.6 agent group
status: To Do
assignee: []
created_date: '2026-07-31 02:51'
updated_date: '2026-07-31 03:18'
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
<!-- SECTION:NOTES:END -->
