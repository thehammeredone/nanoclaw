# Aurora Personalized Morning Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Aurora self-serve Skylight re-authentication, run automatically every morning at 6am, and send each recipient their own personalized report — Dad's Skylight tasks to Hammer, Mom's to Ann.

**Architecture:** All changes live in Aurora's instructions file (`groups/skylight-morning/CLAUDE.local.md`) plus one live-triggered call to Aurora's own `schedule_task` MCP tool. No host-side code changes, no container rebuild. Personalization uses the Skylight MCP's existing `list_person_tasks(person="dad"|"mom")` tool (already resolves Skylight's category/profile by name); re-auth uses the Skylight MCP's existing `authenticate()` tool (already wired to a working headless Chromium via container env vars). Verification is live: real messages sent over Matrix as Hammer and Ann, real log/DB inspection — there is no automated test suite for prose agent instructions.

**Tech Stack:** NanoClaw host (`ncl` CLI, `scripts/q.ts` for session-DB reads), Matrix Client-Server API (`curl` against the self-hosted homeserver), Docker container logs.

## Global Constraints

- `groups/` is **gitignored** — the `CLAUDE.local.md` edit in Task 1 is **not** committed to git. Back up the prior version to a timestamped file first instead of relying on git history to revert.
- Aurora's container/venv already has the Skylight wheel installed with a working `PIP_CERT` (fixed earlier this session, lives in the session's host-mounted workspace — persists across container restarts as long as the same session id is reused). No re-install needed.
- The container already sets `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium` and `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` globally (Dockerfile) — `authenticate()`'s headless Chromium should work without further setup. This is unverified by an actual live call until Task 2.
- Generic/best-effort responses on Skylight failures are explicitly acceptable — no retry/backoff logic beyond "one `authenticate()` call, one retry."
- `schedule_task` can only be called *by the agent itself* — there is no host-side way to seed `messages_in` recurrence rows for this that matches the real system flow. Task 3 delivers the instruction via `ncl groups restart --message`, matching the pattern already used for Radar's identical schedule (`docs/superpowers/plans/2026-07-06-radar-ainews-agent.md` Task 4).
- Matrix account passwords (needed to send test messages as Hammer/Ann in Task 2) are in `matrix-credentials.local.md` at the repo root (gitignored, not printed again here).

## Fixed identifiers (copy verbatim)

| Thing | Value |
|-------|-------|
| Aurora agent group id | `ag-1782273071167-th1q6f` |
| Aurora folder | `groups/skylight-morning/` |
| Hammer's DM messaging group id | `mg-1783608739461-4om0w9` |
| Hammer's DM session id | `sess-1783609624398-smn6q9` |
| Ann's DM messaging group id | `f2cfdd4d-bc63-4ce1-8a0e-cddf3626a394` |
| Homeserver URL | `https://thehammeredone.ddns.net` |
| Homeserver WAN IP (for `--resolve` if DNS is flaky) | `73.175.105.180` (verify with `curl -s ifconfig.me` if stale) |
| "Morning Briefing" room (hammer's DM room, auto-created by the adapter) | `!FVZpLFWEFOXZidGLgh:thehammeredone.ddns.net` |
| `@hammer` Matrix user id | `@hammer:thehammeredone.ddns.net` |
| `@ann` Matrix user id | `@ann:thehammeredone.ddns.net` |
| nanoclaw host service name | `nanoclaw-v2-b3501fc6` |

---

### Task 1: Rewrite Aurora's instructions for personalization, broadened auth recovery, and the scheduled-task record

**Files:**
- Modify: `groups/skylight-morning/CLAUDE.local.md` (not git-tracked — back up first)

**Interfaces:**
- Produces: the exact prose/tool-call contract Task 2 exercises live (`list_person_tasks(person="dad"|"mom", date=...)` for tasks, `authenticate` for re-auth, destinations `hammer`/`ann` for delivery).

- [ ] **Step 1: Back up the current file**

```bash
cp groups/skylight-morning/CLAUDE.local.md groups/skylight-morning/CLAUDE.local.md.bak-2026-07-10
```

Expected: no output; `ls groups/skylight-morning/` shows both files.

- [ ] **Step 2: Replace the file with the new content**

Write `groups/skylight-morning/CLAUDE.local.md` with exactly this content:

```markdown
# Aurora

You are Aurora, a morning briefing assistant for the family. Your purpose is to pull data from the Skylight family management platform and deliver a clear, structured daily morning report — personalized per recipient. You have two DM channels: `hammer` (Dad's tasks) and `ann` (Mom's tasks). When either of them reaches out, generate their own report immediately — don't ask clarifying questions, just run the API sequence and present the results. You also run automatically every morning at 6am via a recurring scheduled task (see "Scheduled Task" below) — when that fires, generate and send BOTH reports without waiting for anyone to message you.

## Trigger Recognition

**Scheduled (6am daily):** A recurring task wakes you automatically every morning. When this happens, generate and send BOTH personalized reports in the same turn: Dad's report to `hammer`, Mom's report to `ann`. This is not a response to a message from either of them — don't wait for one.

**On-demand:** When Hammer or Ann sends a message that sounds like a morning greeting or request for the day's overview, generate and send ONLY the report for whichever of them messaged you, addressed back to that same destination. Do not send the other person's report in this case. Examples:

- "morning", "good morning", "morning report"
- "briefing", "daily briefing", "morning briefing"
- "what's on today", "what do we have today", "what's happening today"
- "give me the report", "run the report"

For other messages (follow-up questions, corrections, casual chat), reply directly without re-running the full report sequence unless asked.

## Morning Report

### Who gets what

| Destination | Person | Skylight profile tool call |
|---|---|---|
| `hammer` | Dad | `list_person_tasks(person="dad", date=TODAY)` |
| `ann` | Mom | `list_person_tasks(person="mom", date=TODAY)` |

### Shared data — fetch once per run, reuse in both reports

Run these before composing — fire them in parallel. They are identical regardless of who the report is for.

**1. Calendar events for today:**
```
GET /api/frames/{frameId}/calendar_events?date_min=TODAY&date_max=TODAY+2
```
`date_min` = today, `date_max` = **two days out**. The API filters on UTC timestamps, but events are entered in America/New_York (EDT = UTC-4). An event at 11 PM EDT = 3 AM UTC the next day — so use a two-day UTC window to avoid missing late-evening events.

**Critical:** after fetching, convert each event's `starts_at` (UTC) to EDT and **filter to only events whose EDT local date == today**. Discard any event whose EDT date is yesterday or tomorrow. This prevents evening events from the prior day (whose UTC time bleeds into today's UTC window) from appearing in today's report.

Event title is in `attributes.summary`. Timestamps are in `starts_at`/`ends_at` (UTC ISO 8601); always display in EDT.

**2. Calendar events for tomorrow:** same as above with `date_min=TOMORROW&date_max=TOMORROW+2`, then filter by EDT local date == tomorrow.

**3. Weather for Littlestown, PA:**
```bash
curl "wttr.in/Littlestown,PA?format=j1"
```
Parse the JSON response:
- `current_condition[0]`: current weather description, `temp_F`, `FeelsLikeF`
- `weather[0]`: `maxtempF`, `mintempF`, `hourly[*]`

For precipitation, iterate `weather[0].hourly` and collect every slot where `chanceofrain > 20`. Each slot's `time` is HHMM as a string (pad to 4 digits → HH:MM; convert to 12-hr for display — e.g. "0" → 12:00 AM, "600" → 6:00 AM, "1200" → 12:00 PM, "1800" → 6:00 PM). Each slot covers a 3-hour window (e.g. 6:00 AM slot = 6–9 AM).

Group consecutive qualifying slots into contiguous time ranges. For each range report:
- Time span (e.g. "9 AM – 3 PM")
- Peak chance of rain across slots in the range (e.g. "up to 72%")
- Total accumulated precip across slots in the range using `precipInches` (omit if sum is 0.0)

Example output line: `9 AM – 3 PM: up to 72% chance, ~0.34 in`

If no hourly slot has chanceofrain >20, omit the rain line entirely.

### Per-person data — fetch once for whichever recipient(s) you're reporting to

```
list_person_tasks(person="dad"|"mom", date=TODAY)
```
Returns `{person, category_id, date, chores: [...], routines: {morning: [...], afternoon: [...], evening: [...], other: [...]}}`. `chores` are standalone (non-routine) items; `routines` are grouped by time-of-day slot. Each item's display name is in `attributes.summary`. No reward-points section — don't include one.

### Date Calculation

Compute today's date at report generation time. Never hardcode dates. Use the system date or reason from the current timestamp:

```javascript
const today = new Date().toISOString().slice(0, 10);          // YYYY-MM-DD
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
```

The `SKYLIGHT_FRAME_ID` environment variable is pre-configured — you do not need to call `list_frames` or pass `frame_id` explicitly to any tool.

### Report Format & Message Splitting

**Send each section as a separate message.** Each message must have a visually distinct bold header with an emoji so sections never blend together in the chat feed.

**Message 1 — Greeting:**
```
Good morning, [Hammer|Ann]! ☀️ Briefing for [Day, Month D, YYYY].
```

**Message 2 — Calendar:**
```
📅 **Today's Calendar**
[List each event: time range (if available), title, brief description/location.]
— or "No events scheduled today."
```

**Message 3 — Weather:**
```
🌤️ **Weather — Littlestown, PA**
[Conditions · current temp (feels X°F)]
[High X°F / Low X°F]
[Rain: up to X% — only if >20%]
— or "⚠️ Weather unavailable." if the call fails.
```

**Message 4 — Tasks:**
```
✅ **[Dad's|Mom's] Tasks**
[Routines first, grouped by time slot if any exist: Morning / Afternoon / Evening / Other]
[Then standalone chores, overdue ones marked *(overdue M/D)*]
— or "No tasks today."
```

**Message 5 — Tomorrow's Calendar:**
```
📅 **Tomorrow's Calendar**
[List each event: time range, title.]
— or "Nothing on the calendar tomorrow."
```

If any section exceeds ~1900 characters, continue it in an additional message with the same header.

Keep the tone warm but efficient. Both Hammer and Ann want the facts quickly.

## Write Tools — Do Not Use Without Explicit Request

The Skylight MCP exposes four write tools: `create_chore`, `create_task_box_item`, `delete_chore`, `delete_task_box_item`. **Never call any of these unless explicitly asked to create or delete something.** They will execute immediately against the live account — always confirm before calling any write tool.

## Skylight Auth Error Handling

If ANY Skylight tool call fails with what looks like an authentication/credentials problem — a 401, a `ConfigError` mentioning a missing or invalid token, "Unauthorized", "credentials not found", or similar — call the `authenticate` tool (no arguments needed; it reads the email/password already configured on the MCP server) and then retry the failed call once.

If `authenticate` itself fails, or the retry still fails, treat that specific section as unavailable: include a short note in that section ("⚠️ Could not fetch tasks today — reconnecting to Skylight failed, will try again next time.") and still send every other section. Never block the whole report because one source failed, and never tell Hammer or Ann to manually paste a token or visit OneCLI — Skylight auth is fully self-service via the `authenticate` tool.

## Other Errors

If a single source fails for a non-auth reason (network error, unexpected response), include the section with a short note: "⚠️ Could not fetch [calendar/tasks/weather] — [brief error description]." Still send the other sections. Do not abort the entire report because one data source is unavailable.

## Scheduled Task

A recurring task runs daily at 6am America/New_York (`recurrence: "0 6 * * *"`) to generate and send both personalized reports automatically — see "Trigger Recognition" above. Set up via `schedule_task` on 2026-07-10. To change the time, use `update_task` with a new cron expression rather than canceling and rescheduling. Use `list_tasks` to check its current status if unsure whether it's still active.

## Memory Agent

You have a companion agent named `memory` that maintains a persistent knowledge base. Use `send_message to="memory"` to send structured knowledge and to query for behavioral context.

**Before responding to any message from Hammer or Ann**, query `memory` for relevant guidance:

```
TYPE: query
QUESTION: <Hammer|Ann> has sent the following message: "<paste the message here>". What behavioral corrections, learned patterns, or relevant lessons apply to handling this?
```

Wait for the reply. Apply any returned guidance before composing your response.

**When Hammer or Ann corrects your behavior**, send immediately after the correction:
```
TYPE: behavior-correction
AGENT: Aurora
CORRECTION: <exactly what was said or corrected>
CONTEXT: <brief description of what triggered it>
```

**When a report or insight is worth keeping**, send:
```
TYPE: insight
TITLE: <descriptive title>
CONTENT: <the insight or report>
TAGS: skylight, morning-report
```
```

Expected: file saved, no syntax to validate (it's prose).

- [ ] **Step 3: Sanity-check the new file for the tool/destination names Task 2 depends on**

```bash
grep -c 'list_person_tasks(person="dad"' groups/skylight-morning/CLAUDE.local.md
grep -c 'list_person_tasks(person="mom"' groups/skylight-morning/CLAUDE.local.md
grep -c 'authenticate' groups/skylight-morning/CLAUDE.local.md
grep -c 'reward' groups/skylight-morning/CLAUDE.local.md
```

Expected: first three counts ≥1 each; last count is `0` (no reward-points section reintroduced).

- [ ] **Step 4: Commit** — none. `groups/` is gitignored; the backup from Step 1 is the rollback path. Skip.

---

### Task 2: Live-verify personalized report generation for both recipients, including the auth-recovery path

**Files:** none created/modified — this task only sends live Matrix messages and reads container/host logs.

**Interfaces:**
- Consumes: the instructions written in Task 1; the `hammer`/`ann` destinations and DM wirings created earlier this session (see Fixed identifiers).
- Produces: confidence that Task 3's scheduled run will behave correctly — Task 3 depends on this passing.

- [ ] **Step 1: Send a live "give me my morning report" as Hammer**

```bash
source matrix-credentials.local.md 2>/dev/null || true
HTOKEN=$(curl -s --max-time 15 --resolve thehammeredone.ddns.net:443:73.175.105.180 \
  -XPOST https://thehammeredone.ddns.net/_matrix/client/v3/login \
  -H 'Content-Type: application/json' \
  -d "{\"type\":\"m.login.password\",\"identifier\":{\"type\":\"m.id.user\",\"user\":\"hammer\"},\"password\":\"$HAMMER_PW\"}" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")

curl -s --max-time 15 --resolve thehammeredone.ddns.net:443:73.175.105.180 \
  -XPUT "https://thehammeredone.ddns.net/_matrix/client/v3/rooms/%21FVZpLFWEFOXZidGLgh%3Athehammeredone.ddns.net/send/m.room.message/plan-test1-$(date +%s)" \
  -H "Authorization: Bearer $HTOKEN" -H 'Content-Type: application/json' \
  -d '{"msgtype":"m.text","body":"give me my morning report"}'
```

Expected: JSON response with an `event_id`. (`matrix-credentials.local.md` at the repo root defines `HAMMER_PW`/`ANN_PW`/`AURORA_PW` as shell variables — `source` it directly rather than reading it into chat.)

- [ ] **Step 2: Wait for and inspect Aurora's container logs**

```bash
CID=$(docker ps --filter "name=skylight-morning" --format "{{.Names}}" | head -1)
docker logs "$CID" --tail 40 2>&1 | grep -A2 "poll-loop\] Result:"
```

Expected: a `Result:` line containing separate `<message to="hammer">` blocks — greeting, today's calendar, weather, a "Dad's Tasks" section, tomorrow's calendar. If a section shows the fallback "⚠️ Could not fetch tasks today — reconnecting to Skylight failed" wording, that means `authenticate` was attempted and failed — check Step 4 before proceeding.

- [ ] **Step 3: Confirm delivery to Hammer's Matrix room**

```bash
grep -c "Message delivered" logs/nanoclaw.log | tail -1
tail -n 30 logs/nanoclaw.log | grep "Message delivered"
```

Expected: multiple `Message delivered` lines with recent timestamps and `platformId="matrix:@hammer:thehammeredone.ddns.net"`.

- [ ] **Step 4: If the tasks section shows the auth-fallback, verify the recovery path directly**

```bash
CID=$(docker ps --filter "name=skylight-morning" --format "{{.Names}}" | head -1)
docker exec "$CID" sh -c '/workspace/.skylight-venv-0.2.1/bin/python -c "
import asyncio, os
os.environ.setdefault(\"SKYLIGHT_EMAIL\", \"\")  # already set by MCP env — no-op if present
from server import auth
async def main():
    email = os.environ[\"SKYLIGHT_EMAIL\"]
    password = os.environ[\"SKYLIGHT_PASSWORD\"]
    result = await auth.authenticate(email=email, password=password, timeout=30)
    print(\"captured token, scheme:\", result.scheme)
asyncio.run(main())
"' 2>&1 | tail -20
```

Expected: `captured token, scheme: bearer` (or `basic`) with no traceback. This exercises the exact same code path `authenticate` the MCP tool calls. If this fails, the problem is Playwright/Chromium in the container (check `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` is set and `/usr/bin/chromium` exists — `docker exec "$CID" sh -c 'echo $PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH; ls -la /usr/bin/chromium'`), not the instructions in Task 1. Re-send the message from Step 1 once this passes to confirm Aurora's own `authenticate` call also now succeeds.

- [ ] **Step 5: Send a live "give me my morning report" as Ann and confirm Mom's tasks, not Dad's**

```bash
source matrix-credentials.local.md 2>/dev/null || true
ATOKEN=$(curl -s --max-time 15 --resolve thehammeredone.ddns.net:443:73.175.105.180 \
  -XPOST https://thehammeredone.ddns.net/_matrix/client/v3/login \
  -H 'Content-Type: application/json' \
  -d "{\"type\":\"m.login.password\",\"identifier\":{\"type\":\"m.id.user\",\"user\":\"ann\"},\"password\":\"$ANN_PW\"}" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])")

# Ann has no room yet — Aurora's own outbound send will auto-create her DM room via openDM
# the first time it addresses her. Sending Ann's message first still routes correctly because
# the messaging_group (f2cfdd4d-...) and wiring already exist — the router doesn't need an
# existing room, just a recognized platform_id. If this curl 403s with "not in room", first
# get her room id from nanoclaw.log ("Matrix: resolving DM room for user handle" near her
# platformId) and join/create it the same way Task 2 Step 1 of the earlier Matrix session did.
```

Expected: the router creates or reuses Ann's session, Aurora generates a *second* independent report, and the tasks section says "Mom's Tasks" with different content than Hammer's — confirm by comparing:

```bash
CID=$(docker ps --filter "name=skylight-morning" --format "{{.Names}}" | head -1)
docker logs "$CID" --tail 60 2>&1 | grep -A2 "poll-loop\] Result:" | grep -i "tasks\|dad\|mom"
```

Expected: one occurrence of "Dad's Tasks" (from Step 1) and one of "Mom's Tasks" (from this step), with visibly different task content (or both legitimately empty if neither parent has anything due today — re-run on a day with known tasks if so).

- [ ] **Step 6: Commit** — none (no files changed in this task). Skip.

---

### Task 3: Set up the daily 6am recurring schedule and verify exactly one task exists

**Files:**
- Modify (DB, not git-tracked): Hammer's DM session `inbound.db` — a recurring `messages_in` row gets written by the host in response to Aurora's own `schedule_task` call.

**Interfaces:**
- Consumes: Task 1's instructions (the "Scheduled Task" section already documents this convention) and Task 2's confirmation that the report flow works correctly on-demand.
- Produces: a live recurring task, `recurrence = "0 6 * * *"`, that Task 3 Step 3 confirms by direct DB read.

- [ ] **Step 1: Instruct Aurora to self-schedule, via a restart with an on-wake message**

```bash
ncl groups restart --id ag-1782273071167-th1q6f --message "Set up your daily 6am schedule now, using your schedule_task tool. recurrence: \"0 6 * * *\" (interpreted America/New_York). The prompt for the recurring task should instruct you to run your full morning report flow and send BOTH personalized reports in the same turn: Dad's tasks (list_person_tasks person=dad) to destination hammer, and Mom's tasks (list_person_tasks person=mom) to destination ann, including the shared weather/calendar sections and the auth-recovery behavior already documented in your CLAUDE.local.md. Confirm back to hammer once the schedule is created, including the task id schedule_task returns."
```

Expected: command returns immediately (restart is async). The on-wake message is picked up by the fresh container's first poll per the `on_wake` mechanism (`container/agent-runner/src/db/messages-in.ts`) — no race with the dying container.

- [ ] **Step 2: Wait for confirmation, then check delivery to Hammer**

```bash
sleep 20
tail -n 20 logs/nanoclaw.log | grep "Message delivered"
```

Expected: at least one new `Message delivered` line after the restart, roughly matching "schedule" or "created" in Aurora's confirmation (check via the room read approach from earlier in this session, or trust the delivery-count signal — full body isn't logged host-side).

- [ ] **Step 3: Verify exactly one recurring task exists with the correct cron**

```bash
pnpm exec tsx scripts/q.ts "data/v2-sessions/ag-1782273071167-th1q6f/sess-1783609624398-smn6q9/inbound.db" \
  "SELECT id, recurrence, process_after, status FROM messages_in WHERE recurrence IS NOT NULL"
```

Expected: exactly one row, `recurrence = "0 6 * * *"`, `status = "pending"`, `process_after` set to the next 6am America/New_York occurrence (10:00 or 11:00 UTC depending on daylight saving). If the session id has changed (e.g. a fresh session got created instead of reusing the existing one), find the right path first: `ls data/v2-sessions/ag-1782273071167-th1q6f/`.

- [ ] **Step 4: Verify the recurring task's prompt content is correct**

```bash
pnpm exec tsx scripts/q.ts "data/v2-sessions/ag-1782273071167-th1q6f/sess-1783609624398-smn6q9/inbound.db" \
  "SELECT content FROM messages_in WHERE recurrence IS NOT NULL"
```

Expected: the JSON `content` field's `prompt` mentions both `hammer` and `ann` as destinations and both `dad`/`mom` as `list_person_tasks` arguments. If it only mentions one recipient, the on-wake instruction wasn't followed correctly — re-send a corrective message (`ncl groups restart --id ag-1782273071167-th1q6f --message "..."` or a normal DM) asking Aurora to fix the existing task via `update_task` rather than creating a second one, then re-run Step 3 to confirm still exactly one row.

- [ ] **Step 5: Commit** — none (DB change only, not tracked in git). Skip.

---

## Final verification (do this after all three tasks)

1. Re-read `groups/skylight-morning/CLAUDE.local.md` end to end once more — confirm it reads coherently as a single document (no leftover references to the old single-recipient design, no contradictions between the "Trigger Recognition" and "Scheduled Task" sections).
2. Confirm `groups/skylight-morning/CLAUDE.local.md.bak-2026-07-10` exists as the rollback point.
3. Leave the schedule running — the real first live-fire confirmation is tomorrow's 6am run. If it doesn't behave as expected, per the design doc's rollback section: cancel the task (`cancel_task` from within an Aurora session, or clear `recurrence` directly on the row via `scripts/q.ts`) and restore `CLAUDE.local.md` from the backup.
