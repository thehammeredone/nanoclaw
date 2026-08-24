---
id: TASK-24
title: Re-audit Aurora's CLAUDE.local.md auth and error-handling rules
status: Needs Review
assignee:
  - '@orchestrator'
created_date: '2026-08-20 15:01'
updated_date: '2026-08-24 04:28'
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
- [x] #1 Always-authenticate-first rule re-evaluated against a working MCP server and kept or removed with reasoning recorded
- [x] #2 Retry-escalation block re-evaluated and committed (it is currently uncommitted)
- [x] #3 Any behavioural correction currently living only in chat transcript is written into CLAUDE.local.md
- [ ] #4 A morning report runs clean end to end with the revised instructions
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## What changed in `groups/skylight-morning/CLAUDE.local.md`

- **Step 1 no longer pre-authenticates.** Aurora goes straight to the data calls and calls
  `authenticate` only when a Skylight call asks her to.
- **`## Auth Errors — 401 or Missing Token`** (replaces `## 401 Error Handling`) — covers both
  the expired-token 401 and the never-captured case, and says to authenticate *once* and re-run
  the whole parallel batch rather than per call.
- **`### Why We No Longer Authenticate First`** — the reasoning, recorded in the file per AC#1.
- **`## When authenticate Times Out — One Retry, Then a Real Diagnostic`** — 60/120/240 ladder
  replaced by a single 60s retry, plus "if the MCP server did not start, do not retry at all".
- **`## When Something Fails — One Diagnostic, Not a Failure in Every Section`** — new (AC#3).
- Per-section "unavailable" template scoped to a *single* failed call, cross-linked to the above.
- Write-tool guard corrected from 4 tools to the real 7 (see "Incidental fix").

## AC#1 — evidence for dropping "authenticate first"

Read out of the MCP source at `/home/hammer/git/Skylight` (wheel `skylight-0.2.3`):

- The token is cached at `SKYLIGHT_TOKEN_ENV_PATH=/workspace/.skylight/token.env`. `/workspace`
  is the *session* dir on the host, so the cache survives container restarts.
- `server/tools/__init__.py` calls `load_settings()` on **every** tool invocation, and
  `server/config.py:176-193` re-reads that file each time. A token captured on an earlier run is
  already in effect before Aurora does anything.
- The assumption the old `## 401 Error Handling` block rested on is real:
  `server/api_client.py:96-99` turns a 401 into an explicit "run the `authenticate` tool"
  message and does **not** retry it; `_read` (`server/tools/__init__.py:161-175`) re-raises it to
  the agent verbatim as a `ToolError`. A missing token is equally explicit
  (`server/auth.py::build_auth_header` -> `ConfigError`).
- `TOKEN_MAX_AGE_SECONDS` (48 h) only prints a **stderr** warning, so the agent can't see it.
  Irrelevant here: a daily report never lets the token get older than ~24 h, and if it does, the
  401 path catches it.

Verified live, read-only, without touching Aurora or Matrix (runbook pattern "Verifying auth
without touching the live agent" — venv python + `PYTHONPATH`, `/workspace` mounted `:ro`):

```
token present: True | scheme: bearer | frame: 3964300 | token age: 2.8 h | flagged stale: False
list_calendar_events -> OK, 1 events        (2026-08-24T23:00:00.000Z | Karate)
list_chores          -> OK, 290 chores
RESULT: cached token worked with zero authenticate calls
```

And the two error paths the new rules depend on, forced with a bogus / empty `SKYLIGHT_TOKEN`:

```
EXPIRED/INVALID -> ToolError: 401 unauthorized: the Skylight token is invalid or expired.
                   Re-authenticate: run the `authenticate` tool, ...
MISSING         -> ConfigError: Skylight token is missing or empty. Set SKYLIGHT_TOKEN
                   (capture one with the MCP authenticate step) and retry.
```

Both are actionable and self-service, so the mandatory headless-Chromium login every run bought
nothing. **Removed.**

## AC#2 — evidence for cutting the 60/120/240 ladder

TASK-5's bootstrap guard means a broken MCP server no longer presents as a timeout: it verifies
`import server.app` before starting and otherwise exits with `skylight-mcp: PROVISIONING FAILED
(...)` / `STARTUP FAILED (...)`, so the Skylight tools are **absent**, not slow — a different and
loud symptom. Empirically the last three scheduled runs (8/21, 8/22, 8/23) all completed with
full calendar + chores data.

So the ladder's original target can't recur, and what remains is a genuinely transient slow login
— which one retry covers. Seven minutes plus four Chromium launches is most of the useful life of
a 6 AM report.

**This deliberately narrows an instruction Hammer gave in chat** on 2026-08-20 (inbound seq 30,
acknowledged in outbound seq 57). The file says so in-line, with the reason, so he can push back.
His underlying ask — "don't just throw your hands in the air" — is now served by the diagnostic
block instead.

## AC#3 — corrections mined from the Matrix transcript

Session `sess-1783609624398-smn6q9`, `messages_in` / `messages_out`. Already in the file:
seq 8 (failure vs. empty result), seq 16 (single message / all profiles / conversational
remark), seq 20 (calendar window, `+2` -> `+1`), seq 30 (retry — now revised).

**Not previously written down, now added** — inbound seq 34, 2026-08-20: *"if something isn't
working, give me a bit of a diagnostic, as opposed to all of the sections with Cant auth / Cant
auth / Cant auth / Cant auth."* This is now `## When Something Fails — One Diagnostic, Not a
Failure in Every Section`, with a worked template.

## AC#4 — NOT met. A real run was deliberately not forced.

Everything up to the boundary is done:

- **Host service is up** (`nanoclaw-v2-b3501fc6`, running since 2026-08-23 21:30 EDT). No Aurora
  container is running — normal when idle.
- **The revised file will be picked up.** TASK-22 shipped: `shouldRunFresh()`
  (`container/agent-runner/src/poll-loop.ts:43`) starts a fresh SDK session for any batch
  containing a `task`-kind row, so the 6 AM scheduled run re-reads `CLAUDE.local.md`. The
  agent-runner is bind-mounted from the host at spawn (`src/container-runner.ts:315-316`), so
  this is live even though Aurora's image dates from 2026-06-24.
- **`continuation:claude` cleared anyway** (I did this, 2026-08-24 ~00:20 EDT) — deleted from
  `session_state` in the session's `outbound.db`. TASK-22 covers the scheduled path, but a
  *chat*-triggered report would still have resumed the old SDK session (id
  `43c67d69-4572-4c8f-bac8-5f9c74a078ce`, last written 2026-08-23 21:30 EDT) and never seen the
  new file. No container was running, so the single-writer invariant held; `journal_mode` is
  still `delete`. Backup: `<scratchpad>/outbound.db.bak-task24`.
- **The frozen 6 AM prompt does not contradict these edits.** `messages_in` seq 48
  (series `task-1787267541212-gro4qg`, `0 6 * * *`, due 2026-08-24T10:00:00Z) reads: *"Run the
  daily morning brief for Hammer. Follow the morning report procedure in CLAUDE.local.md exactly
  as written — it is the single source of truth ... Do not substitute any procedure from this
  task text."* It is a pure pointer, so the recurrence copy can never drift into contradiction.
  Nothing to fix.

**Why no live run:** a genuine end-to-end run means Aurora DMs Hammer a full morning report over
Matrix, and the only way to trigger it out of band is `ncl groups restart --id
ag-1782273071167-th1q6f --message "..."`. It is ~00:30 local. I verified the load-bearing claim
(cached token, no `authenticate`) out of band instead, read-only and invisible to the operator,
rather than fabricating a report or pinging him in the middle of the night.

**How the operator verifies:** the 6 AM run on 2026-08-24 is the test — it is already scheduled,
will run fresh, and will use the revised file. Look for a normal report and, in the transcript,
**no `authenticate` call** unless a 401 came back first. To force it sooner:

```bash
ncl groups restart --id ag-1782273071167-th1q6f \
  --message "Run the morning report. Read-only Skylight calls only."
```

Check afterwards:

```bash
pnpm exec tsx scripts/q.ts \
  data/v2-sessions/ag-1782273071167-th1q6f/sess-1783609624398-smn6q9/outbound.db \
  "SELECT seq, timestamp, substr(content,1,200) FROM messages_out ORDER BY seq DESC LIMIT 3"
# token.env mtime should NOT advance if the cached token was still good:
ls -l --time-style=full-iso \
  data/v2-sessions/ag-1782273071167-th1q6f/sess-1783609624398-smn6q9/.skylight/token.env
```

## Incidental fix (docs-only, in the same file)

The write-tool guard listed **4** of the **7** write tools that
`server/tools/__init__.py` actually registers. `update_chore`, `award_reward_points` and
`remove_reward_points` were unguarded. `update_chore` matters most: it is how Aurora marks chores
complete, which Hammer asks for routinely (inbound seq 12, 24), so it was in active use as an
unlisted write tool against the live shared family account. List corrected.

## Follow-ups worth filing (not done here — no source changes in this task)

1. **The 8/23 06:00 scheduled run did not fire at 06:00.** The host service was down and only
   started at 21:30 EDT; the sweep then fired the due message and the "Sunday, August 23"
   briefing was delivered at 21:33 EDT (outbound seq 75), ~15.5 h late. A stale scheduled task
   probably should not be delivered as if it were fresh — worth a lateness threshold.
2. **Aurora's token cache and venv are per-session** (~100 MB and one headless login per session).
   Already noted as a rough edge in `docs/runbooks/aurora-skylight-mcp.md`; the auth change makes
   the token half of it more visible, since a new session is now the *only* thing that forces a
   login.
3. **`docs/runbooks/aurora-skylight-mcp.md` still says** "Aurora is instructed to call
   `authenticate` on any 401 and retry" — still true, but the runbook does not yet mention that
   she no longer pre-authenticates. Minor doc sync.

**AC#4 is NOT met and this task is parked in Needs Review, not Done.**

ACs #1-#3 are complete and merged. AC#4 ("a morning report runs clean end to end with the revised instructions") can only be closed by a real run against the live Skylight account, which is the operator's to trigger. The revised instructions are live on disk and `continuation:claude` was cleared, so **today's 06:00 run is the test.**

To close AC#4, after the 06:00 report lands:
1. Confirm the report arrived complete (calendar + chores + weather), not a diagnostic block.
2. Confirm no pre-authentication happened on a run with a warm cache — check `token.env` mtime is older than the report.
3. If the report is a failure diagnostic instead, the new rules are what to look at first.

Review findings applied before merge (details in the commit): the one-diagnostic block was treating an auth error on every call as an automatic "Skylight unavailable", which would have turned the ordinary daily token expiry into a failure report instead of a briefing — the agent must now run the documented 401 recovery first and only escalate when that fails. The timeout retry now raises the tool's 20s default instead of repeating an identical call. Two contradictory sections ("Report, Don't Diagnose" vs "Then a Real Diagnostic") were reconciled. Two overstated claims were softened: the retry ladder landed on 2026-08-20 after the venv fix, so it probably never ran against the dead server.

Live-state change made during this task: `session_state` `continuation:claude` was cleared for the Aurora session so the revised file is picked up (backup taken; verified 0 rows, no container running, 36 `messages_out` intact).
<!-- SECTION:NOTES:END -->
