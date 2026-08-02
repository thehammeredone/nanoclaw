---
title: Agent Usage Dashboard — Feature Plan
date: 2026-05-25
source-agent: unknown (session summary from ag-1779381936325-6ki38t)
tags: [nanoclaw, feature-plan, dashboard, metrics, ncl, sqlite]
---

# Agent Usage Dashboard — Feature Plan

**Status:** Draft | **Full plan:** `plans/agent-usage-dashboard.md`

## Motivation

`ncl sessions list` only shows live state — no historical visibility into agent runtime. This plan adds additive instrumentation and a dashboard.

## Data Model (Phase 1)

Two new SQLite tables in `v2.db`:

**`agent_session_metrics`** — one row per session, updated in-place:
- session_id, agent_group_id, agent_name, messaging_group_id
- started_at, last_active_at, ended_at, duration_ms
- message_count, container_starts, status (active/idle/stopped)

**`agent_lifecycle_events`** — append-only event log:
- id, session_id, agent_group_id, event_type, occurred_at, metadata (JSON)
- Event types: session_created, container_started, container_stopped, message_received, message_sent, session_expired

## Instrumentation Points (Phase 2)

| Where | Event |
|-------|-------|
| Router — session creation | session_created + upsert metrics row |
| Container manager | container_started/stopped, increment container_starts |
| Router — message in/out | message_received/sent, update last_active_at |
| Session GC cleanup job | session_expired, set ended_at + duration_ms |

All writes fire-and-forget (non-blocking).

## CLI Extension (Phase 3)

New `usage` resource for `ncl`:
- `ncl usage sessions [--agent-group-id] [--since] [--limit]`
- `ncl usage summary [--since]` — per-agent aggregates
- `ncl usage events [--session-id] [--event-type]` — raw event log

## Dashboard Options (Phase 4)

| Option | Approach |
|--------|----------|
| A (lowest lift) | Mjollnir generates on-demand Markdown/HTML report via ncl queries |
| B | Scheduled daily/weekly digest card in channel |
| C (full build) | Next.js + shadcn/ui + Recharts deployed to Vercel; views: Overview, Timeline (Gantt), Per-agent drilldown, Usage heatmap |

## Implementation Order

1. Schema migration (two new tables)
2. Instrumentation in host service
3. `ncl usage` resource
4. On-demand report mode (Mjollnir)
5. Web dashboard

## Decisions (resolved 2026-05-25)

| Question | Decision |
|----------|----------|
| Retention | `agent_lifecycle_events` purged after 90 days; `agent_session_metrics` kept indefinitely |
| Auth | Internal only — no auth needed on the ncl read path |
| Message content | Count only, no content stored |
| Child agents | Tracked independently, no rollup to parent |

## Cross-references

- [How NanoClaw Groups and Agents Work](2026-05-21-nanoclaw-groups-and-agents.md) — session model, ncl CLI, agent groups
