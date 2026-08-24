---
id: TASK-24
title: Re-audit Aurora's CLAUDE.local.md auth and error-handling rules
status: In Progress
assignee:
  - '@orchestrator'
created_date: '2026-08-20 15:01'
updated_date: '2026-08-24 04:10'
labels:
  - aurora
  - skylight
  - docs
dependencies:
  - TASK-5
  - TASK-22
priority: medium
ordinal: 24000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found in Claude Code session 9bcadaf6-3351-4862-8bee-85cc8b8f9834 (2026-08-20).

Several blocks in groups/skylight-morning/CLAUDE.local.md were written to work around a MISDIAGNOSED failure. The real cause was never auth: the Discord-wired session's .skylight-venv-0.2.3 contained only pip and setuptools, so `python -m server` died on import and the MCP server never started. See TASK-5 / TASK-7.

Blocks to re-evaluate once the venv guard and fresh-session work land:

1. 'Step 1 -- Authenticate first. Always call authenticate before any other Skylight tool. Do not skip this even if a cached token exists.' (added 2026-07-30, b058b745) -- forces a full headless-Chromium login every single run. Expensive and slow. Was added because a cached token 'was not working', which is now explained by the dead MCP server. Reconsider: use the cached token and let the documented 401 path trigger re-auth.

2. 'When authenticate Times Out -- Retry, Don't Give Up' escalating 60s/120s/240s (added 2026-08-20 07:07, still UNCOMMITTED at time of writing) -- up to 7 minutes of retries against a server that was never going to answer.

3. The '## Memory Agent' section -- Aurora has NO agent-type destination, so every 'query memory before responding' call fails. TASK-9 AC#2 already covers deleting this. Cross-referenced, not duplicated here.

Also worth capturing: the operator has been correcting Aurora in CHAT (outbound seq 57: 'Got it -- on timeouts I'll retry at 60, 120, and 240 seconds'). Those corrections live only in a transcript and die with the session -- especially once TASK-22 makes reports run fresh daily. Anything that matters must be in CLAUDE.local.md, not conversation.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Always-authenticate-first rule re-evaluated against a working MCP server and kept or removed with reasoning recorded
- [ ] #2 Retry-escalation block re-evaluated and committed (it is currently uncommitted)
- [ ] #3 Any behavioural correction currently living only in chat transcript is written into CLAUDE.local.md
- [ ] #4 A morning report runs clean end to end with the revised instructions
<!-- AC:END -->
