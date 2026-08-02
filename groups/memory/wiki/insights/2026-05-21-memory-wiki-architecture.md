---
title: Memory Wiki Architecture and Operation
date: 2026-05-21
source-agent: host-session
tags: [memory, wiki, karpathy, agent-to-agent, knowledge-base]
---

# Memory Wiki Architecture and Operation

## The Pattern (Karpathy LLM Wiki)

Based on Karpathy's LLM Wiki pattern. Core idea: instead of RAG (re-deriving knowledge on every query), maintain a persistent wiki that compounds. The LLM processes raw sources once, integrates knowledge into structured pages, and every future query benefits from all prior synthesis.

Key distinction from RAG: knowledge accumulates. Cross-references already exist. Contradictions are flagged. The wiki grows richer with every ingest.

## Three Layers

| Layer | What it is | Who owns it |
|-------|-----------|-------------|
| Raw sources | Immutable input documents | Human (Hammer) / sending agent |
| Wiki | Structured markdown pages | Memory agent — creates and maintains |
| Schema | `CLAUDE.local.md` — how to operate the wiki | Set at install time |

## Three Operations

**Ingest** — receive knowledge from another agent or source, process into wiki pages, update index and log.

**Query** — read `wiki/index.md` first, drill into relevant pages, synthesize answer with citations, return to querying agent.

**Lint** — periodic health check: contradictions, stale entries, orphan pages, missing cross-references.

## Wiki Structure (This Install)

```
groups/memory/
  wiki/
    index.md              — catalog of all pages (read first on any query)
    log.md                — append-only chronological record
    behaviors/            — per-agent behavioral memory
      mjollnir.md         — Mjollnir's corrections and learned patterns
      terminal-agent.md   — Terminal Agent's corrections and learned patterns
    insights/             — synthesized insights, reports, analyses
    lessons/              — hard-won lessons from debugging, retrospectives
  sources/                — raw source material (immutable)
```

## Three Knowledge Categories

### Behavior Corrections (`wiki/behaviors/`)
When Hammer corrects an agent on how it should behave, that correction is sent to Memory and stored in the relevant agent's behavior file. Format per entry:
```markdown
## <short title>
**Date:** YYYY-MM-DD
**Correction:** What Hammer said
**Learned behavior:** What the agent should now do differently
**Context:** What triggered it
```

This is the auto-memory layer — agents query their behavior file at the start of each session.

### Insights (`wiki/insights/`)
Synthesized analyses, reports, or knowledge worth keeping for future reference. Agents send these when they produce something genuinely valuable, not for every response.

### Lessons Learned (`wiki/lessons/`)
Hard-won lessons from debugging sessions, mistakes, or retrospectives. Emphasis on what to do differently.

## How Agents Interact with Memory

### Every request (mandatory pre-lookup)
Before responding to any message from Hammer, Mjollnir and Terminal Agent query Memory:
```
TYPE: query
QUESTION: Hammer has sent: "<message>". What behavioral corrections, patterns, or lessons apply — across any agent?
```
This ensures corrections carry forward across sessions and across agents.

### Ingesting a correction
Sent fire-and-forget immediately after Hammer corrects behavior:
```
TYPE: behavior-correction
AGENT: <agent name>
CORRECTION: <what Hammer said>
CONTEXT: <what triggered it>
```

### Ingesting insights/lessons
Sent fire-and-forget when the agent judges something worth keeping:
```
TYPE: insight / lesson
TITLE: <title>
CONTENT: <content>
TAGS: <tags>
```

## Cross-Agent Behavior Propagation

A key feature: Mjollnir queries memory for behaviors "across any agent." This means a correction made to Terminal Agent can inform Mjollnir's behavior in a future session, and vice versa. Corrections need not be repeated per-agent.

## Related Pages

- [[nanoclaw-groups-and-agents]] — how the underlying routing and group system works
