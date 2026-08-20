---
id: TASK-19
title: Move Skylight credentials out of plaintext into the OneCLI vault
status: Needs Review
assignee: []
created_date: '2026-07-31 03:20'
updated_date: '2026-08-20 23:57'
labels:
  - skylight
dependencies: []
references:
  - docs/runbooks/aurora-skylight-mcp.md
priority: high
ordinal: 19000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The Skylight account email and password appear in plaintext in at least two places:

1. messages_in.content of the scheduled morning-brief row (session sess-1782319186963-b2yjgn). The prompt literally contains SKYLIGHT_EMAIL="..." SKYLIGHT_PASSWORD="..." as part of the shell command it tells the agent to run. Anything that dumps that row -- a debug query, a work record, a transcript -- leaks the account.
2. The Skylight MCP server's env block in container_configs, materialized to groups/skylight-morning/container.json at spawn.

Per project_aurora_agent memory, these have already been printed into session transcripts several times via .env reads, ps aux, and `ncl groups config get`.

This is exactly what the OneCLI vault exists for: secrets injected per request at the proxy, never in env vars and never in chat context (see the Secrets/Credentials section of CLAUDE.md). Skylight is the outlier.

Complication worth checking first: Skylight auth is a headless-Chromium login that produces a token, not a simple API key. Confirm the vault can hold the resulting token and that the capture flow can read credentials from the vault rather than from env, before committing to an approach.

TASK-7 rewrites the scheduled prompt anyway -- that is the natural moment to drop the credentials from it, whatever the longer-term storage answer turns out to be.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 No Skylight credentials in any messages_in row
- [ ] #2 No Skylight credentials in container_configs or a materialized container.json
- [ ] #3 Skylight auth works end to end through the vault, verified by a real morning report
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Provenance: Claude Code session 9934a222-4185-48a6-8de2-07b8bbe71cf7 (2026-07-30). Discovery data: docs/work-records/2026-07-30-decommission-planning-aurora-discord-wiring-and-four-agent-groups.md and docs/state-discovery.md

INVESTIGATION 2026-08-20 (orchestrator session fe8a8e37). The 'complication worth checking first' is confirmed BLOCKING as specified.

AC#1 IS ALREADY SATISFIED, as a side effect of TASK-7 and TASK-8. Swept every remaining
inbound.db across all sessions for SKYLIGHT_PASSWORD / SKYLIGHT_EMAIL / the account address:
ZERO hits. The credential-bearing prompt lived in session sess-1782319186963-b2yjgn, which
TASK-8 deleted outright, and TASK-7's replacement schedule defers entirely to CLAUDE.local.md.

AC#2 / AC#3 ARE NOT REACHABLE by moving the password into the vault. Evidence:
- onecli 2.2.0 'secrets create' exposes only --name, --type (anthropic|generic), --value,
  --host-pattern. The model is host-pattern matching plus an injectionConfig applied to
  outbound HTTP requests at the proxy.
- GET /api/secrets (probed on both 127.0.0.1:10254 and 172.17.0.1:10254) returns metadata
  ONLY -- id, name, type, hostPattern, pathPattern, injectionConfig, scope, createdAt.
  There is NO value field and no read-the-secret endpoint. By design the vault never hands
  plaintext back to the consuming process.
- Skylight auth is a headless-Chromium form login: server/token_capture.py drives Playwright
  to TYPE the email and password into DOM fields. At the instant the credential is needed
  there is no HTTP request in flight for a proxy to inject into, and the Python process can
  never obtain the value from the vault.
The vault currently holds exactly one secret (Anthropic, api.anthropic.com). Skylight is the
outlier precisely because it is not an API-key-in-a-header service.

WHAT IS ACTUALLY POSSIBLE (needs an operator decision):
 (a) Vault the TOKEN, not the password. Once capture succeeds, Skylight /api/ calls are
     ordinary HTTP with a bearer token, so a generic secret with hostPattern
     app.ourskylight.com could be proxy-injected. But tokens expire with no refresh flow, and
     re-capture still needs the password -- so this shrinks the exposure window without
     eliminating the plaintext password.
 (b) Move the password out of container_configs into a separate store the MCP can read
     (e.g. a file mounted read-only from outside /workspace/extra/). The runbook already
     notes additional_mounts would need to target a path outside /workspace/extra/.
     This keeps a plaintext secret on disk but removes it from the DB and container.json.
 (c) Redact at the leak site instead of relocating the secret. The task's stated harm is
     leakage into transcripts via 'ncl groups config get', .env reads and ps aux. Teaching
     the CLI/config surface to mask secret-shaped env values addresses that directly and is
     self-contained.
 (d) Accept the status quo and close AC#2/#3 as won't-fix, keeping AC#1.

Not proceeding unilaterally: this is a security-architecture choice with materially different
outcomes and no safe default, and the task itself says to confirm viability before committing
to an approach.

PARKED 2026-08-20 by the orchestrator at the operator's direction. AC#1 is done and verified; AC#2/#3 await an architecture decision between the four options above. Moved to Needs Review so the orchestrator's selector can advance past it.
<!-- SECTION:NOTES:END -->
