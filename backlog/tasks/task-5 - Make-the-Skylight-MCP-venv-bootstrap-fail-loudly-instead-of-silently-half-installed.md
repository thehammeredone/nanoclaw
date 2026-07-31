---
id: TASK-5
title: >-
  Make the Skylight MCP venv bootstrap fail loudly instead of silently
  half-installed
status: To Do
assignee: []
created_date: '2026-07-29 13:49'
labels:
  - aurora
  - skylight
  - infra
  - reliability
dependencies: []
references:
  - docs/runbooks/aurora-skylight-mcp.md
priority: medium
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
