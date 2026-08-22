---
sid: 89adc05b-1d36-4718-8a2a-bba509a1fed1
pwd: /home/hammer/git/nanoclaw-v2
model: Opus 5
date: 2026-08-22
tags: [work-record]
---

# Work Record — Cut orchestrate-backlog token usage: reporting discipline, context metering, and TASK-29/30 landing

## Purpose / Intent of the session

The operator drives `orchestrate-backlog` headless on a 5.5-hour `/loop`, and judged that the
skill was burning tokens narrating to an absent reader — restating subagent determinations
between tasks instead of saving output for the end of a task or a genuine hang-up. The session
was opened through `skill-creator` with a directive to mine `/session-history` and the last
work record, quantify where the tokens actually go, and rewrite the skill accordingly. It ended
by landing the eval's real output — TASK-29 — onto `hammer` and reviewing TASK-30 for inclusion.

## Major steps taken

1. Mined the two prior orchestrator sessions (`fe8a8e37`, 11 tasks; `c34ccecb`, 1 task) via
   `session-history` and established the cost model: orchestrator context is monotonic, so
   740 kB admitted produced **40.1M cache-read tokens** — every admitted byte re-read ~211×.
2. Built a `metrics` subcommand + `metrics.sh` that splits any session's admitted context by
   source, and measured the baseline: `bash_results` 23%, `agent_reports` 22%,
   `dispatch_prompts` 20%, `bash_cmds` 17%, `prose` 8%.
3. Confirmed the operator's hypothesis concretely — **10 full run-status tables emitted
   mid-run**, plus findings re-narrated in paragraphs and mid-run self-corrections.
4. Asked the two questions that changed the skill's shape (unconditional vs headless-gated
   silence; natural experiment vs synthetic eval) and took the answers: unconditional, both.
5. Rewrote `SKILL.md` with §Reporting discipline (five checkpoints, one line per settled task)
   and §Context discipline (measured table, lever per row); capped every dispatch template's
   report at ≤400 words with evidence routed to Implementation Notes; added `summary.sh`.
6. Snapshotted the prior skill as `skill-snapshot-v2/` and wrote `V3-BASELINE-context-metrics.md`.
7. Ran a two-arm synthetic eval (v3 vs the v2 snapshot) on TASK-29 in isolated worktrees,
   graded it with a purpose-built `grade_run.py`, aggregated a benchmark, and published the
   eval viewer.
8. Read the result honestly: the eval is structurally unable to test the reporting discipline
   at n=1 task, and A5 inverted. Recorded that as the headline analyst note rather than
   claiming a win.
9. Fixed two real bugs in `start_task.sh` that the eval surfaced, and one pre-existing
   `parse_task` bug found while building `summary.sh`.
10. Compared the two arms' TASK-29 implementations, landed the stronger one on `hammer`, then
    reviewed TASK-30 against source and included it with two corrections.

## Major outcomes

- **The cost model is now measured, not guessed.** `metrics.sh` reports admitted context by
  source plus cache-read amplification for any session, live or past. The insight it encodes:
  the meter is *bytes admitted*, not bytes emitted, because nothing ever leaves orchestrator
  context.
- **`orchestrate-backlog` is now explicitly a headless skill** that reports at five checkpoints
  and stays silent between them, with `summary.sh` supplying the end-of-run table from
  `state.json` so no status table need be carried in prose.
- **Report caps demonstrably work** — the one assertion that discriminated: subagent final
  reports averaged **2.8 kB under v3 vs 5.3 kB under v2**, a 47% cut on the second-largest
  context category.
- **The quality floor held on both eval arms** — real `--no-ff` merges, all ACs met, green
  suites, both review verdicts recorded. Neither arm got cheaper by doing less.
- **Three script bugs fixed**, all in the path of unattended runs: `start_task.sh` swallowed a
  failed status-flip commit behind `|| true` (printed a branch name, exited 0, left a dirty
  tree that trips `finish_task.sh` much later); it also fell through an unchecked `git checkout`
  when a sibling worktree held the branch; and `parse_task` returned `>-` as the title for
  YAML folded scalars, which fed branch slugs.
- **TASK-29 landed on `hammer`** at `4ebb3b69` — 402/402 tests, `tsc` clean, status Done.
- **TASK-30 filed on `hammer`**, reviewed against source and corrected before acceptance.
- `main` remains untouched at `8be5be93`, per the repo's branch rule.

## Artifacts

### Git commits

Remote: `https://github.com/nanocoai/nanoclaw.git`

| Hash | Summary |
|------|---------|
| `1e32204da04acf4ada6d4ece9579ec599a703172` | backlog(task-30): correct discovery-mechanism detail and note the macOS-only verification limit |
| `a8a517a60975ad0097620f19eefd19e589537fc2` | backlog: file follow-up for container-runtime --format trust gap (task 30) |
| `4ebb3b6903b902a8ce07650dc64e8d0c6e8f9a23` | Merge branch 'task-29-teardown-treat-unparseable-onecli-output-as-unknown-not-absent' (task 29) |
| `c6057d0de0148aee7b0a26c396a4053c21be2cbc` | chore(task-29): finish |
| `80a426010b974685621b23bf936a0c2ac0bcd386` | backlog(task-29): implementation notes |
| `d552e4aeb2efacf8a876b38af67d862eeb73a1d8` | fix(teardown): treat unexpected onecli agents-list shapes as unknown |
| `2b966f905790594c69648ebcaf034a8416859022` | docs(task-29): align unknown-semantics wording with the parse-failure path |
| `e0eb10ecb5b7cc85c9ef325f355c89f849f9b41e` | fix(teardown): treat unparseable onecli output as unknown, not absent |
| `3d1f8d6021b65457e1c3be424a7ca7bd605a22bf` | chore(task-29): start |

### Uncommitted changes at session end

_Working tree clean (or not a git repo)._

### Eval worktree tips — recorded before removal

Two `isolation: worktree` eval arms ran TASK-29 independently. Both were removed after this
record was written; their commits survive only in the reflog, so the tips are recorded here.

**Arm A — v2 control** (`worktree-agent-a81b4caab0d28f8e8`), tip
`a24179a01f5fa2e14d0ee671316a80dda38eebea`. **This arm's work is the one that landed** — its
merge `4ebb3b69` is now on `hammer`; only the tip commit (eval run notes) was discarded.

| Hash | Summary |
|------|---------|
| `a24179a01f5fa2e14d0ee671316a80dda38eebea` | eval: record orchestrate-backlog snapshot-v2 run notes for TASK-29 |
| `4ebb3b6903b902a8ce07650dc64e8d0c6e8f9a23` | Merge branch 'task-29-…' (task 29) — **landed on `hammer`** |

**Arm B — v3 candidate** (`worktree-agent-aaac9d35e9e12b430`), tip
`824f607f99bf7314f7f924ca7beb4f0c88f3a7dc`. Its TASK-29 implementation was **discarded** in
favour of Arm A; only its TASK-30 backlog file was cherry-picked out (as `a8a517a6`).

| Hash | Summary |
|------|---------|
| `824f607f99bf7314f7f924ca7beb4f0c88f3a7dc` | eval: record orchestrate-backlog run notes for task-29 |
| `e29d1afd49b4956eaff55cce379d1518c7c5c460` | backlog: file follow-up for container-runtime --format trust gap (task 30) — **cherry-picked to `hammer`** |
| `247243f4c0080165a74917f5ee0eb769157c71c8` | Merge branch 'task-29-onecli-parse-unknown' (task 29) — *discarded* |
| `bd849e8692debac0cc4aa39e336e7d17faf3dc82` | chore(task-29): finish |
| `8db3379accc444dc606ff640a5ba6e0c4d49e199` | docs(task-29): orchestrator review notes |
| `63fe5342d5d69cb38e4e20ac9ffd44c221dd804f` | docs(task-29): failure-mode count no longer says three |
| `15b81493f8dc7b1e246eee9fcc644e2c01a44216` | fix(teardown): validate parsed onecli agents-list shape, not just parse success |
| `e60b9398b505390e0ae7415d2345e0137cc405b4` | fix(teardown): treat unparseable onecli output as unknown, not absent |

Recovery: `git reflog` / `git show <sha>`, or `git branch <name> <sha>` to resurrect either arm.
The one thing worth retrieving from Arm B is its shape-mismatch warning, which echoes
`res.stdout.slice(0, 200)` so an operator sees what the runtime actually returned — Arm A's
equivalent message is static.

### Other artifacts

**Modified outside this repo** — `~/.claude/skills/orchestrate-backlog/` is not version
controlled here, so these exist only on disk:

- `SKILL.md` — new §Reporting discipline and §Context discipline; headless declaration in the
  preamble and frontmatter description; checkpoint step in the Step 1 loop; Step 2 rewritten
  around `summary.sh` + `metrics.sh`; §Cost renamed §Subagent cost; two new red flags.
- `references/dispatch-templates.md` — ≤400-word report budget (≤250 for delta-verifier and
  validator), a verbatim report-length clause to paste into every dispatch, and every
  template's report block rewritten to route evidence to Implementation Notes.
- `scripts/orchestrate.py` — new `metrics` and `summary` subcommands; `parse_task` YAML
  folded-scalar and quoted-title fix.
- `scripts/metrics.sh`, `scripts/summary.sh` — new (chmod +x).
- `scripts/start_task.sh` — checkout verification and commit-failure handling.

**Skill workspace** (`~/.claude/skills/orchestrate-backlog-workspace/`):

- `skill-snapshot-v2/` — the pre-session skill, used as the eval control.
- `V3-BASELINE-context-metrics.md` — baseline, targets, eval outcome, instrumentation caveat.
- `evals/evals.json`, `evals/grade_run.py` — eval definition with per-assertion status, and the
  grader.
- `iteration-1/` — both arms' gradings, timings, run notes, `benchmark.json` (with eight
  analyst notes), `benchmark.md`, `review.html`, and `INCIDENTAL-TASK-29-FINDING.md`.

**Memory:** `reference_orchestrator_context_amplification.md` written and indexed in
`MEMORY.md` — the ~200× amplification figure and how to run `metrics.sh`.

**Subagents:** two — the v3 arm and the v2 control arm, each running a full TASK-29
orchestration in its own worktree (110.6k and 113.5k orchestrator tokens; ~421.8k in
sub-subagents for the control arm alone).

## Rejections, negations & lessons learned

- **The synthetic eval failed to test the thing it was built to test, and I reported that
  rather than the 7/8-vs-6/8 headline.** The pathology being fixed — a status table re-emitted
  after every task — needs *two or more* tasks to appear, and the eval ran one. v2 already said
  "don't check in between tasks", and in a single-task run there is no "between". Both arms
  emitted ~1.0 kB of mid-run prose with zero tables, so A1/A2/A3 were non-discriminating by
  construction. *Lesson:* an eval has to be able to produce the failure it is scoring. Check
  that the control arm *can* fail before spending two full orchestrations on it.

- **Assertion A5 inverted — the control used 2,166 output tokens to the candidate's 10,116.**
  Decomposing it showed ~90% of output tokens are tool-call construction and thinking; prose
  was ~1,050 tokens. *Lesson:* A5 was measuring a quantity the reporting rules do not govern.
  Pick the metric from the mechanism you changed, not from the invoice.

- **The user's framing was right but not on the biggest line, and saying so mattered.** Prose
  was 8% of admitted context — the only 100%-waste category and the only one billed twice, but
  `bash_results` (23%), `agent_reports` (22%) and `dispatch_prompts` (20%) were all larger. The
  scope was widened to all four rather than fixing only what was asked. *Lesson:* quantify
  before accepting the framing, then fix the whole class.

- **Two peer messages arrived mid-eval carrying real findings, and were deliberately not acted
  on.** Both arms' review gates independently found the same residual defect in TASK-29 (a
  parse-*success*-but-wrong-shape payload still reaches the silent-`(none)` end state). Acting
  would have edited an arm's worktree mid-run and contaminated the measurement. Recorded to
  `INCIDENTAL-TASK-29-FINDING.md` instead, including the arms' MEDIUM-vs-LOW disagreement about
  whether it fails safe. *Lesson:* a finding that arrives during a measurement is data about
  the measurement; park it, don't chase it.

- **`skill-creator`'s `aggregate_benchmark.py` silently produced a 0% benchmark twice.** It
  expects `eval-N/<config>/run-N/` and reads `grading.json` under a `summary` key with
  `execution_metrics` — none of which is stated where the workflow tells you to write
  `grading.json`. Both failures printed success. *Lesson:* the schema doc and the script
  disagree; read the script.

- **`metrics.sh` mis-bucketed subagent reports on its first real use.** It matched
  `startswith("<task-notification>")` plus `isMeta`, which is right for a top-level session but
  wrong for a nested one, where the notification is both `isMeta` and wrapped in a
  `[SYSTEM NOTIFICATION …]` preamble — filing every subagent report under `skill_text`. Caught
  because the grader and the metrics tool disagreed on the same transcript. *Lesson:* two
  independent implementations of the same measurement is a cheap and effective check.

- **The eval arms' worktrees were cut from `origin/main`, not `hammer`.** Neither had `backlog/`
  or `src/teardown/` at all; both had to re-base onto `hammer`'s tip before they could start.
  They also derived the same branch name for the same task and collided, costing one arm a
  hand-rolled `start_task.sh`. *Lesson:* recorded in `evals.json` as next-iteration design —
  pre-create arm worktrees off the real base with distinct branch prefixes.

- **The chosen implementation was Arm A's, on evidence rather than on which skill produced it.**
  The guard code was byte-equivalent in both arms; Arm A won on 7 test cases to 6 (it covers
  `{"data": {}}`, which would otherwise throw `.find is not a function`) and on catching the
  `scripts/delete-agent-group.ts` exit-code repeat-site that Arm B missed. *Lesson:* the
  candidate arm losing on merit is a valid outcome and must not be quietly avoided.

- **TASK-30 was corrected before acceptance rather than filed as written.** Its description
  claimed both discovery functions use "exact Set membership"; verification against source
  showed `findImageTags` does but `findContainers` regex-tests `^nanoclaw-v2-<folder>-\d+$`, so
  an implementer working from the original text would have written one guard for two shapes.
  Also added the AC#2 constraint that Apple Container is macOS-only and this box is Linux/WSL2.
  *Lesson:* a follow-up task filed by an agent is a hypothesis; verify its premises against
  source before it drives work, exactly as the last session found with TASK-8's premises.

- **Scope deliberately not taken:** Arm B's more diagnostic shape-mismatch warning (which echoes
  200 chars of the offending stdout) was left unported — it was offered rather than applied,
  since the ask was to land a branch, not to improve it. The prose targets in
  `V3-BASELINE-context-metrics.md` are likewise left **unvalidated**, to be settled by
  `metrics.sh` on the next real multi-task `/loop` run rather than by another single-task eval.
