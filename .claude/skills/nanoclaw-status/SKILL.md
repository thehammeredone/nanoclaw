---
name: nanoclaw-status
description: >
  Run a full health check of the NanoClaw server and produce a structured status report.
  Use this whenever the user asks about server health, session status, running agents,
  connection states, dangling or unanswered messages, stuck containers, failed deliveries,
  pending approvals, or any operational overview of the NanoClaw system. Also triggers on
  phrases like "what's going on", "anything broken", "how are things running", "status check",
  "health check", or "check on nanoclaw". Always use this skill rather than querying databases
  manually — it covers every health dimension in one pass.
---

# nanoclaw-status

Runs `scripts/status.ts` to collect a structured snapshot of every health dimension, writes a
timestamped JSON report, and then summarises the key findings in the conversation.

## Steps

1. **Run the status script** from the nanoclaw repo root:
   ```bash
   pnpm exec tsx scripts/status.ts
   ```
   The script renders a color dashboard directly to the terminal and writes a JSON
   report to `logs/status-<timestamp>.json`. The dashboard shows a stats grid
   (sessions / messages / registry), a color-coded issues list, and a per-session
   table. Pass `NO_COLOR=1` to disable ANSI colors.

2. **Read the JSON output file** (the script prints the path in the footer). Parse:
   - `overall_health` — `"healthy"` | `"degraded"` | `"critical"`
   - `issues[]` — each has `severity` (`"critical"` | `"warning"` | `"info"`), `type`, and `detail`
   - `summary` — aggregate counts (active sessions, running containers, pending messages, etc.)
   - `sessions[]` — per-session health detail
   - `pending_approvals[]` — stuck approval requests
   - `unregistered_senders[]` — dropped-message audit

3. **Summarise findings** in the conversation:
   - Lead with the overall health status and a one-sentence verdict.
   - List every `critical` issue first, then `warning`-level issues.
   - Mention the JSON file path so the user can inspect it.
   - For healthy systems with no issues, a short "all clear" summary is fine.

4. **For critical or warning issues**, offer next steps. Common ones:
   - Stuck container → `pnpm exec tsx scripts/session-diag.ts <session-id>` for deep-dive,
     then `ncl groups restart --id <agent-group-id>` to force a restart.
   - High-retry messages → check `logs/nanoclaw.error.log` for the crash pattern.
   - Pending approvals > 24h → review with `ncl approvals list` and action or expire them.
   - Stale heartbeat + container_status=running → likely zombie; restart the agent group.
   - Failed deliveries → check the channel adapter logs and credentials.

## Output file format

The JSON written to `logs/status-<timestamp>.json`:

```json
{
  "timestamp": "2026-06-22T10:00:00.000Z",
  "overall_health": "healthy",
  "summary": {
    "active_sessions": 3,
    "running_containers": 2,
    "idle_containers": 1,
    "stopped_containers": 0,
    "pending_messages_due": 0,
    "high_retry_messages": 0,
    "failed_messages": 0,
    "stuck_processing_claims": 0,
    "pending_approvals": 0,
    "unregistered_senders": 2,
    "agent_groups": 4,
    "messaging_groups": 3,
    "wirings": 5
  },
  "issues": [
    {
      "severity": "warning",
      "type": "stale_heartbeat",
      "session_id": "...",
      "detail": "Container marked running but heartbeat is 45m old"
    }
  ],
  "sessions": [
    {
      "id": "...",
      "agent_group_id": "...",
      "agent_group_name": "my-agent",
      "messaging_group_id": "...",
      "messaging_group_name": "my-channel",
      "channel_type": "discord",
      "status": "active",
      "container_status": "running",
      "last_active": "2026-06-22T09:55:00.000Z",
      "heartbeat_age_s": 45,
      "inbound": {
        "pending_due": 0,
        "on_wake_queued": 0,
        "high_retry": 0,
        "failed": 0
      },
      "outbound": {
        "stuck_processing": 0,
        "oldest_stuck_age_s": null
      },
      "health": "healthy",
      "issues": []
    }
  ],
  "pending_approvals": [],
  "unregistered_senders": [
    {
      "channel_type": "discord",
      "platform_id": "...",
      "message_count": 3,
      "last_seen": "2026-06-22T08:00:00.000Z"
    }
  ]
}
```

## Thresholds used by the script

| Condition | Threshold | Severity |
|-----------|-----------|----------|
| Heartbeat age (running container) | > 30 min | critical |
| Heartbeat age (running container) | > 5 min | warning |
| processing_ack stuck (running container) | > 5 min | warning |
| processing_ack stuck (stopped container) | > 7 days | warning |
| Message retry count | > 2 | warning |
| Pending approval age | > 24 h | warning |
| Session last_active | > 7 days | info |
| Container marked running but no heartbeat file | immediate | warning |
