# Radar AI-News Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **STATUS: COMPLETE (executed 2026-07-06 → 2026-07-07).** All 8 tasks done + verified.
> Radar (`740a6fb3-5aff-42e8-b5dd-0a8a57d6b4a5`) owns `#ai-news`; daily digest `0 6 * * *`
> lives in session `bi95gf` (next run 2026-07-08T10:00Z); pipeline verified end-to-end
> (test digest delivered to #ai-news). Mjollnir stripped to `["git"]`, 3 schedules cancelled,
> ai-news files removed. Deviations from plan captured in `.superpowers/sdd/progress.md`:
> Radar already had router-created per-thread sessions (schedule homed in the real channel
> session, not a fresh one); Mjollnir re-created ai-news files during the ~24h execution gap
> (deleted); user kept per-thread default (no agent-shared switch); Mjollnir container packages
> were removed after all (earlier "leave untouched" reverted per Hammer).

**Goal:** Extract the AI-news digest functionality out of the Mjollnir agent into a new dedicated agent ("Radar") that owns the `#ai-news` Discord channel and posts one consolidated digest there daily at 6am ET.

**Architecture:** Radar is a new agent group (folder `groups/ai-news/`) modeled on Aurora — a focused, schedule-driven agent. The scraper/digest files move from Mjollnir's workspace into Radar's. The `#ai-news` channel is rewired from Mjollnir to Radar. Radar self-schedules its daily digest from within its ai-news session (the scheduling tool auto-targets the channel). Mjollnir's three overlapping ai-news schedules are cancelled; Mjollnir's container is left untouched.

**Tech Stack:** NanoClaw host (`ncl` CLI + `scripts/q.ts` for session-DB edits), Docker agent container (Bun), Python 3 scraper (`ai-news-radar`), Discord channel adapter.

## Global Constraints

- `groups/` is **gitignored** — all file moves and personality writes under `groups/` are operational, **no git commits** for them. Only `docs/superpowers/**` is committed.
- **Mjollnir keeps only `git`** in `container.json` apt packages — remove the four scraper-specific libs (`python3-requests`, `python3-bs4`, `python3-feedparser`, `python3-dateutil`); base `python3` is in the image regardless. This requires a Mjollnir image rebuild (Task 6). (Decision: Hammer, 2026-07-06.)
- New agents need `--rebuild` before first use (Aurora gotcha).
- Session DBs: host is the sole writer of `inbound.db`; the container only reads it. Editing Mjollnir/Radar `inbound.db` via `q.ts` from the host is architecturally valid. If a write returns `SQLITE_BUSY`, retry (host-sweep runs every 60s and briefly holds the file).
- The digest generator runs the scraper internally: one command `python3 /workspace/agent/ai-news-digest.py` scrapes + writes `digest-discord.json` (array of Discord-sized chunks) + `digest-latest.md`, and dedups via `digest-seen-urls.json`. Known-good invocation sets the onecli CA bundle: `REQUESTS_CA_BUNDLE=/tmp/onecli-combined-ca.pem`.

## Fixed identifiers (copy verbatim)

| Thing | Value |
|-------|-------|
| Mjollnir agent group id | `ag-1779381936325-6ki38t` |
| ai-news messaging group id | `bcdb9b4c-4051-4363-b7aa-e0a12e3845da` |
| ai-news channel platform_id (post target) | `discord:1507061415775834204:1521176785574694922` |
| Old wiring to delete (ai-news → Mjollnir) | `mga-1782750223877-dfyw29` |
| Mjollnir sessions holding ai-news schedules | `sess-1779382599609-varxh7`, `sess-1779712779312-mkfbud`, `sess-1779668110195-wdbfsb` |
| Mjollnir session-DB base path | `data/v2-sessions/ag-1779381936325-6ki38t/<session>/inbound.db` |

Radar's agent group id is generated at create time (Task 1) — capture it and reuse as `<RADAR_ID>` throughout.

---

### Task 1: Create the Radar agent group + container config + scraper packages

**Files:**
- Modify (DB): `data/v2.db` — `agent_groups`, `container_configs` rows (via `ncl` + tsx)

**Interfaces:**
- Produces: `<RADAR_ID>` — the new agent group id, consumed by every later task.

- [ ] **Step 1: Create the agent group**

```bash
ncl groups create --name Radar --folder ai-news
```

Expected: prints the created row including a new `id` (e.g. `ag-...` or a UUID). Record it as `<RADAR_ID>`.

- [ ] **Step 2: Confirm and capture the id**

```bash
ncl groups list
```

Expected: a `Radar` row with folder `ai-news`. Copy its `id` into `<RADAR_ID>` for the rest of the plan.

- [ ] **Step 3: Ensure a container config row exists** (add-package requires it)

```bash
pnpm exec tsx -e "import { ensureContainerConfig } from './src/db/container-configs.js'; ensureContainerConfig('<RADAR_ID>'); console.log('ensured');"
```

Expected: prints `ensured`. (Idempotent — safe if a row already exists.)

- [ ] **Step 4: Add the five scraper apt packages**

```bash
ncl groups config add-package --id <RADAR_ID> --apt python3-requests
ncl groups config add-package --id <RADAR_ID> --apt python3-bs4
ncl groups config add-package --id <RADAR_ID> --apt python3-feedparser
ncl groups config add-package --id <RADAR_ID> --apt python3-dateutil
ncl groups config add-package --id <RADAR_ID> --apt git
```

Expected: each prints `added: { apt: "<pkg>", ... }`.

- [ ] **Step 5: Verify the config**

```bash
ncl groups config get --id <RADAR_ID>
```

Expected: `packages_apt` contains all five packages: `python3-requests`, `python3-bs4`, `python3-feedparser`, `python3-dateutil`, `git`.

- [ ] **Step 6: Commit** — none (DB change only, not tracked in git). Skip.

---

### Task 2: Populate Radar's workspace — personality + move ai-news files

**Files:**
- Create: `groups/ai-news/CLAUDE.local.md`
- Move: `groups/dm-with-hammer/ai-news-digest.py` → `groups/ai-news/ai-news-digest.py`
- Move: `groups/dm-with-hammer/ai-news-radar/` → `groups/ai-news/ai-news-radar/`
- Move: `groups/dm-with-hammer/digest-discord.json` → `groups/ai-news/digest-discord.json`
- Move: `groups/dm-with-hammer/digest-latest.md` → `groups/ai-news/digest-latest.md`
- Move: `groups/dm-with-hammer/digest-seen-urls.json` → `groups/ai-news/digest-seen-urls.json`

- [ ] **Step 1: Ensure the Radar folder exists** (created by scaffold at spawn, but create now for the file moves)

```bash
mkdir -p groups/ai-news
```

Expected: no output.

- [ ] **Step 2: Write Radar's personality file**

Write `groups/ai-news/CLAUDE.local.md` with exactly this content:

```markdown
# Radar

You are Radar, a focused AI-news curator for the #ai-news channel. Your one job: run the AI-news digest and post it here. You are terse and link-first — no chit-chat, no preamble.

## Digest pipeline

Everything lives in your workspace at `/workspace/agent/`:
- `ai-news-radar/` — the RSS/feed scraper repo (invoked internally by the digest script).
- `ai-news-digest.py` — scrapes, scores, de-duplicates, and writes `/workspace/agent/digest-discord.json` (a JSON array of Discord-sized message chunks) plus `digest-latest.md`.
- `digest-seen-urls.json` — tracks already-posted URLs so stories don't repeat across runs.

To produce and post a digest:
1. Run: `REQUESTS_CA_BUNDLE=/tmp/onecli-combined-ca.pem python3 /workspace/agent/ai-news-digest.py`
2. Read `/workspace/agent/digest-discord.json` (a JSON array of strings).
3. Send each string as its own message to this channel, in order. Do NOT combine chunks and do NOT add commentary between them — each chunk is pre-sized to fit Discord's 2000-char limit.

If the scraper hits a network or certificate error, follow the onecli-gateway skill guidance; never ask a human for raw credentials.

## Style

- Link-first: `[Source] Title — URL`. Let the digest content speak; no "here's today's digest" wrapper.
- If someone asks a question in the channel, answer briefly and only about AI news.

## Reply routing

Reply in the channel/thread you received the message in — output text directly, or call `send_message` without a `to` (resolves to the current thread).
```

- [ ] **Step 3: Move the ai-news files out of Mjollnir into Radar**

```bash
mv groups/dm-with-hammer/ai-news-digest.py     groups/ai-news/ai-news-digest.py
mv groups/dm-with-hammer/ai-news-radar         groups/ai-news/ai-news-radar
mv groups/dm-with-hammer/digest-discord.json   groups/ai-news/digest-discord.json
mv groups/dm-with-hammer/digest-latest.md      groups/ai-news/digest-latest.md
mv groups/dm-with-hammer/digest-seen-urls.json groups/ai-news/digest-seen-urls.json
```

Expected: no output.

- [ ] **Step 4: Verify presence in Radar and absence in Mjollnir**

```bash
echo "--- radar ---"; ls groups/ai-news/
echo "--- mjollnir (should have NO ai-news* / digest* ) ---"; ls groups/dm-with-hammer/ | grep -E 'ai-news|digest' || echo "clean"
```

Expected: Radar lists `ai-news-digest.py`, `ai-news-radar`, `digest-discord.json`, `digest-latest.md`, `digest-seen-urls.json`, `CLAUDE.local.md`. Mjollnir prints `clean`.

- [ ] **Step 5: Commit** — none (gitignored). Skip.

---

### Task 3: Rewire the #ai-news channel from Mjollnir to Radar

**Files:**
- Modify (DB): `data/v2.db` — `messaging_group_agents` (delete + create wiring)

**Interfaces:**
- Consumes: `<RADAR_ID>` from Task 1.

- [ ] **Step 1: Record the old wiring's settings (for parity)**

```bash
ncl wirings get mga-1782750223877-dfyw29
```

Expected: engage_mode `mention-sticky`, sender_scope `known`, ignored_message_policy `accumulate`, session_mode `shared`. (These are the values the new wiring reuses.)

- [ ] **Step 2: Delete the old wiring (ai-news → Mjollnir)**

```bash
ncl wirings delete mga-1782750223877-dfyw29
```

Expected: confirms deletion.

- [ ] **Step 3: Create the new wiring (ai-news → Radar) with matching settings**

```bash
ncl wirings create \
  --messaging-group-id bcdb9b4c-4051-4363-b7aa-e0a12e3845da \
  --agent-group-id <RADAR_ID> \
  --engage-mode mention-sticky \
  --sender-scope known \
  --ignored-message-policy accumulate \
  --session-mode shared
```

Expected: prints the created wiring row with a new id.

- [ ] **Step 4: Verify the wiring map**

```bash
ncl wirings list
```

Expected: the `bcdb9b4c-...` messaging group now points at `<RADAR_ID>`; no wiring links `bcdb9b4c-...` to Mjollnir (`ag-1779381936325-6ki38t`) anymore.

- [ ] **Step 5: Commit** — none (DB change). Skip.

---

### Task 4: Build Radar's image, first spawn, and self-schedule the daily digest

**Files:**
- Modify (DB): Radar session `inbound.db` (created on first spawn; schedule row written by Radar's scheduling tool)

**Interfaces:**
- Consumes: `<RADAR_ID>` from Task 1.
- Produces: a live Radar session directory under `data/v2-sessions/<RADAR_ID>/` containing a recurring `kind='task'` row with `recurrence='0 6 * * *'`.

- [ ] **Step 1: Rebuild Radar's image and spawn with an on-wake instruction**

```bash
ncl groups restart --id <RADAR_ID> --rebuild --message "You are Radar, newly set up for this #ai-news channel. Do two things now, then report back:
1. Run one digest immediately to verify the pipeline: execute 'REQUESTS_CA_BUNDLE=/tmp/onecli-combined-ca.pem python3 /workspace/agent/ai-news-digest.py', then read /workspace/agent/digest-discord.json and post each element as its own message to THIS channel, in order (no commentary between chunks).
2. Create a recurring scheduled task: cron '0 6 * * *' (interpreted in America/New_York), that each morning runs the same digest command and posts the resulting digest-discord.json chunks to THIS channel. Use your scheduling tool and target this channel.
Confirm when both the test post and the schedule are done."
```

Expected: command returns (image build may take a few minutes). If `restart` does not spawn a container for a group that has never run, use the **fallback** in Step 2.

- [ ] **Step 2: (Fallback only) trigger first spawn via a channel message**

If Step 1 did not spawn Radar (no session dir appears within ~3 min), post a message in the Discord `#ai-news` channel that @mentions Radar (e.g. "@Radar run the digest and set up the daily 6am schedule"). This routes through the normal path and spawns the container. Then re-issue the two instructions from Step 1's message if the on-wake message wasn't consumed.

- [ ] **Step 3: Confirm the image built and a session exists**

```bash
docker images | grep -i "$(echo <RADAR_ID> | tr 'A-Z' 'a-z')" || echo "no image tag match — check ncl groups config get --id <RADAR_ID> for imageTag"
ls data/v2-sessions/<RADAR_ID>/ 2>/dev/null || echo "no session yet"
```

Expected: an image tagged for `<RADAR_ID>` exists, and a `sess-...` directory exists under `data/v2-sessions/<RADAR_ID>/`.

- [ ] **Step 4: Verify the test digest posted to #ai-news**

Check the Discord `#ai-news` channel visually, OR inspect Radar's outbound messages:

```bash
SID=$(ls data/v2-sessions/<RADAR_ID>/ | head -1)
pnpm exec tsx scripts/q.ts "data/v2-sessions/<RADAR_ID>/$SID/outbound.db" "SELECT seq, substr(content,1,80) FROM messages_out ORDER BY seq DESC LIMIT 10"
```

Expected: recent outbound messages containing digest lines (source — title — URL). If instead you see an error about network/cert, fix the invocation (confirm `REQUESTS_CA_BUNDLE`) and re-run the digest via another channel message before proceeding.

- [ ] **Step 5: Verify the recurring schedule was created**

```bash
SID=$(ls data/v2-sessions/<RADAR_ID>/ | head -1)
pnpm exec tsx scripts/q.ts "data/v2-sessions/<RADAR_ID>/$SID/inbound.db" "SELECT seq, kind, recurrence, process_after, thread_id FROM messages_in WHERE recurrence IS NOT NULL AND recurrence != ''"
```

Expected: exactly one row, `kind=task`, `recurrence=0 6 * * *`, `thread_id=discord:1507061415775834204:1521176785574694922`, `process_after` set to the next 6am ET (UTC 10:00 or 11:00 depending on DST). If missing, send Radar another message asking it to create the schedule, then re-verify.

- [ ] **Step 6: Commit** — none. Skip.

---

### Task 5: Cancel Mjollnir's three ai-news schedules

**Files:**
- Modify (DB): three Mjollnir session `inbound.db` files.

- [ ] **Step 1: Confirm exactly which task rows will be cancelled (dry look)**

```bash
for SID in sess-1779382599609-varxh7 sess-1779712779312-mkfbud sess-1779668110195-wdbfsb; do
  DB="data/v2-sessions/ag-1779381936325-6ki38t/$SID/inbound.db"
  echo "--- $SID ---"
  pnpm exec tsx scripts/q.ts "$DB" "SELECT seq, status, recurrence, substr(content,1,50) FROM messages_in WHERE kind='task' AND recurrence IS NOT NULL"
done
```

Expected: each session shows exactly one recurring ai-news task. Confirm none are non-ai-news before proceeding.

- [ ] **Step 2: Cancel the recurrence in all three sessions**

```bash
for SID in sess-1779382599609-varxh7 sess-1779712779312-mkfbud sess-1779668110195-wdbfsb; do
  DB="data/v2-sessions/ag-1779381936325-6ki38t/$SID/inbound.db"
  pnpm exec tsx scripts/q.ts "$DB" "UPDATE messages_in SET status='completed', recurrence=NULL WHERE kind='task' AND recurrence IS NOT NULL"
  echo "cancelled in $SID"
done
```

Expected: prints `cancelled in <session>` three times. (If any returns `SQLITE_BUSY`, wait ~5s and re-run that one — the UPDATE is idempotent.)

- [ ] **Step 3: Verify no recurring ai-news tasks remain in Mjollnir**

```bash
for SID in $(ls data/v2-sessions/ag-1779381936325-6ki38t/); do
  DB="data/v2-sessions/ag-1779381936325-6ki38t/$SID/inbound.db"
  [ -f "$DB" ] || continue
  OUT=$(pnpm exec tsx scripts/q.ts "$DB" "SELECT seq FROM messages_in WHERE kind='task' AND recurrence IS NOT NULL" 2>/dev/null)
  [ -n "$OUT" ] && echo "STILL ARMED in $SID: $OUT"
done
echo "check complete"
```

Expected: prints only `check complete` (no `STILL ARMED` lines).

- [ ] **Step 4: Commit** — none. Skip.

---

### Task 6: Remove scraper-specific packages from Mjollnir + rebuild

**Files:**
- Modify (DB): `data/v2.db` — Mjollnir `container_configs.packages_apt`
- Rebuild: Mjollnir agent image (`ag-1779381936325-6ki38t`)

This task restarts Mjollnir's container, so it is gated separately from the schedule
cancellation. Do it **after** Task 5 so the schedules are already dead before the rebuild.

- [ ] **Step 1: Confirm Mjollnir's current packages**

```bash
ncl groups config get --id ag-1779381936325-6ki38t
```

Expected: `packages_apt` = `python3-requests`, `python3-bs4`, `python3-feedparser`, `python3-dateutil`, `git`.

- [ ] **Step 2: Remove the four scraper-specific libs (keep `git`)**

```bash
ncl groups config remove-package --id ag-1779381936325-6ki38t --apt python3-requests
ncl groups config remove-package --id ag-1779381936325-6ki38t --apt python3-bs4
ncl groups config remove-package --id ag-1779381936325-6ki38t --apt python3-feedparser
ncl groups config remove-package --id ag-1779381936325-6ki38t --apt python3-dateutil
```

Expected: each confirms removal. Do **not** remove `git`.

- [ ] **Step 3: Verify only `git` remains**

```bash
ncl groups config get --id ag-1779381936325-6ki38t
```

Expected: `packages_apt` = `["git"]`.

- [ ] **Step 4: Rebuild Mjollnir's image so the change takes effect**

```bash
ncl groups restart --id ag-1779381936325-6ki38t --rebuild
```

Expected: image rebuild runs. Without `--message`, Mjollnir's container stops after
rebuild and respawns on the next DM — that's fine; no on-wake action is needed. Mjollnir's
personality and workspace are otherwise untouched.

- [ ] **Step 5: Commit** — none (DB + image, not tracked in git). Skip.

---

### Task 7: Memory touch-up (light)

**Files:**
- Modify: `groups/memory/wiki/log.md` (annotate the two ai-news query-log lines)

- [ ] **Step 1: Locate the two ai-news log lines**

```bash
grep -n "AI news" groups/memory/wiki/log.md
```

Expected: two lines dated `[2026-07-05]` referencing the Mjollnir daily AI news digest/report.

- [ ] **Step 2: Annotate them as superseded**

Edit `groups/memory/wiki/log.md`: append ` — [superseded 2026-07-06: ai-news moved to the Radar agent]` to each of the two matched lines. Leave the rest of the file untouched. (`behaviors/mjollnir.md` has no ai-news content — do not modify it.)

- [ ] **Step 3: Verify**

```bash
grep -n "Radar" groups/memory/wiki/log.md
```

Expected: two lines now carry the `superseded ... Radar` annotation.

- [ ] **Step 4: Commit** — none (gitignored). Skip.

---

### Task 8: Final end-to-end verification

**Files:** none (read-only checks).

- [ ] **Step 1: Wiring map is correct**

```bash
ncl wirings list
```

Expected: `#ai-news` (`bcdb9b4c-...`) → Radar (`<RADAR_ID>`); Mjollnir keeps only its DM, `assistant`, and Hammer-DM wirings.

- [ ] **Step 2: System health snapshot**

```bash
NO_COLOR=1 pnpm exec tsx scripts/status.ts
```

Expected: `HEALTHY`; a Radar session appears bound to the ai-news channel; no new critical/warning issues introduced.

- [ ] **Step 3: Confirm Radar owns the schedule and Mjollnir is clean**

```bash
echo "--- Radar schedule (expect 1 recurring row) ---"
for SID in $(ls data/v2-sessions/<RADAR_ID>/ 2>/dev/null); do
  pnpm exec tsx scripts/q.ts "data/v2-sessions/<RADAR_ID>/$SID/inbound.db" "SELECT recurrence FROM messages_in WHERE kind='task' AND recurrence IS NOT NULL"
done
echo "--- Mjollnir ai-news files (expect none) ---"
ls groups/dm-with-hammer/ | grep -E 'ai-news|digest' || echo "clean"
echo "--- Mjollnir packages (expect only git) ---"
ncl groups config get --id ag-1779381936325-6ki38t | grep -i packages_apt
```

Expected: Radar shows one `0 6 * * *` row; Mjollnir prints `clean` for files; Mjollnir `packages_apt` is `["git"]`.

- [ ] **Step 4: Cutover confirmation (manual)**

Confirm over the next day that: the 6am digest posts to `#ai-news`, and **no** AI-news digest lands in Hammer's DM or the `assistant` channel. (This is the proof the three old schedules are truly dead.)

- [ ] **Step 5: Commit the completed plan checkboxes**

```bash
git add docs/superpowers/plans/2026-07-06-radar-ainews-agent.md
git commit -m "docs(plan): mark Radar ai-news agent plan complete"
```

---

## Self-review notes

- **Spec coverage:** New agent (T1–T2), digest→#ai-news only (T3 rewire + T4 schedule), 6am ET single schedule (T4), strip files (T2) + cancel 3 schedules (T5), remove scraper packages from Mjollnir keeping git + rebuild (T6), memory touch-up (T7), verification incl. no-DM/assistant-digest + Mjollnir packages (T8). All spec sections mapped.
- **No placeholders:** `<RADAR_ID>` is an explicitly-captured runtime value (Task 1), not a placeholder for undecided content. All file contents and SQL are literal.
- **Reversibility:** re-point wiring to Mjollnir, `mv` files back, re-add the four scraper packages to Mjollnir and rebuild, re-arm one schedule.
