# Wiki Log

Append-only chronological record. Each entry starts with `## [YYYY-MM-DD] type | title`.

Query last 5 entries: `grep "^## \[" wiki/log.md | tail -5`

---

## [2026-05-21] ingest | How NanoClaw Groups and Agents Work
Source: host-session | Category: insight
Architecture overview of NanoClaw: agent groups, messaging groups, wirings, sessions, routing flow, current install layout (Mjollnir, Terminal Agent, Memory), and OneCLI proxy binding.

## [2026-05-21] ingest | Memory Wiki Architecture and Operation
Source: host-session | Category: insight
Documents the Karpathy LLM Wiki pattern as implemented here: three layers, three operations, wiki structure, agent message protocol, cross-agent behavior propagation.

## [2026-05-21] ingest | Ollama Provider Support in NanoClaw v2
Source: session-summary | Category: insight
Source changes to container-config.ts (env/blockedHosts fields) and container-runner.ts (docker arg wiring). New agent group local-qwen3.6 routing to Ollama qwen3.6:35b. System facts: systemd unit name, Claude Code vs Terminal Agent separation. Also updated nanoclaw-groups-and-agents.md with local-qwen3.6 row and system notes.

## [2026-05-25] ingest | Agent Usage Dashboard — Feature Plan
Source: session-summary (ag-1779381936325-6ki38t) | Category: insight
Draft feature plan for historical agent metrics visibility. Two new tables (agent_session_metrics, agent_lifecycle_events), instrumentation at 4 capture points, ncl usage resource, three dashboard options. Full plan saved to plans/agent-usage-dashboard.md.

## [2026-05-25] update | Agent Usage Dashboard — open questions resolved
Source: ag-1779381936325-6ki38t | Category: insight
All four open questions closed: 90-day purge on lifecycle_events, no auth on ncl read path, message count only (no content), child agents tracked independently.

## [2026-05-25] query | Agent Usage Dashboard plan retrieval
Source: ag-1779381936325-6ki38t
Requested full plan. Retrieved from plans/agent-usage-dashboard.md. Could not deliver — no outbound destinations configured.

## [2026-05-25] query | Behavioral corrections for handling Hammer message about thread replies
Source: ag-1779381936325-6ki38t
No prior corrections found. Ingested new Mjollnir correction: reply to active thread, not DM. Created wiki/behaviors/mjollnir.md.

## [2026-05-25] ingest | Mjollnir behavior correction — reply to thread not DM
Source: ag-1779381936325-6ki38t (relaying Hammer correction) | Category: behavior-correction
Hammer corrected Mjollnir for replying to DM instead of active thread. Stored in wiki/behaviors/mjollnir.md.

## [2026-05-25] ingest (duplicate skipped) | Ollama provider support and system architecture notes
Source: ag-1779381936325-6ki38t
Content matches what was ingested on 2026-05-21 from host-session. Already stored in wiki/insights/2026-05-21-ollama-provider-support.md. No action taken.

## [2026-07-05] query | Mjollnir daily AI news digest — specific task IDs, 8am vs 6am ET, cancellation history — [superseded 2026-07-07: ai-news moved to the Radar agent]
Source: ag-1779381936325-6ki38t
No stored information found. No task IDs, times, or cancellation history ever ingested for this task.

## [2026-07-05] query | Mjollnir daily AI news report — schedule and task history — [superseded 2026-07-07: ai-news moved to the Radar agent]
Source: ag-1779381936325-6ki38t
No stored information found. Nothing in wiki or plans covers this task. Gap noted — should be ingested if details are available.

## [2026-05-27] ingest | Session Debugging Lessons — 2026-05-26/27
Source: unknown | Category: lesson
7 findings: heartbeat path, OneCLI UUID prefix bug (fixed in container-runner.ts), additionalMounts relative path requirement, trigger=0 stranding bug (workaround + needs fix), ghost sessions after restart (workaround + needs fix), session-diag false positive for future tasks, OpenCode no-providers error. scripts/session-diag.ts added.
