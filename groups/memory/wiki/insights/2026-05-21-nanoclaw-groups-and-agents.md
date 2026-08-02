---
title: How NanoClaw Groups and Agents Work
date: 2026-05-21
source-agent: host-session
tags: [nanoclaw, architecture, groups, agents, channels, routing]
---

# How NanoClaw Groups and Agents Work

## Core Concepts

**Agent groups** are independent AI personas. Each has its own:
- Persistent workspace on disk (`groups/<folder>/`)
- `CLAUDE.local.md` — personality, instructions, behavioral context
- Container config (model, packages, MCP servers)
- Conversation history and memory

Multiple agent groups can coexist. They are fully isolated by default.

**Messaging groups** are a single chat or channel on a single platform (one Discord channel, one Telegram DM, one Slack thread root). Identity = `(channel_type, platform_id)`.

**Wirings** connect a messaging group to an agent group. One messaging group can wire to multiple agents; one agent can be wired to multiple messaging groups.

**Sessions** are the runtime unit: one `(agent_group, messaging_group, thread)` combination. Each session gets its own container with inbound and outbound SQLite DBs.

## Routing Flow

```
Discord message → channel adapter → router → messaging_group lookup
  → wiring → agent_group → session → inbound.db → container spawned
  → agent polls inbound.db → calls Claude API (via OneCLI proxy)
  → writes to outbound.db → host polls outbound.db → delivers via adapter
```

## Current Install (as of 2026-05-21)

| Group | Folder | Channel | Notes |
|-------|--------|---------|-------|
| Mjollnir | `dm-with-hammer` | Discord `#assistant` | Main user-facing agent |
| Terminal Agent | `_ping-test` | Local CLI | Dev/test agent |
| Memory | `memory` | None (agent-to-agent only) | Knowledge base agent |
| local-qwen3.6 | `local-qwen3.6/` | Not wired yet | Ollama-routed Qwen 35b; needs `/manage-channels` |

## Agent-to-Agent Messaging

Agents can message each other via `send_message(to="agent-name")`. This requires an `agent_destinations` row granting the source agent permission to reach the target.

Current wiring:
- Mjollnir → Memory (local name: `memory`)
- Terminal Agent → Memory (local name: `memory`)

The Memory agent has no channel wiring — it is reachable only by other agents.

## Key Files

| Path | Purpose |
|------|---------|
| `groups/<folder>/CLAUDE.local.md` | Per-agent personality and instructions |
| `groups/<folder>/CLAUDE.md` | Composed at spawn — do not edit directly |
| `data/v2.db` | Central DB: groups, wirings, users, sessions |
| `data/v2-sessions/` | Per-session inbound/outbound DBs |
| `src/router.ts` | Inbound routing logic |
| `src/delivery.ts` | Outbound delivery + agent-to-agent routing |

## OneCLI Proxy (Important)

Agent containers call the Anthropic API via the OneCLI proxy at `host.docker.internal:10255`. On this install, OneCLI is bound to `172.17.0.1` (Docker bridge IP) rather than `127.0.0.1` — this was required for containers to reach it in WSL2. The `ONECLI_URL` in `.env` is set to `http://172.17.0.1:10254` accordingly.

See memory entry: [[onecli-binding]]

## System Notes

- **systemd unit:** `nanoclaw-v2-b3501fc6.service` (not `nanoclaw.service`)
- **Claude Code vs Terminal Agent:** Separate processes — MCP tools like `send_message` are not available from host Claude Code sessions

## Cross-references

- [Ollama Provider Support](2026-05-21-ollama-provider-support.md) — how Ollama routing works, env/blockedHosts config, available models
