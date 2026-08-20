---
id: TASK-5
title: >-
  Make the Skylight MCP venv bootstrap fail loudly instead of silently
  half-installed
status: In Progress
assignee:
  - '@orchestrator'
created_date: '2026-07-29 13:49'
updated_date: '2026-08-20 23:06'
labels:
  - aurora
  - skylight
  - infra
  - reliability
dependencies: []
references:
  - docs/runbooks/aurora-skylight-mcp.md
priority: high
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found in Claude Code session 9631a530-018f-4442-9ef7-a9f840c12812 (2026-07-29). Runbook: docs/runbooks/aurora-skylight-mcp.md

Aurora's skylight MCP server is bootstrapped by the command/args stored in container_configs.mcp_servers, which begin:

  [ -d /workspace/.skylight-venv-0.2.2 ] || (python3 -m venv ... && .../pip install -q .../skylight-0.2.2-py3-none-any.whl)

The guard tests only that the directory EXISTS. python3 -m venv creates it before pip runs, so any pip failure leaves a directory that passes the guard forever after. Every subsequent launch skips reinstall and execs a Python that imports a venv missing most of its dependencies.

Hit this directly: a manual docker run without the OneCLI proxy CA failed pip with 'Could not find a suitable TLS CA certificate bundle, invalid path: /tmp/onecli-combined-ca.pem', leaving a broken .skylight-venv-0.2.2. The next run failed with ModuleNotFoundError: No module named 'anyio' - which looks like a code bug, not a provisioning one. Recovery is rm -rf on the venv directory, but nothing tells you that.

Options: gate on a sentinel file written only after pip exits 0; or gate on an actual import check (.../bin/python -c 'import server') and rebuild on failure; or drop -q from pip so the failure is at least visible in container logs.

Note this shell line lives in a DB column, not in any file under version control - anyone auditing the repo will not find it. That is arguably the deeper issue and may deserve its own task.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A failed pip install does not leave a venv directory that satisfies the guard on the next launch
- [ ] #2 The failure surfaces as a provisioning error, not as a downstream ModuleNotFoundError
- [ ] #3 Recovery steps are documented in docs/runbooks/aurora-skylight-mcp.md
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
AMENDED 2026-08-20 (session 9bcadaf6-3351-4862-8bee-85cc8b8f9834). This is no longer hypothetical -- it has now fired TWICE and is the root cause of an active outage.

Second occurrence: session sess-1782319186963-b2yjgn (Aurora's Discord-wired session, which hosts the 6am cron) has .skylight-venv-0.2.3/ containing ONLY _distutils_hack, pip, pkg_resources, setuptools. No skylight, no server module, no playwright, none of the ~60 deps. Directory timestamped Aug 16 19:42.

By contrast the Matrix session's .skylight-venv-0.2.3 is complete (fastmcp, playwright 1.62.0, server, skylight-0.2.3.dist-info + 60 dist-infos).

Consequence: every morning report from Aug 16 onward failed. Because the MCP server dies on import before registering, there is no tool error to quote -- the agent correctly reports 'Skylight MCP server disconnected' and cannot say why. Outbound seq 437/439/441 (Aug 16, 19, 20) are all degraded reports. Two rounds of CLAUDE.local.md 'fixes' were written against this, both targeting auth, neither addressing a dead process. See TASK-24.

Raising priority medium -> high.

RESOLVED 2026-08-20 (orchestrator session fe8a8e37). Two commits + one fix round.

The guard is now: a .provisioned sentinel inside the venv dir, written ONLY after a
post-install import check passes. Failure paths call fail() which exits 1 rather than
falling through to 'exec python -m server' -- that fall-through is what turned a
provisioning failure into a misleading ModuleNotFoundError. pip's -q is dropped and all
provisioning chatter goes to stderr so the MCP stdio JSON-RPC channel stays clean.

REVIEW CAUGHT A CRITICAL DEFECT in the first implementation. The probe was
'import server', but Skylight's server/__init__.py has ZERO module-level imports (docstring,
__all__, and a lazy __getattr__). So it passed on a venv holding the wheel and none of its
71 deps, then wrote a sentinel making that state permanent -- strictly worse than the
original bug, since recovery would also require knowing to delete the sentinel.
Corrected to 'import server.app', where 'from fastmcp import FastMCP' actually lives.
Verified in the real image: passes on the healthy 161-pkg venv (rc=0), fails on a
dependency-less 9-pkg venv (rc=1, ModuleNotFoundError: No module named 'fastmcp').

Also found during review: 'python -m server' puts cwd ahead of site-packages on sys.path,
so the server that actually executes is the READ-ONLY SOURCE MOUNT at
/workspace/extra/skylight, not the wheel copy in the venv. The venv only ever supplied
dependencies. The probe now runs from that same cwd so it validates what actually runs.

Other fixes in the same pass: rm -f the sentinel BEFORE rm -rf the venv (crash/concurrency
safety); a separate die() for post-provisioning failures so a missing mount no longer
advises rm -rf of a healthy 100MB venv; mkdir guarded; seeder VER 0.2.1 -> 0.2.3 (re-running
it would have silently downgraded Aurora).

THE LOGIC NOW LIVES IN THREE PLACES that must stay in sync, verified byte-identical
(whitespace-normalized) at merge time: the live container_configs.mcp_servers column
(authoritative), scripts/setup-aurora-agent.ts (the seeder), and the runbook's quoted block.

Outage remediation: removed the two half-built venvs
(sess-1782319186963-b2yjgn/.skylight-venv-0.2.3 -- the 6am cron session, and
sess-1782785033830-whzaig/.skylight-venv-0.2.1). Both were the failed-install signature.
They rebuild automatically on next launch. Did NOT run 'ncl groups restart' -- that would
push a live message to Aurora.

Hammer's live Matrix session venv (sess-1783609624398-smn6q9/.skylight-venv-0.2.3, 161 pkgs)
was hand-seeded with a sentinel rather than forced through a needless ~100MB rebuild, after
the CORRECTED probe was confirmed to pass against it.

Left alone deliberately: sess-1782319186963-b2yjgn/.skylight-venv-0.2.1 (16 pkgs, a likely
third half-built venv). It is an old version the current line never references -- sweep it
with TASK-6.
<!-- SECTION:NOTES:END -->
