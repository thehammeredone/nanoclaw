# Agent Usage Dashboard — Feature Plan

**Status:** Draft | **Created:** 2026-05-25

## Motivation
No historical visibility into agent runtime. `ncl sessions list` shows live state only. Goal: additive instrumentation + dashboard.

## Phase 1 — Data Layer

**`agent_session_metrics`** (one row per session, updated in-place):
- session_id, agent_group_id, agent_name, messaging_group_id
- started_at, last_active_at, ended_at, duration_ms
- message_count, container_starts, status (active/idle/stopped)

**`agent_lifecycle_events`** (append-only event log):
- id, session_id, agent_group_id, event_type, occurred_at, metadata (JSON)
- Event types: session_created, container_started, container_stopped, message_received, message_sent, session_expired

## Phase 2 — Event Capture Points
1. Session creation (router) → session_created + upsert metrics row
2. Container lifecycle (container manager) → container_started/stopped, increment container_starts
3. Message routing (router, in+out) → message_received/sent, increment message_count, update last_active_at
4. Session GC (cleanup job) → session_expired, set ended_at + duration_ms, status=stopped

All writes fire-and-forget (non-blocking).

## Phase 3 — ncl CLI Extension
New `usage` resource:
- `ncl usage sessions [--agent-group-id] [--since] [--limit]`
- `ncl usage summary [--since]` — per-agent aggregates: total sessions, runtime, avg session length, messages, last active
- `ncl usage events [--session-id] [--event-type]` — raw event log

## Phase 4 — Dashboard Options
- **A (lowest lift):** Mjollnir generates on-demand Markdown/HTML report via ncl queries
- **B:** Scheduled daily/weekly digest card in channel
- **C (full build):** Next.js + shadcn/ui + Recharts web app, deployed to Vercel
  - Views: Overview (live status), Timeline (Gantt), Per-agent drilldown, Usage heatmap

## Implementation Order
1. Schema migration (two new tables)
2. Instrumentation in host service
3. ncl `usage` resource
4. On-demand report mode (Mjollnir)
5. Web dashboard

## Decisions (resolved 2026-05-25)

| Question | Decision |
|----------|----------|
| Retention | `agent_lifecycle_events` purged after 90 days; `agent_session_metrics` kept indefinitely |
| Auth | Internal only — no auth needed on the ncl read path |
| Message content | Count only, no content stored |
| Child agents | Tracked independently, no rollup to parent |
