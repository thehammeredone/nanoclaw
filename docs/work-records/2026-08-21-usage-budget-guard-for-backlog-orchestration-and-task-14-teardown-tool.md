---
sid: c34ccecb-eaf7-4e7a-8ca5-87310e4fc15b
pwd: /home/hammer/git/nanoclaw-v2
model: Opus 5
date: 2026-08-21
tags: [work-record]
---

# Work Record — Usage-budget guard for backlog orchestration and TASK-14 teardown tool

## Purpose / Intent of the session

The previous orchestrator session (`fe8a8e37`) was stopped by the operator mid-run because the
`orchestrate-backlog` skill had no awareness of the 5-hour usage window, and TASK-14 was left
committed-but-unmerged with review findings recorded and unapplied. This session had two jobs:
first add a usage-budget guard to the skill so a run stops itself near 90% rather than losing an
agent's work to an interrupted window, then resume the backlog run and pick TASK-14 up where it
was left. The operator intends to drive the skill on a 5.5-hour `/loop` until the backlog drains
or blocks completely.

## Major steps taken

1. Read backlog TASK-13 and TASK-14 aloud; mined the prior session's transcript via
   `session-history` to establish that TASK-14 was unmerged at `5d44af5c` with two Important
   findings recorded in its notes.
2. Located the live rate-limit source: the operator's own statusline command dumps Claude Code's
   payload to `<repo>/.claude/statusline.json`, including `rate_limits.five_hour.used_percentage`.
3. Added a `budget` subcommand to `orchestrate.py` plus a `budget.sh` wrapper, emitting a
   `GO` / `FINISH_ONLY` / `STOP` / `UNKNOWN` verdict, and tested all four paths.
4. Made the guard self-calibrating: `start_task.sh` and `finish_task.sh` now stamp the window
   percentage at each end of a task, storing the delta as `budget_cost_pct` in state.
5. Fixed `lib.sh` to resolve `ORCH_BASE` from the `base_branch` already recorded in `state.json`
   before defaulting to `main`.
6. Wrote the §Usage budget section into `SKILL.md` and wired the check into Step 0, the Step 1
   loop, §Resumability and §Red flags.
7. Ran the skill: preflight clean, resumed the existing `task-14-…` branch, dispatched an `opus`
   fix-applier against the two Important findings, five minors, and the deferred host-sweep race.
8. Dispatched an `opus` delta-verifier scoped to the fix diff, which returned CHANGES REQUESTED
   with one Critical and one Important.
9. Dispatched a `sonnet` round-2 fix-applier; independently verified the real DB afterwards
   (row counts, residue sweep across six tables, `foreign_key_check`, `integrity_check`).
10. Read the Critical and exit-code fix hunks directly rather than spending another verifier,
    recorded findings to the task notes, and merged with `--no-ff`.
11. Filed TASK-29 for the residual gap, then stopped on a `FINISH_ONLY` verdict rather than
    starting TASK-13.

## Major outcomes

- **The `orchestrate-backlog` skill now budgets the 5-hour window** and refuses to start a task it
  cannot finish. Thresholds are tunable via `ORCH_BUDGET_STOP_PCT` (default 90) and
  `ORCH_BUDGET_DEFAULT_COST` (default 15).
- **The guard measured its first real task cost: TASK-14 consumed 44 points** (28% → 72%), nearly
  3× the assumed 15. That figure now persists in `state.json` and drives future verdicts, so the
  estimate sharpens across runs and across `/loop` wake-ups.
- **The guard fired for real at the end of this session** — `FINISH_ONLY` at 72% with 18 points of
  headroom — and TASK-13 was correctly not started.
- **`ORCH_BASE` no longer silently defaults to `main`** on a repo whose recorded base is `hammer`.
  This mattered specifically because the run is about to be looped unattended.
- **TASK-14 merged** at `dab4cee9` after two review rounds: teardown is now a first-class,
  safe-by-default operation with a dry-run plan, `--yes` to execute, honest 0/1/2 exit codes, and
  an operator runbook.
- **A Critical data-loss vector was found and closed before the tool ever ran against real data.**
- Test count on `hammer` went 370 → 395; `tsc --noEmit` clean; all four live agent groups and
  every session directory untouched throughout.
- `main` remains untouched at `8be5be93`, per the repo's branch rule.

## Artifacts

### Git commits

Remote: `https://github.com/nanocoai/nanoclaw.git`

| Hash | Summary |
|------|---------|
| `7cb5d32d601fc0e88ad6f6178e8ff47ad422a856` | backlog: file follow-up for teardown onecli parse-failure gap |
| `dab4cee97c94ab99c9bd7fa6158aded73150cfac` | Merge branch 'task-14-make-agent-group-teardown-a-first-class-operation' (task 14) |
| `723a03b81cd15a0ba01aae60282f3dfaf0a5e1e0` | chore(task-14): finish |
| `70269b10a6b748f1595e933f36d99101130f9e55` | backlog(task-14): record round-2 review findings and outcome |
| `17338768e8b72f95ef0929fbf55986385878c493` | fix(teardown): close residual --folder ownership gap, count discovery failures as incomplete |
| `32fc2ebe790e7c32597de1fcda606aba4f06391a` | fix(task-14): apply teardown review findings |

### Uncommitted changes at session end

_Working tree clean (or not a git repo)._

### Other artifacts

**Modified outside this repo** — `~/.claude/skills/orchestrate-backlog/` is not version-controlled
here, so these changes exist only on disk:

- `scripts/orchestrate.py` — new `budget` subcommand: `read_rate_limits()`, `observed_task_cost()`,
  `cmd_budget()`, plus `--record <id> start|end` sampling.
- `scripts/budget.sh` — new wrapper (chmod +x).
- `scripts/start_task.sh` / `scripts/finish_task.sh` — stamp `budget_start_pct` / `budget_end_pct`
  and derive `budget_cost_pct`.
- `scripts/lib.sh` — `ORCH_BASE` falls back to `state.json`'s `base_branch` before `main`.
- `SKILL.md` — new §Usage budget; edits to Step 0, Step 1, §Resumability, §Red flags, §References.

**In-repo, beyond the commit table:**

- `backlog/tasks/task-29 - Teardown-treat-unparseable-onecli-output-as-unknown-not-absent.md`
- Extensive round-2 findings appended to TASK-14's Implementation Notes (`70269b10`).
- New source files merged via `dab4cee9`: `src/teardown/agent-group-teardown.ts` (+ test),
  `scripts/delete-agent-group.ts`, `docs/runbooks/agent-group-teardown.md`,
  `src/cli/resources/groups-delete.test.ts`.

**Prior-session commits that landed on `hammer` via the TASK-14 merge** (authored 2026-08-20, so
outside this record's date window): `5d44af5c` (implementation), `f1ebf3ad`, `53b67a44`,
`3aff9e7c`.

**Subagents:** three — an `opus` fix-applier (round 1), an `opus` delta-verifier, a `sonnet`
fix-applier (round 2).

**Memory:** none written this session.

## Rejections, negations & lessons learned

- **The operator stopped the previous run for lack of a usage guard**, and opened this session by
  requiring one before any orchestration resumed. *Lesson:* an unattended multi-hour agent loop
  needs a stopping rule of its own; "run until the platform cuts you off" discards work at exactly
  the moment it is most expensive to redo.

- **A Critical data-loss vector was introduced by this session's own dispatch instruction.** The
  round-1 fix prompt said "let `--folder` supplement `--id` in residual mode." The agent implemented
  that faithfully and the *instruction* was unsafe: `assertSafePath` proves a folder is a direct
  child of `groups/` but never proves it is unowned, so `--id <ghost> --folder <live-folder> --yes`
  deleted a live group's directory, left its DB row intact, and exited 0 printing "Torn down agent
  group". *Lesson:* a correctly-executed instruction is not a safe one. When a fix opens a new path
  from operator input to a destructive operation, the verification pass must attack that specific
  path — the value here came from scoping the verifier at it explicitly, not from generic review.

- **`stopContainer()` was rejected by the round-1 agent despite being named in the instruction.**
  Three reasons, all independently confirmed by the verifier: it calls `execSync` directly and so
  bypasses the `TeardownEnv.exec` seam every teardown test relies on; it throws rather than
  returning a result teardown can convert into a warning; and it hardcodes `-t 1` where teardown
  needs `-t 5` to let a container flush its outbound DB. *Lesson:* a subagent declining a specific
  instruction with evidence is a good outcome — but it must be judged on the evidence, which is why
  the verifier was told to rule on the rejection rather than assume it.

- **A subagent wrote to the real production DB while believing it was sandboxed.** The round-2
  agent's first reproduction imported `src/config.ts`, whose `DATA_DIR` derives from
  `process.cwd()`, inserting a synthetic `ag-keeper` row into `data/v2.db`. It caught and removed
  the row itself; the orchestrator then verified independently (4 rows, zero residue across six
  tables, FK and integrity clean). *Lesson:* a sandbox that imports the project's own config module
  is not a sandbox. Also: verify a subagent's cleanup claim about live data rather than accepting
  the report — that check was cheap and was the only thing that could have caught an incomplete
  revert.

- **Round 1 fixed a bug class for one caller and left it in two others.** "A failed discovery is not
  an empty result" was applied to container discovery but not to image or OneCLI discovery, so a
  failed `onecli agents list` still rendered `(none)` and exited 0. *Lesson:* when a fix is
  described as a class of error, sweep every site in that class in the same pass.

- **Scope deliberately deferred:** the residual `onecli` JSON-parse gap was filed as TASK-29 rather
  than fixed inline, because closing it entangles with shared test fixtures whose default
  `fakeExec` returns unparseable output. *Lesson:* the round-2 cap exists for a reason; a
  fixture-wide change does not belong in a Critical fix round.

- **`ORCH_BASE` defaulting to `main` was fixed beyond the requested scope.** Not asked for, but the
  operator was about to loop the run unattended, and every wake-up would otherwise have merged task
  branches into `main` against the repo's explicit branch rule. A memory recording the trap existed
  but only helps a session that reads it. *Lesson:* when a known footgun sits directly in the path
  of what the user just asked for, fix the mechanism rather than relying on documentation.

- **The `work-record` skill's own `--since` documentation is wrong.** It advertises "a ref, hash, or
  date", but `new_work_record.sh:77` uses `git log --since=` — a date-only filter. Passing a
  baseline hash makes git ignore the bound and emit the entire repo history (1808 lines here). The
  record was rescaffolded with `--since "2026-08-21 09:00"`. *Lesson:* worth correcting in the skill
  or the script; a hash silently produces a wrong-but-plausible document.
