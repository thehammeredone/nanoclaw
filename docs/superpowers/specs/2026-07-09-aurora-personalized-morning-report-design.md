# Aurora: scheduled, personalized morning report over Matrix

**Date:** 2026-07-09
**Status:** Approved design — pending implementation plan
**Author:** Hammer + Claude

## Problem

Aurora (the `skylight-morning` agent, `ag-1782273071167-th1q6f`) was just wired to
Matrix this session as two separate DMs — hammer↔Aurora and ann↔Aurora (see
`docs/runbooks/matrix-homeserver-resume.md` for that history). Live testing surfaced
three gaps before it's ready for daily use:

1. **No re-auth path.** When the Skylight token is stale, Aurora falls back to a
   generic "credentials aren't connected — paste a token into OneCLI" message. That's
   the wrong mechanism — Skylight's own MCP server already has a self-contained
   `authenticate()` tool that does a headless-browser login using credentials already
   configured on the MCP server. Aurora just doesn't know to use it.
2. **No schedule.** The report only fires when someone messages Aurora. It needs to
   run automatically every morning, the way the ai-news digest already does for Radar
   on Discord (`0 6 * * *`, see `docs/superpowers/specs/2026-07-06-radar-ainews-agent-design.md`).
3. **No personalization.** The current report mixes everyone's chores together and
   sends the same content regardless of recipient. Hammer should see Dad's tasks; Ann
   should see Mom's.

## Decisions (locked)

| Decision | Choice |
|----------|--------|
| Re-auth mechanism | Aurora calls the Skylight `authenticate` MCP tool itself on any auth error, then retries once. No manual OneCLI/token-paste flow. |
| Re-auth failure behavior | Generic, best-effort message for the failed section only ("couldn't pull X today") — never blocks the rest of the report. User has explicitly OK'd generic responses here. |
| Reward points section | Dropped entirely — not needed for this report. |
| Weather + family calendar | Shared, identical content in both Hammer's and Ann's reports. |
| Chores/tasks section | Personalized via the existing `list_person_tasks` tool: `person="dad"` → Hammer, `person="mom"` → Ann. |
| Schedule | Daily 6am (America/New_York, matching Aurora's container `TIMEZONE`), single consolidated recurring task — not two separate schedules. |
| Schedule anchor | Hammer's DM session (`mg-1783608739461-4om0w9`) — arbitrary choice among Aurora's three wired sessions; doesn't limit sending to Ann, since destinations are agent-group-scoped, not session-scoped. |
| How the schedule gets created | Aurora calls `schedule_task` itself, live, in response to a one-time instruction — the recurrence system requires the agent to call this tool (container can't write `inbound.db` directly per the two-DB split); there's no way to seed it purely from the host side. |

## Design

### 1. Re-authentication instructions

Add to `groups/skylight-morning/CLAUDE.local.md`: if any `skylight` MCP tool call
fails with an auth/401-shaped error, call `authenticate` (no arguments — it reads
`SKYLIGHT_EMAIL`/`SKYLIGHT_PASSWORD` from the MCP server's own env, already
configured), then retry the failed call once. If `authenticate` itself fails, or the
retry still fails, treat that section as unavailable and say so briefly rather than
stopping the whole report or asking the user to do anything.

No infrastructure change needed — the container Dockerfile already sets
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium` and
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` globally, so Playwright inside the Skylight venv
will use the system Chromium already installed for `agent-browser`. Verified present
during this session's investigation; not yet verified by an actual live
`authenticate()` call — that happens during implementation/testing.

### 2. Report content and personalization

Each morning, for each recipient, the report is:

```
Good morning, <Name>! ☀️ Briefing for <date>.

🌤️ Weather — <shared weather block, identical for both>

📅 Today's calendar — <shared family calendar, identical for both>

✅ <Dad's|Mom's> tasks today — <from list_person_tasks(person="dad"|"mom")>
```

No reward points section. Weather and calendar are fetched once per run and reused
in both outgoing messages (avoids duplicate Skylight calls). Tasks are fetched
separately per person via `list_person_tasks(person="dad", date=<today>)` and
`list_person_tasks(person="mom", date=<today>)`, which already returns chores and
routines (grouped by time-of-day slot) filtered to that person's Skylight category —
no manual filtering logic needed on Aurora's side.

### 3. Delivery

Two separate messages per run: `<message to="hammer">` with Dad's tasks, `<message
to="ann">` with Mom's tasks. Both destinations already exist
(`ncl destinations list --agent-group-id ag-1782273071167-th1q6f` shows `hammer` →
`mg-1783608739461-4om0w9` and `ann` → `f2cfdd4d-bc63-4ce1-8a0e-cddf3626a394`, added
earlier this session). If Ann hasn't set up Element yet when the 6am run fires, her
message just waits as a room invite — not a failure condition.

### 4. Schedule setup

One `schedule_task` call, made by Aurora itself (not injected by the host):

- `recurrence`: `"0 6 * * *"`
- `prompt`: instructs Aurora to run the full flow above — fetch weather + calendar
  once, fetch both people's tasks, send both personalized messages, using the
  re-auth-on-failure behavior from §1.
- `processAfter`: next 6am occurrence.

Triggered by sending Aurora a one-time live message asking it to set up this
recurring task. This mirrors how Radar's existing 6am schedule was set up and is the
only supported way to create a recurring task per the architecture (`docs/architecture.md`
§ scheduling — the container can't write `messages_in` directly).

### 5. CLAUDE.local.md updates

`groups/skylight-morning/CLAUDE.local.md` needs:
- The re-auth-on-failure instruction (§1).
- The new report template and personalization mapping (§2), replacing whatever
  generic/mixed chores instructions are there now.
- A note recording that the 6am recurring task exists (so future sessions —
  including a fresh container after restart — have this context without needing to
  rediscover it), per the container's own memory convention in `container/CLAUDE.md`.

## Testing / verification

1. Send a live test message asking Aurora to run through the new report logic
   immediately (not waiting for 6am) — confirms weather/calendar/task-personalization
   all work and both destinations receive the right content.
2. Deliberately verify the re-auth path if the current token has expired (it had, as
   of this session) — confirms `authenticate()` succeeds against the live Skylight
   account inside the container and the retry then succeeds.
3. After Aurora calls `schedule_task`, confirm via `list_tasks` (or a host-side query
   of `messages_in` in Aurora's session DB) that exactly one recurring row exists with
   `recurrence = "0 6 * * *"`.
4. Confirm no reward points section appears in either report.

## Out of scope

- Any change to the dormant "Morning Briefing" group room or its wiring.
- Adding more people/profiles beyond Dad/Mom.
- Retry/backoff logic beyond "one retry after one `authenticate()` call" — user has
  explicitly accepted generic/best-effort failure behavior.
- Changing which Skylight tools are used for weather (unchanged, no-auth-required
  path already works).

## Rollback

If the schedule misbehaves, cancel it with `cancel_task` (from within an Aurora
session) or by clearing `recurrence` directly on the `messages_in` row from the host
side. If personalization or re-auth instructions cause worse behavior than before,
revert `groups/skylight-morning/CLAUDE.local.md` to its prior version (not in git —
`groups/` is gitignored, so keep a copy before editing). No irreversible state is
created; per the user, if it breaks after implementation, we'll adjust from there
rather than needing a full rollback plan.
