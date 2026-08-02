# Wiki Index

Content-oriented catalog. Update on every ingest. Read this first when answering queries before drilling into individual pages.

## Behaviors

Agent-specific learned behaviors and corrections from Hammer. Each file is one agent's behavioral memory.

| Page | Summary |
|------|---------|
| [Mjollnir](behaviors/mjollnir.md) | Reply to thread not DM |

## Insights

Synthesized insights, analyses, and reports worth keeping.

| Page | Summary | Date | Source |
|------|---------|------|--------|
| [How NanoClaw Groups and Agents Work](insights/2026-05-21-nanoclaw-groups-and-agents.md) | Agent groups, messaging groups, wirings, sessions, routing flow, current install layout (now incl. local-qwen3.6), OneCLI proxy setup, systemd unit name | 2026-05-21 | host-session |
| [Memory Wiki Architecture and Operation](insights/2026-05-21-memory-wiki-architecture.md) | Karpathy LLM Wiki pattern, three layers, three operations, wiki structure, how agents interact with memory, cross-agent behavior propagation | 2026-05-21 | host-session |
| [Ollama Provider Support in NanoClaw v2](insights/2026-05-21-ollama-provider-support.md) | container-config.ts/container-runner.ts changes, env/blockedHosts fields, local-qwen3.6 group config, how Ollama routing works, available Ollama models, systemd unit name, Claude Code vs Terminal Agent separation | 2026-05-21 | session-summary |
| [Agent Usage Dashboard — Feature Plan](insights/2026-05-25-agent-usage-dashboard.md) | Draft plan for historical agent metrics: two new DB tables, instrumentation points, ncl usage resource, dashboard options (A/B/C), open questions | 2026-05-25 | session-summary |

## Lessons Learned

Hard-won lessons from experience, debugging sessions, or retrospectives.

| Page | Summary | Date | Source |
|------|---------|------|--------|
| [Session Debugging Lessons 2026-05-26/27](lessons/2026-05-26-session-debugging.md) | Heartbeat path, OneCLI UUID prefix fix, additionalMounts relative paths, trigger=0 stranding bug, ghost sessions after restart, session-diag.ts false positive, OpenCode no-providers error | 2026-05-26 | unknown |
