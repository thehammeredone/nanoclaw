---
id: TASK-33
title: >-
  Guard the remaining unconditional container-config overwrites in
  setup-aurora-agent.ts
status: To Do
assignee: []
created_date: '2026-08-27 00:18'
labels:
  - aurora
  - skylight
  - infra
  - tech-debt
dependencies: []
ordinal: 33000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up from TASK-27 (orchestrator run 2026-08-26, merged ef189dd1).

TASK-27 put a diff-and-confirm guard on setup-aurora-agent.ts's mcp_servers write, but deliberately scoped out two sibling call sites in the same file that still overwrite the live container config wholesale:

  - scripts/setup-aurora-agent.ts, packages_apt      (via updateContainerConfigJson)
  - scripts/setup-aurora-agent.ts, additional_mounts (via updateContainerConfigJson)

So re-running the seeder is now safe for mcp_servers but still silently clobbers hand-tuned apt packages and mounts. That is the same class of defect TASK-27 was filed for -- it just has not bitten yet because nobody has hand-tuned those two columns on the Aurora group.

The machinery already exists and is generic: planMcpServersUpdate / mcpServersDiffText / confirmOverwrite in scripts/mcp-servers-guard.ts. The work is mostly renaming that module to something column-agnostic and routing the other two writes through it, so --dry-run and --force keep meaning the same thing for every column the seeder touches.

Verified during TASK-27 review that no OTHER script under scripts/ has this defect, and that src/modules/self-mod/apply.ts and src/cli/resources/groups.ts already read-then-merge before writing.
<!-- SECTION:DESCRIPTION:END -->
