---
id: TASK-27
title: >-
  Fix scripts/setup-aurora-agent.ts silently regressing Aurora's live container
  config
status: In Progress
assignee:
  - '@orchestrator'
created_date: '2026-08-20 23:07'
updated_date: '2026-08-26 19:03'
labels:
  - aurora
  - skylight
  - infra
  - reliability
dependencies: []
priority: medium
ordinal: 27000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found during TASK-5 review (orchestrator session fe8a8e37, 2026-08-20).

scripts/setup-aurora-agent.ts is documented as idempotent and safe to re-run, and it calls updateContainerConfigJson(ag.id, 'mcp_servers', ...) UNCONDITIONALLY -- it overwrites the live column wholesale. Two concrete regressions it would cause today:

1. ENV KEY LOSS. The live column's env carries PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH; the seeder's env object does not set it. Re-running the seeder DROPS that key -- which is precisely the Playwright-Python fix documented at length in docs/runbooks/aurora-skylight-mcp.md (Playwright Python ignores the image-level env var, so server/token_capture.py reads it and passes executable_path to chromium.launch). Losing it means authenticate() cannot launch a browser at all.

2. VERSION DOWNGRADE (already fixed once). The seeder was pinned at VER=0.2.1 while live was 0.2.3; TASK-5 corrected it to 0.2.3, but nothing prevents the same drift recurring, because the version is a literal in two files.

The general defect: a 'safe to re-run' seeder that clobbers hand-tuned live state is not safe to re-run. It should either merge rather than overwrite, refuse to run against an already-configured group without an explicit --force, or diff-and-confirm.

Related: the three-way duplication task filed alongside this one.
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-08-26 (orchestrator, task-26 merge): regressions #1 and #2 in this description are now CLOSED by task-26.
- #2 (version downgrade): the VER literal now exists in exactly one version-controlled place, scripts/skylight-mcp-bootstrap.sh, and scripts/skylight-mcp-bootstrap.test.ts fails on drift between it, the seeder, and the runbook. The two-files-with-a-literal condition no longer exists.
- #1 (env key loss): PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH was added to the seeder's env in task-26, because task-26's new runbook procedure instructs operators to re-run the seeder. Verified at that time that the live skylight.env is exactly the six keys the seeder now writes, with matching values -- so a re-run is a no-op today.
The GENERAL defect this task is actually about is UNCHANGED and still open: updateContainerConfigJson(ag.id, 'mcp_servers', ...) is still an unconditional wholesale overwrite. It should merge, require --force against an already-configured group, or diff-and-confirm. #1 was patched by hand, not mechanised -- the next key someone tunes live will be dropped the same way.

2026-08-26 (orchestrator): IMPLEMENTATION COMPLETE, REVIEW NOT YET RUN. The usage window hit FINISH_ONLY before the review gate could be dispatched. Do NOT merge this branch until it has passed the two-stage review (spec compliance + code-review at high). Resume by dispatching the reviewer against 'git diff hammer..HEAD' on branch task-27-fix-scripts-setup-aurora-agent-ts-silently-regressing-aurora-s-live-container-config; the implementer's work is fully committed (f31defc6, 21a6a7e8, ba2f7680) and the tree is clean.

Shape chosen for the general defect: diff-and-confirm by default, --force to skip the prompt, --dry-run to preview. Non-interactive safety is handled by checking process.stdin.isTTY -- a non-TTY run takes the refuse branch without reading stdin, so it cannot hang under automation. Core logic is a pure no-I/O decision function planMcpServersUpdate() in the new scripts/mcp-servers-guard.ts, tested hermetically against a fixture DB (15 tests) rather than the real data/v2.db.

FOLLOW-UP TO FILE once this merges (AC#5 finding, deliberately out of scope here): the same unconditional wholesale-overwrite pattern survives unprotected in TWO more call sites in the very same file -- scripts/setup-aurora-agent.ts:177 (packages_apt) and :182 (additional_mounts), both via updateContainerConfigJson. So re-running the seeder is still not fully safe: mcp_servers is now guarded but hand-tuned apt packages and mounts are still clobbered silently. The implementer checked the rest of the tree: no other script under scripts/ has the defect, and src/modules/self-mod/apply.ts and src/cli/resources/groups.ts already read-then-merge.
<!-- SECTION:NOTES:END -->
