---
title: Ollama Provider Support in NanoClaw v2
date: 2026-05-21
source-agent: session-summary
tags: [nanoclaw, ollama, container-config, local-models, agent-groups, systemd]
---

# Ollama Provider Support in NanoClaw v2

## Source Changes

### `src/container-config.ts`
- Added `env?: Record<string, string>` and `blockedHosts?: string[]` to `ContainerConfig`
- `materializeContainerJson()` now reads and preserves these fields from any existing `container.json` before overwriting
- These fields are **not in the DB** — the merge-preserve pattern keeps manual edits sticky across respawns

### `src/container-runner.ts`
- `buildContainerArgs()` wires `env` entries as `-e KEY=VALUE` docker args
- `buildContainerArgs()` wires `blockedHosts` as `--add-host HOST:0.0.0.0` docker args

## New Agent Group: `local-qwen3.6`

| Field | Value |
|-------|-------|
| Name | `local-qwen3.6` |
| Folder | `groups/local-qwen3.6/` |
| ID | `103c34dd-8610-4bd6-9fa0-b9b98f79941d` |
| Model | `qwen3.6:35b` (in `.claude-shared/settings.json`) |
| API URL | `http://host.docker.internal:11434` (Ollama) |
| API Key | `ANTHROPIC_API_KEY=ollama` (placeholder) |
| Blocked | `api.anthropic.com` (forces local routing) |
| Wired | Not yet — needs `/manage-channels` before use |

## How Ollama Routing Works

Agents route to Ollama by:
1. Setting `ANTHROPIC_API_KEY=ollama` in `env`
2. Setting the base URL to `http://host.docker.internal:11434`
3. Blocking `api.anthropic.com` via `blockedHosts` (`--add-host api.anthropic.com:0.0.0.0`)

This prevents any accidental fallback to the real Anthropic API.

## Available Ollama Models on This Host

| Model | Notes |
|-------|-------|
| `qwen3.6:35b` | Used by `local-qwen3.6` group |
| `qwen3-coder:30b` | Available |
| `qwen2.5-coder:7b-32k` | Available |
| `digitsflow/bonsai-8b:latest` | Available |

## System Facts

- **systemd unit name:** `nanoclaw-v2-b3501fc6.service` (not `nanoclaw.service`)
- **Claude Code vs Terminal Agent:** Claude Code on the host is NOT the Terminal Agent container — they are separate processes. Agent-runner MCP tools like `send_message` are not available from the host Claude Code session.

## Cross-references

- [How NanoClaw Groups and Agents Work](2026-05-21-nanoclaw-groups-and-agents.md) — agent group roster, routing, OneCLI proxy
