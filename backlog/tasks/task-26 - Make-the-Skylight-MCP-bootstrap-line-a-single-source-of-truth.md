---
id: TASK-26
title: Make the Skylight MCP bootstrap line a single source of truth
status: In Progress
assignee:
  - '@orchestrator'
created_date: '2026-08-20 23:07'
updated_date: '2026-08-26 18:31'
labels:
  - aurora
  - skylight
  - infra
  - tech-debt
dependencies: []
priority: medium
ordinal: 26000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found during TASK-5 (orchestrator session fe8a8e37, 2026-08-20). TASK-5's own description flagged this: 'this shell line lives in a DB column, not in any file under version control - anyone auditing the repo will not find it. That is arguably the deeper issue and may deserve its own task.'

After TASK-5 it is worse in one respect: the same ~1.5KB bash line now exists in THREE places that must be kept byte-identical by hand:

  1. container_configs.mcp_servers -> skylight.args[1] in data/v2.db   (authoritative, what runs)
  2. scripts/setup-aurora-agent.ts                                      (the seeder that writes it)
  3. docs/runbooks/aurora-skylight-mcp.md                               (quoted verbatim for operators)

They were verified in sync at TASK-5 merge time (73cbd113) and the runbook's Known-rough-edges section warns they must be synced by hand. That warning is not a mechanism.

Options to consider:
- Move the line into a version-controlled shell script under the read-only Skylight mount or a nanoclaw-owned path, and reduce the DB column to an invocation of it.
- Generate the DB value from the seeder at spawn/startup so the seeder is authoritative by construction.
- Add a startup check that compares the live column against the seeder's output and warns on drift.
- At minimum, a test that fails when the three copies diverge.

Note the constraint that shaped the current design: /workspace/extra/skylight is mounted READ-ONLY, so nothing can be written there, and the venv is per-session under /workspace.
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## TASK-26 implementation (session 6478828a, 2026-08-26)

### Pre-flight: were the three copies still in sync?
YES, all three, verified before touching anything:
- DB (`container_configs.mcp_servers` -> `skylight.args[1]`, group `ag-1782273071167-th1q6f`): 1569 chars.
- Seeder (`scripts/setup-aurora-agent.ts`, the JS array `.join(' ')`): 1569 chars, `cmp`-identical to the DB.
- Runbook fenced block (`docs/runbooks/aurora-skylight-mcp.md:40-56`): identical after whitespace
  normalization (`tr '\n' ' ' | tr -s ' '`), which is exactly what the doc claimed ("broken up here only
  to be readable"). It was never *byte*-identical — it could not be, being pretty-printed.

### What was built
`scripts/skylight-mcp-bootstrap.sh` is now the single version-controlled definition: readable,
indented, valid bash, carrying the full TASK-5 rationale as `#` comments (moved out of the seeder).

`scripts/skylight-mcp-bootstrap.ts` exports `skylightBootstrapLine()` — drops `#` comment lines and
blanks, trims each remaining line, joins with a single space. It throws rather than emit a
subtly-wrong line if the script grows an inline `#` (would comment out the rest of the joined line)
or a double space (would change the collapse). Verified `cmp`-identical (1569 chars) to the live DB
column, so the refactor is provably behaviour-preserving.

`scripts/setup-aurora-agent.ts` now calls `skylightBootstrapLine()` — no literal.

The runbook no longer quotes the line at all; it points at the `.sh`, gives a one-liner to print the
collapsed form, and names the drift test. Header table gained a "Bootstrap command (source of truth)"
row. "Known rough edges" bullet rewritten: the residual issue is that the DB copy is *materialized*,
not referenced (the container cannot read this repo), and nothing re-materializes it automatically —
you must re-run the seeder after editing the `.sh`.

Also rewrote "Bumping the Skylight wheel", which still told operators to hand-mutate `args[1]` in the
DB — precisely the drift this task removes. It now bumps `VER=` in the `.sh`, runs the drift test
(red), re-runs the seeder, runs the test again (green), restarts.

### The drift check (AC#3)
`scripts/skylight-mcp-bootstrap.test.ts`, vitest, picked up by `pnpm test` via the existing
`scripts/**/*.test.ts` include. Four cases:
1. collapse sanity (single line, no `#`, no double spaces, expected head/tail);
2. **no duplicate anywhere in the repo** — walks scripts/ src/ docs/ backlog/ container/ setup/,
   whitespace-normalizes each file, fails if any contains the first 60 chars of the canonical line
   (the `.sh` itself excluded). This is what enforces AC#1 going forward;
3. the runbook still points at `scripts/skylight-mcp-bootstrap.sh`;
4. **live DB agreement** — reads `data/v2.db` read-only and asserts `args[1]` equals the collapsed
   script. Returns early (no assertion) when the DB file, the row, or the table is absent, so a fresh
   clone or CI without Aurora seeded does not fail; there is no second copy to drift in that case.

TDD, red first: the test file was written before the loader existed and failed with
`Cannot find module './skylight-mcp-bootstrap.js'` (34 files passed, 1 failed).

Both drift modes then demonstrated failing against the finished implementation, and reverted:
- `sed -i 's/^VER=0.2.3;$/VER=0.2.4;/' scripts/skylight-mcp-bootstrap.sh`
  -> `x matches what is actually stored in the central DB` / `AssertionError: expected 'set -u; VER=0.2.3; ...' to be 'set -u; VER=0.2.4; ...'`
- appended the live DB line as a fenced block to the runbook
  -> `x exists nowhere else in the repo` / `expected [ Array(1) ] to deeply equal []` naming
  `docs/runbooks/aurora-skylight-mcp.md`.

### AC#4 — live DB state
NOT MODIFIED. No writes to `data/v2.db` at any point; re-read afterwards and `cmp`-verified byte-identical
to the pre-change dump. `args[1]` already equals the canonical script's collapsed form exactly, so there
was no drift to reconcile and Aurora's 06:00 job is untouched. The seeder was not run.

### Deviation worth flagging: one line of TASK-27's scope
The live `env` object carries `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`; the seeder's did
not, and the seeder overwrites `mcp_servers` wholesale. That is TASK-27 regression #1 verbatim. TASK-26's
own design now *instructs* operators to re-run the seeder (that is how a `.sh` edit reaches the DB), so
leaving the key out would have turned this task's recommended workflow into a live break of
`authenticate`. Added it to the seeder's `env` with a comment; the live row is unchanged either way.
TASK-27's general defect (a "safe to re-run" seeder that clobbers hand-tuned state — merge, `--force`,
or diff-and-confirm) is untouched and still needs doing. TASK-27 regression #2 (version literal drifting
in two files) IS fully closed by this task: `VER=` now exists once, and the test catches divergence.

### YAGNI (AC#5)
Took the "canonical file + seeder derives + drift test" shape as directed. No startup checker: the test
runs on `pnpm test`, and a host-startup check would have to read a group-specific DB row on every boot for
a condition that only changes when someone edits a file in this repo.

### Verification
- `pnpm test` -> 35 files, 432 tests, all passing (428 before; +4 new).
- `pnpm run build` (tsc) -> clean. Note it only covers `src/`; `scripts/` was typechecked explicitly
  with the same flags and is clean.
- No credentials in any new file: the `.sh` contains no `env` values, and the runbook's warning about
  never pasting them was kept and extended to the script.

### Commits (branch task-26-...)
- 876a2a3d task-26: single source of truth for the Skylight MCP bootstrap line
- f0de2fd7 task-26: point the runbook's wheel-bump procedure at the canonical script
<!-- SECTION:NOTES:END -->
