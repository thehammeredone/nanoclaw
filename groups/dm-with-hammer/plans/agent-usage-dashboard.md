# Agent Usage Dashboard — Feature Plan

**Status:** Draft  
**Created:** 2026-05-25  
**Author:** Mjollnir (for Hammer)

---

## Motivation

NanoClaw currently has no visibility into agent runtime behavior over time. You can query live session status via `ncl sessions list`, but there's no historical record of when agents ran, for how long, or how active they were. This plan outlines a minimal, additive approach to collecting that data and surfacing it as a dashboard.

---

## Phase 1 — Data Layer

### New table: `agent_session_metrics`

Track one row per session, updated in-place as the session progresses.

```sql
CREATE TABLE agent_session_metrics (
  session_id         TEXT PRIMARY KEY,
  agent_group_id     TEXT NOT NULL,
  agent_name         TEXT,                    -- denormalized for query convenience
  messaging_group_id TEXT,
  started_at         DATETIME NOT NULL,
  last_active_at     DATETIME,
  ended_at           DATETIME,
  duration_ms        INTEGER,                 -- populated on close
  message_count      INTEGER DEFAULT 0,
  container_starts   INTEGER DEFAULT 0,       -- how many times container was (re)started
  status             TEXT DEFAULT 'active'    -- 'active' | 'idle' | 'stopped'
);
```

### New table: `agent_lifecycle_events`

Append-only event log for finer-grained timeline reconstruction and debugging.

```sql
CREATE TABLE agent_lifecycle_events (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  agent_group_id   TEXT NOT NULL,
  event_type       TEXT NOT NULL,   -- see event types below
  occurred_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata         JSON              -- flexible per-event payload
);
```

**Event types:**
| event_type | Trigger |
|---|---|
| `session_created` | New session row inserted by router |
| `container_started` | Container transitions to `running` |
| `container_stopped` | Container transitions to `stopped` |
| `message_received` | Inbound message processed |
| `message_sent` | Outbound message delivered |
| `session_expired` | Session GC'd / marked inactive |

---

## Phase 2 — Event Capture Points

These are the places in the NanoClaw host service where instrumentation should be added:

1. **Session creation** (router, on new session insert) → emit `session_created`, upsert `agent_session_metrics` row
2. **Container lifecycle** (container manager, on status change) → emit `container_started` / `container_stopped`, increment `container_starts`
3. **Message routing** (router, inbound + outbound) → emit `message_received` / `message_sent`, increment `message_count`, update `last_active_at`
4. **Session GC / expiry** (cleanup job) → emit `session_expired`, set `ended_at` + compute `duration_ms`, set `status = 'stopped'`

All writes should be fire-and-forget (non-blocking inserts) so instrumentation doesn't affect routing latency.

---

## Phase 3 — ncl CLI Extension

Add a new `usage` resource to `ncl` with the following verbs:

```
ncl usage sessions [--agent-group-id <id>] [--since <duration>] [--limit N]
ncl usage summary  [--since <duration>]
ncl usage events   [--session-id <id>] [--event-type <type>]
```

**`usage sessions`** — returns one row per session with start time, duration, message count, container starts, status.

**`usage summary`** — aggregated per-agent view: total sessions, total runtime (ms), avg session length, total messages, last active.

**`usage events`** — raw event log for a specific session or agent, for debugging.

---

## Phase 4 — Dashboard

### Option A: On-demand report (lowest lift)

I (Mjollnir) generate a Markdown or HTML report on request by querying `ncl usage summary` and `ncl usage sessions`. Useful immediately once the data layer exists, no frontend needed.

### Option B: Scheduled digest

A scheduled task fires daily (or weekly), queries usage data, and delivers a summary card into the channel. No UI required.

### Option C: Web dashboard (full build)

A lightweight web app (Next.js or plain HTML + JS) that reads from the ncl API (or directly from the SQLite DB if exposed):

**Views:**
- **Overview** — active vs idle agents right now, uptime today
- **Timeline** — Gantt-style chart: each agent as a row, sessions as bars, colored by status
- **Per-agent drilldown** — session history, message volume, container restart count
- **Usage heatmap** — activity by hour-of-day and day-of-week

**Recommended stack:** Next.js + shadcn/ui + Recharts. Deploy to Vercel.  
**Data source:** Either a thin read-only HTTP API in front of the NanoClaw DB, or ncl CLI output piped to JSON.

---

## Implementation Order

1. **Schema** — add the two tables (migration, no breaking changes)
2. **Instrumentation** — wire event writes into the host service at the four capture points
3. **ncl resource** — expose `usage` verbs backed by the new tables
4. **Report mode** — Mjollnir can immediately start generating on-demand summaries
5. **Dashboard** — build Option C once data is accumulating

---

## Decisions (resolved 2026-05-25)

- **Retention:** `agent_lifecycle_events` purged after 90 days; `agent_session_metrics` rows kept indefinitely.
- **Auth:** Dashboard is internal-only. No external auth required on the ncl API read path.
- **Message content:** Excluded from metrics — count only.
- **Child agents:** Tracked independently (each has its own `agent_group_id`); no rollup to parent.
