---
id: TASK-25
title: Rebase hammer onto upstream main and review 3 months of changelog
status: To Do
assignee: []
created_date: '2026-08-20 15:01'
labels:
  - infra
  - upgrade
  - project
dependencies: []
references:
  - CHANGELOG.md
  - docs/v1-to-v2-changes.md
priority: medium
ordinal: 25000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found in Claude Code session 9bcadaf6-3351-4862-8bee-85cc8b8f9834 (2026-08-20). SEQUENCING: this runs AFTER the Aurora fixes (TASK-5, TASK-7, TASK-8, TASK-22). Do not interleave -- debugging a rebase and a broken agent at the same time is how both stay broken.

This install has drifted far from upstream:

  merge-base   0683c6ec  2026-05-18  (Merge PR #2536, v2.0.64 release notes)
  upstream     880 commits ahead     spans v2.0.64 -> v2.1.0 -> v2.1.17 -> v2.1.54 -> v2.2.0
  hammer        57 commits ahead

Upstream commit mix since merge-base: 118 fix, 96 feat, 92 docs, 86 chore, 33 refactor, plus channel/skill work. A minor version bump (2.0 -> 2.2) is in there, so breaking changes are likely.

PHASE 1 -- changelog review, REPORT BEFORE TOUCHING ANYTHING:
Read CHANGELOG.md across the range and summarise for the operator: breaking changes, new features worth adopting, fixes that affect this install (especially agent-runner, container config, scheduling, Matrix channel). Present findings and get a go/no-go before any rebase begins. This phase is the deliverable on its own.

PHASE 2 -- rebase:
Per CLAUDE.md branch strategy: main tracks upstream, hammer is local dev, and hammer must NEVER be merged into main. Bring upstream in via 'git checkout main && git pull' then rebase or cherry-pick onto hammer.

Known local divergences to carry:
- TASK-22 modifies container/agent-runner/src/poll-loop.ts. hammer has never touched poll-loop.ts or providers/claude.ts before that change, so it will be the first divergence in that file and a likely conflict site.
- Installation-specific state (groups/, .claude/settings.json, local configs) must not leak into any upstream-facing diff -- see the PR Hygiene section of CLAUDE.md.
- Channels and providers are skill-installed from sibling branches; check whether /update-skills needs a pass afterwards.

Consider whether /update-nanoclaw or /migrate-nanoclaw is the right vehicle rather than a hand rebase -- both skills exist for exactly this and may be cheaper than 880 commits of manual conflict resolution.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Changelog review across v2.0.64..v2.2.0 delivered to the operator with breaking changes called out
- [ ] #2 Go/no-go received before any rebase or merge is attempted
- [ ] #3 hammer rebased (or migrated) onto current upstream with all 57 local commits accounted for
- [ ] #4 main still tracks upstream only; hammer was never merged into main
- [ ] #5 Aurora and Radar both produce a correct scheduled report after the upgrade
<!-- AC:END -->
