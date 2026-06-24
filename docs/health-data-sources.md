# NanoClaw Health & Status Data Sources

Reference for `scripts/status.ts` and the `nanoclaw-status` skill. Covers every table, column, file, and threshold relevant to checking system health.

---

## File Layout

```
data/v2.db                                              ← central DB (host RW)
data/v2-sessions/<agent_group_id>/<session_id>/
  inbound.db                                            ← host writes, container reads
  outbound.db                                           ← container writes, host reads
  .heartbeat                                            ← mtime = container liveness signal
```

---

## Central DB (`data/v2.db`)

### `sessions`
```sql
id                 TEXT PRIMARY KEY
agent_group_id     TEXT NOT NULL
messaging_group_id TEXT              -- NULL for agent-shared mode
thread_id          TEXT              -- NULL for per-agent sessions
agent_provider     TEXT
status             TEXT DEFAULT 'active'    -- 'active' | 'closed'
container_status   TEXT DEFAULT 'stopped'  -- 'running' | 'idle' | 'stopped'
last_active        TEXT                    -- ISO timestamp or NULL
created_at         TEXT NOT NULL
```
Health signals: `container_status` vs heartbeat mismatch; `last_active` age for stale detection.

### `agent_groups`
```sql
id             TEXT PRIMARY KEY
name           TEXT NOT NULL
folder         TEXT NOT NULL UNIQUE
agent_provider TEXT
created_at     TEXT NOT NULL
```

### `messaging_groups`
```sql
id                    TEXT PRIMARY KEY
channel_type          TEXT NOT NULL
platform_id           TEXT NOT NULL
name                  TEXT
is_group              INTEGER   -- 0 | 1
unknown_sender_policy TEXT DEFAULT 'strict'
created_at            TEXT NOT NULL
UNIQUE(channel_type, platform_id)
```

### `messaging_group_agents` (wirings)
```sql
messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id)
agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id)
session_mode       TEXT NOT NULL   -- 'agent-shared' | 'shared' | 'per-thread' | 'per-sender'
-- plus trigger_rules, priority, etc.
```

### `pending_approvals`
```sql
approval_id         TEXT PRIMARY KEY
session_id          TEXT REFERENCES sessions(id)
request_id          TEXT NOT NULL
action              TEXT NOT NULL
payload             TEXT NOT NULL
created_at          TEXT NOT NULL
agent_group_id      TEXT REFERENCES agent_groups(id)
channel_type        TEXT
platform_id         TEXT
platform_message_id TEXT
expires_at          TEXT
status              TEXT DEFAULT 'pending'  -- 'pending' | 'approved' | 'rejected' | 'expired'
title               TEXT DEFAULT ''
options_json        TEXT DEFAULT '[]'
```
Health: `COUNT(*) WHERE status='pending'`; age check: `(now - created_at) > 24h` → warning.

### `unregistered_senders` (ncl: `dropped-messages`)
```sql
channel_type       TEXT NOT NULL
platform_id        TEXT NOT NULL
user_id            TEXT
sender_name        TEXT
reason             TEXT NOT NULL
messaging_group_id TEXT
agent_group_id     TEXT
message_count      INTEGER DEFAULT 1
first_seen         TEXT NOT NULL
last_seen          TEXT NOT NULL
PRIMARY KEY (channel_type, platform_id)
```

---

## Inbound DB (`inbound.db`)

Host-owned. One file per session.

### `messages_in`
```sql
id             TEXT PRIMARY KEY
seq            INTEGER UNIQUE      -- even numbers (host writes)
kind           TEXT NOT NULL       -- 'chat' | 'chat-sdk' | 'task' | 'webhook' | 'system'
timestamp      TEXT NOT NULL
status         TEXT DEFAULT 'pending'  -- 'pending' | 'processing' | 'completed' | 'failed'
process_after  TEXT                -- NULL = immediate; ISO UTC = scheduled
recurrence     TEXT                -- cron expression or NULL
series_id      TEXT
tries          INTEGER DEFAULT 0
trigger        INTEGER DEFAULT 1   -- 0 = context-only, 1 = wake agent
platform_id    TEXT
channel_type   TEXT
thread_id      TEXT
content        TEXT NOT NULL       -- JSON blob
source_session_id TEXT
on_wake        INTEGER DEFAULT 0   -- 1 = first-poll-only
```

Key health queries:
```sql
-- Due messages waiting (should trigger a container wake):
SELECT count(*) FROM messages_in
WHERE status='pending' AND on_wake=0
  AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))

-- Retry storms:
SELECT count(*) FROM messages_in WHERE tries > 2

-- Permanently failed:
SELECT count(*) FROM messages_in WHERE status='failed'
```

---

## Outbound DB (`outbound.db`)

Container-owned. One file per session.

### `messages_out`
```sql
id             TEXT PRIMARY KEY
seq            INTEGER UNIQUE   -- odd numbers (container writes)
in_reply_to    TEXT
timestamp      TEXT NOT NULL
deliver_after  TEXT
recurrence     TEXT
kind           TEXT NOT NULL    -- 'chat' | 'chat-sdk' | 'system' | etc.
platform_id    TEXT
channel_type   TEXT
thread_id      TEXT
content        TEXT NOT NULL    -- JSON blob
```

### `processing_ack`
```sql
message_id     TEXT PRIMARY KEY
status         TEXT NOT NULL              -- 'processing' | 'completed' | 'failed'
status_changed TEXT NOT NULL              -- ISO UTC
```
Health: stuck = `status='processing'` AND `(now - status_changed) > threshold`.

### `container_state` (id=1 row)
```sql
id                       INTEGER PRIMARY KEY CHECK (id = 1)
current_tool             TEXT                -- current MCP tool name or NULL
tool_declared_timeout_ms INTEGER             -- e.g. Bash declares its timeout
tool_started_at          TEXT
updated_at               TEXT NOT NULL
```
Used to extend stuck tolerance: if `current_tool='Bash'` and `tool_declared_timeout_ms` is set,
the threshold is `max(60s, tool_declared_timeout_ms)` instead of the default 60s.

### `session_state`
```sql
key        TEXT PRIMARY KEY
value      TEXT NOT NULL
updated_at TEXT NOT NULL
```

---

## Heartbeat File

**Path:** `data/v2-sessions/<agent_group_id>/<session_id>/.heartbeat`

Written by the container runner as a file touch (not a DB write) — `mtime` is the liveness
timestamp. The host sweep checks this against `container_status`:

| Condition | Meaning |
|-----------|---------|
| File exists, mtime < 5 min old | Container alive |
| File exists, mtime 5–30 min old | Warning — may be stale |
| File exists, mtime > 30 min old | Critical — absolute ceiling exceeded |
| File missing + `container_status='running'` | Warning — likely crashed |

---

## Thresholds

From `src/host-sweep.ts` (authoritative):

| Constant | Value | Used for |
|----------|-------|----------|
| `SWEEP_INTERVAL_MS` | 60 s | How often the sweep runs |
| `ABSOLUTE_CEILING_MS` | 30 min | Max heartbeat age before kill |
| `CLAIM_STUCK_MS` | 60 s | Per-claim processing tolerance |
| `MAX_TRIES` | 5 | Retries before `status='failed'` |
| `BACKOFF_BASE_MS` | 5 s | Base for exponential retry backoff |

From `src/delivery.ts`:

| Constant | Value |
|----------|-------|
| `ACTIVE_POLL_MS` | 1 s (running sessions) |
| `SWEEP_POLL_MS` | 60 s (all active) |
| `MAX_DELIVERY_ATTEMPTS` | 3 |

Used in `scripts/status.ts` (more conservative thresholds for diagnostic vs. kill):

| Check | Threshold | Severity |
|-------|-----------|----------|
| Heartbeat age (running) | > 5 min | warning |
| Heartbeat age (running) | > 30 min | critical |
| processing_ack stuck (running) | > 5 min | warning |
| processing_ack stuck (stopped) | > 7 days | warning |
| Message `tries` | > 2 | warning |
| Pending approval age | > 24 h | warning |
| Session `last_active` | > 7 days | info |

---

## Query Tool

Use the in-tree wrapper for ad-hoc queries — avoids the `sqlite3` binary dependency:

```bash
pnpm exec tsx scripts/q.ts <db-path> "<sql>"
```

Output: pipe-separated rows, no header (same as `sqlite3 -list`).

---

## Existing Diagnostic Scripts

| Script | Purpose |
|--------|---------|
| `scripts/status.ts` | Full server health check → `logs/status-<ts>.json` + stdout summary |
| `scripts/session-diag.ts` | Per-session deep dive (or overview of all active sessions) |
| `scripts/q.ts` | One-off SQL query against any DB |

---

## Common Remediation Commands

```bash
# Deep-dive on a single session
pnpm exec tsx scripts/session-diag.ts <session-id>

# Restart an agent group container
ncl groups restart --id <agent-group-id>

# Rebuild + restart
ncl groups restart --id <agent-group-id> --rebuild

# View pending approvals
ncl approvals list

# View dropped messages
ncl dropped-messages list

# Host logs
tail -f logs/nanoclaw.error.log
tail -f logs/nanoclaw.log
```
