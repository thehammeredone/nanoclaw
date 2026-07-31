---
id: TASK-20
title: Refresh docs and runbooks after the decommission lands
status: To Do
assignee: []
created_date: '2026-07-31 03:20'
labels:
  - cleanup
dependencies:
  - TASK-8
  - TASK-10
  - TASK-11
  - TASK-12
  - TASK-13
references:
  - docs/runbooks/matrix-homeserver-resume.md
  - docs/state-discovery.md
priority: low
ordinal: 20000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Docs that describe the current roster or wiring go stale the moment the decommission lands. Do this pass at the end, once TASK-8 through TASK-13 are done, not before.

Known stale-on-completion:
  docs/runbooks/matrix-homeserver-resume.md -- its key-facts table includes the Discord wiring id, which TASK-8 deletes.
  docs/runbooks/aurora-skylight-mcp.md -- check for references to the Discord session, which is where the schedule currently lives.
  CLAUDE.md -- the Self-Modification and Skills sections are generic, but re-read for any group-specific claim.
  docs/state-discovery.md -- the stable sections should survive unchanged by design. If any of them needed editing, that is a signal the volatile/stable split was drawn in the wrong place; note where.

Also re-run the orphan-detection queries from docs/state-discovery.md as a final check, and confirm the surviving agents (Mjollnir, Radar, Aurora) each still respond on their live channels.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 No doc or runbook references a deleted group, wiring or session
- [ ] #2 Orphan-detection queries re-run clean
- [ ] #3 Mjollnir, Radar and Aurora each verified responding on their live channels
- [ ] #4 Any place docs/state-discovery.md needed editing is noted as a mis-drawn volatile/stable boundary
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Provenance: Claude Code session 9934a222-4185-48a6-8de2-07b8bbe71cf7 (2026-07-30). Discovery data: docs/work-records/2026-07-30-decommission-planning-aurora-discord-wiring-and-four-agent-groups.md and docs/state-discovery.md
<!-- SECTION:NOTES:END -->
