---
sid: f0a0c857-bd51-4fd3-aba6-766ed6de8bc2
pwd: /home/hammer/git/nanoclaw-v2
model: Opus 5
date: 2026-08-02
tags: [work-record]
---

# Work Record — Aurora and Radar frozen-prompt fix, groups tracking

## Purpose / Intent of the session

Aurora's 6am Skylight morning report had stopped following `groups/skylight-morning/CLAUDE.local.md` — it was sending five separate messages in a stale format and reporting empty calendars on days that had events. The user opened asking to restart Aurora's container, then redirected: the container wasn't the problem, the report simply wasn't doing what the current instructions file said. The session diagnosed that, then extended to auditing Radar for the same defect class, getting `groups/` under version control so procedures live in reviewable files, and chasing a Skylight auth failure that the fix surfaced.

## Major steps taken

1. Investigated the "restart the container" framing — no container was running; asked which changes were meant, and the user redirected to the real symptom.
2. Root-caused **two independent** defects in Aurora: a frozen scheduled-task prompt carrying its own contradicting procedure, and a 24-day-stale SDK continuation that meant the rewritten `CLAUDE.local.md` had never entered context.
3. Replaced Aurora's task prompt with a pointer shim; deleted its `continuation:claude` row with no container running.
4. Test-fired Aurora (one-off row, `recurrence=NULL`/`series_id=NULL`) — verified a single correctly-formatted message with 13 real calendar events.
5. Audited Radar's scheduled prompt on request; found the prompt **and** the file both carried procedures, plus a third procedure that matched neither and existed only in the transcript.
6. Escalated the three-way divergence rather than merging it unilaterally.
7. Surveyed `groups/` ignore state before un-ignoring: found a 24 M nested git checkout, a plaintext password, and spawn-regenerated artifacts.
8. Investigated whether the OneCLI vault could hold the Skylight credentials; determined it structurally cannot and recommended against the migration.
9. Rewrote `.gitignore` at file granularity, vendored the scraper's local patch, committed (`a1fd233c`, `6e48cf7e`).
10. Wrote Radar's actual procedure — including the undocumented top-stories stage — into `CLAUDE.local.md` and committed (`801ac53b`).
11. Thinned Radar's task prompt to a pointer; cleared its continuation.
12. Verified both agents against the 2026-08-02 06:00 runs.
13. Diagnosed Aurora's Skylight auth timeout as contention with Radar on the shared `0 6 * * *` minute.
14. Moved Radar to `20 6 * * *`.
15. Fired a manual Aurora brief on request — succeeded, `authenticate` in 10.6s.

## Major outcomes

- **Aurora's morning brief follows its instructions file again.** Single Matrix message, multi-profile event tagging, honest failure reporting.
- **Radar's digest session loaded `CLAUDE.local.md` for the first time.** The live digest session had **zero** injections of its own identity file across a 24-day transcript (vs 5 in the dormant session); it had been running on task prompt + two self-written memory files alone.
- **Radar's top-stories stage is documented.** `ai-news-digest.py` *removes* the 5 highest-scoring items from the regular sections into `digest-top-stories.json`; an agent following the old written procedure exactly would have silently dropped the day's best five stories. This existed nowhere on disk.
- **Both scheduled prompts are pointer shims**, and the pointer verifiably propagates through `insertRecurrence` to the next cloned occurrence.
- **`groups/` is version-controlled at file granularity** — 19 files, 144 K. Secrets, the 24 M checkout, and regenerated `CLAUDE.md` files stay ignored.
- **A latent Skylight auth failure was exposed and diagnosed.** It had been silently producing false-empty calendars since at least 2026-08-01; the honesty rule surfaced it on its first real opportunity.
- **Schedules staggered** — Radar to 06:20, leaving Aurora alone at 06:00.

## Artifacts

### Git commits

Remote: `https://github.com/nanocoai/nanoclaw.git`

| Hash | Summary |
|------|---------|
| `801ac53bff16e954af9693715585d9cba7d9a05f` | docs(radar): make CLAUDE.local.md the real digest procedure |
| `6e48cf7eefda4faf79a3bf134738a0589d51ce40` | chore(ai-news): vendor local update_news.py patch |
| `a1fd233c4313d9c28bca4761578670e6cd95c65b` | chore(git): track per-group source of truth under groups/ |

### Uncommitted changes at session end

_Working tree clean._

### Other artifacts

- **New file** `groups/ai-news/ai-news-radar.patch` — the AI Breakfast source removal, extracted from the ignored checkout so it survives a re-clone. Validated with `git apply --check --reverse`.
- **Rewritten** `groups/ai-news/CLAUDE.local.md` (30 → 71 lines) and `.gitignore` (blanket `groups/*` → targeted rules).
- **Runtime state changed, not in git:** Aurora and Radar scheduled-task prompts (`inbound.db`), both `continuation:claude` rows deleted (`outbound.db`), Radar recurrence `0 6 * * *` → `20 6 * * *`.
- **Memory written:** `reference_claude_local_md_injection.md`, `project_scheduled_task_frozen_prompt.md`, `project_sixam_schedule_collision.md` (new); `project_radar_agent.md` updated; `MEMORY.md` indexed.
- **Backups:** `scratchpad/aurora-task-content.backup.json`, `scratchpad/radar-before.json`.

## Rejections, negations & lessons learned

- **User rejected the container-restart framing, then the Skylight-wheel-rebuild framing.** Both were my initial instincts and both would have fixed nothing. *Lesson: when an agent ignores its instructions file, suspect the stored task prompt and the SDK continuation before the container, the image, or the file.*
- **User vetoed touching Skylight's `page.goto` timeout** — "skylight's agents [found] it couldn't control the timeout, so we'll leave that alone." I had flagged `token_capture.py:692` passing no explicit timeout as a second lever. *Lesson: prior investigation by another agent already closed this; don't re-open settled ground.*
- **OneCLI credential migration abandoned after investigation.** I proposed moving the Skylight password to the OneCLI vault, then found the vault only does header/query-param injection on matched hosts, while the password is typed into a login form by headless Chromium. No rule shape fits. *Lesson: verify a tool's actual contract before recommending a migration to it; the user's "I haven't seen onecli work consistently" was pointing at a real shape mismatch, not flakiness.*
- **User declined an immediate Radar test run**, choosing to wait for the scheduled 06:00 rather than post a thin deduplicated digest to #ai-news. *Lesson: outward-facing verification in a shared channel is the user's call, not a routine step.*
- **`--since <hash>` to the work-record script produced the entire repo history** (~1000 commits). The script does `git log --since="$SINCE"`, which only accepts a date despite the help text saying "a ref, hash, or date". Deleted the stray file and re-ran with `--since "2026-08-01 12:00:00"`. *Lesson: check the generated commit table before writing prose, as the skill instructs.*
- **`.gitignore` trailing comments silently broke the rules** — `groups/*/container.json  # secrets` is a literal pattern, not a pattern plus comment, so the file with the plaintext password was still staged. Caught by a `git add -An` dry run before committing. *Lesson: always dry-run `git add` when the ignore rules are what stand between you and committing a secret.*
- **Background poll exit condition was wrong earlier in the session** — required `running=0`, but containers linger after producing output, so it timed out at 15m on a run that had already succeeded. Fixed by keying on `maxseq` instead.
- **`pnpm exec tsx scripts/q.ts` failed from the `/home/hammer/git/Skylight` working directory** (`ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL`). Node/pnpm resolve relative to cwd; must run from the nanoclaw repo root.
- **Deferred by decision, not forgotten:**
  - `container.json` has no secret-reference mechanism — any group needing credentials must inline them in a permanently-ignored file. Real design gap; backlog item not filed.
  - The Skylight password (`SKYLIGHT_EMAIL`/`SKYLIGHT_PASSWORD`) remains plaintext in `groups/skylight-morning/container.json`. Flagged for rotation, not rotated.
  - Whether the 06:00 failure is contention or hour-of-day is **not yet settled** — both successes were midday, the only failure was at 06:00. The 2026-08-03 06:00 run, with Radar staggered to 06:20, is the decisive test.
