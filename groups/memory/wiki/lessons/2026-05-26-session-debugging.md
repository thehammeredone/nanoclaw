---
title: Session Debugging Lessons — 2026-05-26/27
date: 2026-05-26
source-agent: unknown
tags: [nanoclaw, debugging, sessions, oncli, container-runner, sqlite, bugs]
---

# Session Debugging Lessons — 2026-05-26/27

Findings from a systematic debugging session using `scripts/session-diag.ts`.

## 1. Heartbeat path

Container heartbeat is at `<session-dir>/.heartbeat` (session root), **not** `agent/.heartbeat`. Easy to get wrong when writing tooling.

## 2. OneCLI identifier constraint — prefix UUID agent group IDs

OneCLI rejects identifiers that don't start with a letter. Agent group IDs starting with a digit (e.g. `54c8dbdf-...`) fail `POST /api/agents` with HTTP 400.

**Fix:** Prefix with `ag-` when the ID starts with a non-letter. Changed in `src/container-runner.ts`.

## 3. `containerPath` in `additionalMounts` must be relative

`container_configs.additional_mounts[].containerPath` must be a relative path (e.g. `"code"`), not absolute (e.g. `"/workspace/code"`). The mount validator rejects absolute paths silently (WARN, not error). Relative paths land at `/workspace/extra/<path>` inside the container.

**Important:** `groups/<folder>/container.json` is regenerated from the DB at spawn time — editing the file directly is overwritten. Fix mount paths in the DB directly.

## 4. `trigger=0` message stranding (known bug)

Messages written to `messages_in` while a container is running get `trigger=0` (context-only). If the container is then killed by the 30-minute heartbeat ceiling, these messages are orphaned: `countDueMessages` only counts `trigger=1`, so the sweep never re-wakes the session.

**Workaround:** `UPDATE messages_in SET trigger=1 WHERE status='pending' AND trigger=0`

**Needs:** Structural fix in the sweep's post-kill reset path.

## 5. Ghost sessions after restart (known bug)

`killContainer()` is a no-op for sessions not in the in-memory `activeContainers` map. After a service restart the map is empty, so sessions stuck with `container_status='running'` in the DB are never cleaned up by the sweep.

**Workaround:** Manual SQL reset of `container_status`.

**Needs:** Startup reconciliation sweep.

## 6. `pendingNonWake` false positive for future-scheduled tasks

`session-diag.ts` was flagging sessions with future `process_after` scheduled tasks as stuck. Fixed in the script by filtering `process_after <= now()` in the due-message count query.

## 7. OpenCode "no providers found"

A container agent using `provider: opencode` responds `Error: no providers found` if no OpenCode provider config exists in the mounted XDG data dir. OneCLI and NanoClaw wiring can be fully correct — the OpenCode config itself must be pre-populated before the container starts.

## Tools Added

- `scripts/session-diag.ts` — overview and per-session deep-dive across all DB layers + diagnosis

## Cross-references

- [How NanoClaw Groups and Agents Work](../insights/2026-05-21-nanoclaw-groups-and-agents.md) — session model, container lifecycle, DB layout
- [Ollama Provider Support](../insights/2026-05-21-ollama-provider-support.md) — container-runner.ts changes, env/blockedHosts
