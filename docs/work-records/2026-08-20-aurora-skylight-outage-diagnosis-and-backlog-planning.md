---
sid: 9bcadaf6-3351-4862-8bee-85cc8b8f9834
pwd: /home/hammer/git/nanoclaw-v2
model: Opus 5
date: 2026-08-20
tags: [work-record]
---

# Work Record — Aurora Skylight outage diagnosis and backlog planning

## Purpose / Intent of the session

The user asked to review Aurora's current setup and diagnose why the agent had persistent
trouble "using the auth on the skylight mcp correctly." The investigation found the problem
was never authentication. It widened into a broader review of Aurora's session topology,
SDK context accumulation, and the dead memory-agent wiring, then converted the findings into
Backlog tasks rather than immediate fixes — the user explicitly chose to plan before acting.

## Major steps taken

1. Inventoried Aurora's agent group (`ag-1782273071167-th1q6f`), container config, wirings,
   and all four session directories.
2. Compared the Skylight MCP venvs across sessions and found the Discord-wired session's
   `.skylight-venv-0.2.3` contained only pip + setuptools.
3. Traced the `[ -d venv ] || (venv && pip install)` guard to explain why a half-built venv
   is reused forever, and matched it to degraded reports from 2026-08-16 onward.
4. Corrected an initial wrong assumption: checked the `destinations` tables and found the
   Discord session always delivered to Matrix, so Discord was only ever the inbound wiring.
5. Investigated SDK session continuation: found `continuation:claude` resuming one transcript
   since 2026-08-11, persisted group-level under `.claude-shared/projects/`.
6. Read `docs/SDK_DEEP_DIVE.md` and `providers/claude.ts` to check for native fresh-context
   wiring; found `forkSession` and the `SessionStart` hook, neither of which does this.
7. Verified the memory sub-agent wiring at the user's request — confirmed Aurora has no
   `type='agent'` destination at either the central or session layer.
8. Scoped the upstream divergence: merge-base 2026-05-18, 880 commits upstream, 57 on hammer.
9. Filed four new Backlog tasks and amended five existing ones; committed as `0bec54c9`.
10. Added a `Needs Review` status to `backlog/config.yml` and gated three tasks behind it;
    committed as `55375c83`.

## Major outcomes

- **Root cause of the Aurora outage identified.** `sess-1782319186963-b2yjgn`'s Skylight venv
  holds only `_distutils_hack`, `pip`, `pkg_resources`, `setuptools` — no `server` module,
  no playwright. `python -m server` dies on import, so the MCP server never registers and
  there is no tool error to quote. Reports degraded from 2026-08-16 (outbound seq 437/439/441).
- **The failure was never auth.** Two prior rounds of `CLAUDE.local.md` edits targeted
  authentication (force re-auth every run, then 60/120/240s retry escalation) against a
  process that was never starting.
- **Aurora's memory wiring confirmed dead.** No `type='agent'` destination exists for Aurora
  at either layer, while Mjollnir (12 sessions) and Terminal Agent (1) still have theirs.
  Every "query memory before responding" call and every behavioural correction Aurora was
  told to forward has gone to an unresolvable address.
- **Session topology corrected.** The 6am cron lives in a Discord-wired session but has always
  delivered to Matrix (`hammer` + `ann`). Ann's wiring has never instantiated a session at all.
- **A one-line fix identified for context growth.** Not passing `resume` on task-kind batches
  yields a daily rollover, because `processQuery` already persists the new session id on the
  `init` event (`poll-loop.ts:371`).
- **Backlog is now the source of truth** for this work: 9 tasks filed or amended, with a
  review gate that the orchestrator structurally cannot pick up.

## Artifacts

### Git commits

Remote: `https://github.com/nanocoai/nanoclaw.git`

| Hash | Summary |
|------|---------|
| `55375c83ba1158f33531d3db3c86c35f13dd7a26` | backlog: add a Needs Review status and gate the three open tasks behind it |
| `0bec54c9b376ad00bffef8e26bf972fdc65ac559` | backlog: file Aurora session/context tasks and amend the decommission set |

### Uncommitted changes at session end

```
 M groups/skylight-morning/CLAUDE.local.md
?? groups/ai-news/article1.png
```

### Other artifacts

**New Backlog tasks**
- TASK-22 — Run scheduled tasks on a fresh SDK session (daily context rollover) `[HIGH]`
- TASK-23 — Clone Aurora onto its own agent group for Ann's DM `[Needs Review]`
- TASK-24 — Re-audit Aurora's CLAUDE.local.md auth and error-handling rules `[MEDIUM]`
- TASK-25 — Rebase hammer onto upstream main and review 3 months of changelog `[Needs Review]`

**Amended Backlog tasks**
- TASK-5 — raised medium → high; recorded the second occurrence and the outage link
- TASK-6 — re-scoped around the 1-to-1 split; moved to `Needs Review`
- TASK-7 — corrected the false "posting to Discord" premise; flagged as active outage
- TASK-8 — superseded "Aurora keeps both Matrix wirings"; carved Ann out to TASK-23
- TASK-9 — added the Aurora memory-destination verification and the `type`/`kind` gotcha

**Config change**
- `backlog/config.yml` — added a `Needs Review` status ahead of `To Do`. Array values cannot
  be set via `backlog config set`; the file must be edited directly.

**Scratchpad (not persisted to repo)**
- `<scratchpad>/aurora-plan-state.md` — verified findings and decision log for this session.

## Rejections, negations & lessons learned

- **Misdiagnosed the Discord/Matrix split.** I asserted the cron ran in a Discord session and
  delivered to Discord, and built a "why you've seen inconsistent behavior" story on it. The
  user corrected it: the cron pushes to Matrix. The `destinations` table confirmed they were
  right. *Lesson: check the destinations table before reasoning about where output goes — the
  wiring's channel is inbound routing and says nothing about delivery.*

- **Reported a false finding from a silently-failing query.** Swept all sessions for agent
  destinations using `WHERE kind='agent'`; the column is `type`. With `2>/dev/null` the error
  vanished and the empty result read as "no agent destinations anywhere," which I nearly
  reported. Re-running correctly showed Mjollnir and Terminal Agent still have theirs.
  *Lesson: never suppress stderr on an exploratory query; an empty result and a failed query
  look identical. Recorded in TASK-9 for the next person.*

- **Overstated "0 compactions ever."** Current transcripts show zero compactions, but
  `groups/*/conversations/` holds archives from Jun 30, Jul 17, and Aug 10 — archiving works,
  it just fires rarely. *Lesson: scope a claim to what was actually measured.*

- **Asserted CLAUDE.md staleness from memory instead of code.** Claimed resumed sessions never
  re-read `CLAUDE.local.md`. `settingSources: ['project','user']` *is* set (`claude.ts:304`),
  so the file does load at init; whether `resume` re-reads it was never verified. I offered to
  test it; the user declined ("no experiment, i just want fresh sessions"). *Lesson: flag the
  unverified premise in the task rather than letting an inference harden into a fact — TASK-22
  records it as "likely, not proven."*

- **User rejected my design in favour of a simpler one.** I proposed suppressing continuation
  persistence for report runs. The user pointed out that persisting the fresh id gives a daily
  rollover — fresh at 6am, grows with the day's chat, replaced next morning. Verified correct
  and it reduced the change to one line. *Lesson: state the mechanism plainly enough that the
  user can spot the better variant.*

- **Over-engineered around edge cases the user did not care about.** Proposed an opt-in
  `ephemeral` column, an `.every()` guard for mixed batches, and moving the `PreCompact` hook
  to `Stop`/`SessionEnd`. All three were waved off: apply to all task-kind, use `.some()`,
  and archival is not a concern. *Lesson: propose the guard, but do not build it before the
  user agrees the failure mode matters.*

- **Deferred by the user:** Ann's clone (TASK-23) until Aurora is fixed; the rebase (TASK-25)
  until after the agent fixes; a "Backlog planning mode" skill derived from this session,
  until the agent work is done.

- **Swept an unrelated file into a commit.** `git add backlog/tasks/` picked up the previously
  untracked `task-21`, which was not part of this session's work. Disclosed to the user rather
  than left silent. *Lesson: prefer explicit paths over directory-wide `git add` when the
  working tree has pre-existing untracked files.*

- **Verified only the orchestrator's selector, not a full run.** `Needs Review` is excluded by
  `orchestrate.py:165` (`status == "To Do"`), but other scripts in that skill were not audited
  for status assumptions. Flagged to the user as something to watch on the first run.
