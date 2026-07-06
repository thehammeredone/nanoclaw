# Split ai-news out of Mjollnir into a dedicated agent ("Radar")

**Date:** 2026-07-06
**Status:** Approved design — pending implementation plan
**Author:** Hammer + Claude

## Problem

The AI-news digest functionality is entangled inside the **Mjollnir** agent group
(`ag-1779381936325-6ki38t`, folder `dm-with-hammer`). Mjollnir is a general-purpose
personal assistant, and the ai-news machinery has accreted into it as files, container
packages, and three overlapping recurring schedules scattered across three different
sessions. The schedules have also drifted: none of them post to the dedicated
`#ai-news` Discord channel (created 2026-06-29) — they post to Hammer's DM and the
`assistant` channel instead.

The goal is to extract everything ai-news into a new, focused agent and leave Mjollnir
clean.

## Current-state audit (what's entangled)

Mjollnir's personality prompt (`groups/dm-with-hammer/CLAUDE.local.md`) is **clean** —
no ai-news content. The entanglement is entirely in supporting assets:

1. **Files** in `groups/dm-with-hammer/`:
   - `ai-news-digest.py` — digest generator (produces pre-chunked `digest-discord.json`)
   - `ai-news-radar/` — the RSS/feed scraper repo
   - `digest-discord.json`, `digest-latest.md`, `digest-seen-urls.json` — state files
2. **Container packages** (`container.json`): `python3-requests`, `python3-bs4`,
   `python3-feedparser`, `python3-dateutil`, `git` — present only for the scraper.
3. **Three overlapping recurring schedules** (in `messages_in`, `recurrence` set):
   - session `sess-1779382599609-varxh7` (Hammer DM): `0 6 * * *` → chunked digest to `hammer`
   - session `sess-1779712779312-mkfbud` (assistant): `0 */6 * * *` → digest to assistant channel
   - session `sess-1779668110195-wdbfsb` (assistant): `0 8 * * *` → digest to `hammer`
4. **Memory** (shared `memory` agent, `groups/memory/wiki/`): only two historical
   query-log lines in `log.md`. `behaviors/mjollnir.md` has **no** ai-news content.

## Decisions (locked)

| Decision | Choice |
|----------|--------|
| Digest destination | **`#ai-news` Discord channel only** (stop DM + assistant auto-digests) |
| New agent identity | **Focused news-curator** — new name, purpose-built personality |
| Agent name | **Radar** |
| Schedule | **Daily 6am ET** (`0 6 * * *`), single consolidated task |
| Memory | Shared `memory` agent (same as all agents); no per-agent store |

## Design

### 1. New agent group: Radar

- Create agent group **Radar**, folder `groups/ai-news/`, modeled on Aurora
  (`skylight-morning`) — a dedicated, schedule-driven agent.
- **Personality** (`CLAUDE.local.md`): terse AI-news curator. Link-first digest style,
  no chit-chat. Owns the scraper + digest schedule. Deliberately **omits** Mjollnir's
  mandatory per-message memory-lookup ritual (overkill for a scheduled feed).
- **Container config** (`container.json`): scraper packages
  `python3-requests`, `python3-bs4`, `python3-feedparser`, `python3-dateutil`, `git`.
  `cli_scope: group` (default). No MCP servers, no extra mounts.
- **Memory**: uses the shared `memory` companion agent like everyone else. It may send
  insights, but does not run a lookup on every message.

### 2. Move the machinery

Move from `groups/dm-with-hammer/` → `groups/ai-news/` (mounts at `/workspace/agent/`):
`ai-news-digest.py`, `ai-news-radar/`, `digest-discord.json`, `digest-latest.md`,
`digest-seen-urls.json`. (`groups/` is gitignored — these moves are operational, no
git commit.)

### 3. Rewire the channel

- Delete wiring `mga-1782750223877-dfyw29` (ai-news messaging group → Mjollnir).
- Create new wiring: ai-news messaging group (`bcdb9b4c-4051-4363-b7aa-e0a12e3845da`)
  → Radar. Preserve `mention-sticky` engage mode (matches current channel behavior;
  changeable later).

### 4. One clean schedule

- A single recurring task in Radar's ai-news session: `0 6 * * *` (6am ET) →
  run scraper + `ai-news-digest.py`, then post the pre-chunked `digest-discord.json`
  array to `#ai-news`, one message per chunk, followed by a one-line top-story summary.
- This adopts the best of the three legacy schedules (the chunked-Discord variant) and
  drops the redundancy.

### 5. Strip ai-news out of Mjollnir

- **Cancel** all three recurring schedules (sessions `varxh7`, `mkfbud`, `wdbfsb`) by
  clearing their recurrence so they stop re-arming.
- **Remove** the ai-news files from `groups/dm-with-hammer/`.
- **Remove the scraper-specific packages** from Mjollnir's `container.json`:
  `python3-requests`, `python3-bs4`, `python3-feedparser`, `python3-dateutil`. **Keep the
  bones** — `git` and base `python3` (general-purpose tooling, not scraper-specific).
  This requires rebuilding Mjollnir's image. (Decision: Hammer, 2026-07-06 — revised from
  the earlier "leave container untouched".)
- Mjollnir's personality is left untouched.

### 6. Memory touch-up (light)

- Trim/annotate the two ai-news query-log lines in `groups/memory/wiki/log.md`.
  Nothing to remove in `behaviors/mjollnir.md`.

## Testing / verification

1. Rebuild Radar's image; first spawn with `--rebuild` (Aurora gotcha: new dedicated
   agents need a rebuild before first use).
2. Manually trigger one digest run and confirm chunks post to `#ai-news`.
3. Confirm Mjollnir: no ai-news files; `container.json` packages reduced to `git` (base
   `python3` retained implicitly); image rebuilt; all three schedules no longer re-arm;
   and Mjollnir no longer answers `#ai-news`.
4. Confirm no digests land in Hammer's DM or the `assistant` channel after cutover.

## Out of scope

- Changing the scraper's sources/scoring logic.
- Any change to Mjollnir's personality or its other channels (DM, assistant).
- Migrating historical ai-news conversations out of Mjollnir's `conversations/`.

## Rollback

The change is reversible: re-point the ai-news wiring back to Mjollnir, move the files
back, re-add the four scraper packages to Mjollnir and rebuild, and re-arm one schedule.
Radar can be deleted via `ncl groups delete` if abandoned.
