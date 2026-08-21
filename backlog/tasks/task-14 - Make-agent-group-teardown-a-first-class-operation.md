---
id: TASK-14
title: Make agent-group teardown a first-class operation
status: In Progress
assignee:
  - '@orchestrator'
created_date: '2026-07-31 02:51'
updated_date: '2026-08-21 13:40'
labels:
  - docs
dependencies: []
references:
  - src/cli/crud.ts
  - scripts/delete-cli-agent.ts
  - docs/db-central.md
priority: medium
ordinal: 14000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
This cleanup surfaced that nanoclaw has no real "delete an agent group" operation.

`ncl groups delete` is genericDelete (src/cli/crud.ts:200) -- a bare DELETE against agent_groups with
foreign_keys=ON. Any group that has ever been wired or run has rows in messaging_group_agents, sessions,
agent_destinations or agent_group_members, all plain REFERENCES with no ON DELETE CASCADE (only
container_configs cascades). So the documented CLI verb simply throws an FK error and is unusable for its
stated purpose.

The only working teardown is scripts/delete-cli-agent.ts, which is named and documented as being for the
setup ping-pong scratch agent. It is actually generic -- it sweeps every table with an agent_group_id
column, then removes groups/<folder>/ and data/v2-sessions/<id>/ -- but nobody would find it under that name.

Gaps found while planning this cleanup, none of which the script covers:
  - agent_destinations rows in OTHER groups pointing at the deleted group. target_id has no FK, so these
    survive silently and break the referring agent at runtime instead of at delete time.
  - Mirrored destinations rows inside other groups' session inbound.db files.
  - pending_questions references sessions(id) but has no agent_group_id column, so the dynamic table sweep
    misses it and the sessions DELETE can hit an FK error. Zero rows today, so it has not bitten yet.
  - Running containers are not killed before the rows disappear.
  - Per-group docker image tags nanoclaw-agent-v2-<hash>:<group-id> are left behind.
  - The OneCLI agent auto-created by ensureAgent (src/container-runner.ts:429) and its secret assignments
    are never removed, so the vault accumulates orphan agents holding real credentials.
  - Messaging groups left with no wiring at all.
  - Prose references in surviving groups' CLAUDE.md / CLAUDE.local.md. Not automatable, but a warning
    listing which groups mention the deleted one by destination name is cheap and would have caught the
    Mjollnir "querying memory is mandatory" instruction.
  - Orphaned data/v2-sessions/<group-id>/ directories with no matching sessions row (local-qwen3.6 has one).

Deliverable: either promote the script to scripts/delete-agent-group.ts and wire it behind `ncl groups
delete` with a confirmation flag, or write the manual teardown runbook under docs/runbooks/. Either way
docs/db-central.md and docs/api-details.md describe these tables but document no deletion order -- that
needs to exist somewhere.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 A single documented command tears down an agent group without FK errors
- [ ] #2 Teardown covers inbound destination edges, per-session destination mirrors, containers, images and the OneCLI agent
- [ ] #3 Teardown warns about prose references to the group in other groups' instruction files
- [ ] #4 Orphaned messaging groups and orphaned session directories are reported
- [ ] #5 Deletion order documented in docs/db-central.md or a runbook
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Provenance: Claude Code session 9934a222-4185-48a6-8de2-07b8bbe71cf7 (2026-07-30). Discovery data and reasoning: docs/work-records/2026-07-30-decommission-planning-aurora-discord-wiring-and-four-agent-groups.md and docs/state-discovery.md

INPUT FROM TASK-8 EXECUTION 2026-08-20 (orchestrator session fe8a8e37):

A teardown tool must handle ROOT-OWNED DOCKER MOUNT STUBS. Every retired session dir
contained an empty 'extra/skylight' directory owned by root:root -- a bind-mount target
Docker auto-created. A plain 'rm -rf' as the host user FAILS on these and leaves orphan
skeletons behind. With passwordless sudo unavailable, the workaround was to mount each
session dir into a throwaway 'alpine:3' container as uid 0 and rm -rf from inside.

Any generic teardown implementation needs this step, or it will silently leave directories
behind and report success. Also worth an explicit refusal guard keyed on the sessions being
KEPT -- the TASK-8 loop carried one so the surviving Matrix session dir could not be hit.

Verified deletion order from pragma_foreign_key_list (all NO ACTION):
  inbound -> sessions:         pending_approvals.session_id, pending_questions.session_id
  inbound -> messaging_groups: messaging_group_agents, sessions, pending_channel_approvals,
                               pending_sender_approvals, user_dms
  NO FK (must be hunted):      unregistered_senders.messaging_group_id

REVIEW FINDINGS 2026-08-20 (orchestrator session fe8a8e37). NOT YET APPLIED -- session ended.
Implementation is committed at 5d44af5c on branch task-14-make-agent-group-teardown-a-first-class-operation, which is NOT merged. tsc clean, 370 tests pass, no Critical finding, happy path correct. FK ordering, path guards, plan/execute split and the report-only-mirrors rationale all verified against source.

FIX THESE TWO BEFORE MERGING OR USING THE TOOL:

1. IMPORTANT -- agent-group-teardown.ts:446 (also :466, :685, :771, :809). 'docker' is hardcoded
   in all five shell-outs, bypassing CONTAINER_RUNTIME_BIN / stopContainer() in
   src/container-runtime.ts, which exists precisely so a runtime swap is a one-file change and
   which /convert-to-apple-container rewrites. On an Apple-container install every docker call
   fails, findContainers returns [], the plan prints 'WILL STOP -- (none)' with the real reason
   buried in WARNINGS, and executeTeardown then deletes rows and rm -rf's
   data/v2-sessions/<id>/ out from under a STILL-RUNNING agent container.

2. IMPORTANT -- agent-group-teardown.ts:445. 'if (!folder) return { names: [], warnings: [] };'
   emits no warning, so residual mode (the documented resume path, plan.folder === null) skips
   container discovery entirely and SILENTLY. A resumed '--id ... --yes' removes the session
   directory with no indication containers were never checked. Line 602 warns for the same
   residual case on the groups dir, so this is an inconsistency as well as a hazard.

MINOR (defer or fold in):
3. scripts/delete-cli-agent.ts:59-62 -- the shim prints warnings to stderr then exits 0. The old
   script let fs.rmSync throw, giving non-zero. setup/auto.ts:365 keys its cleanup step purely on
   exit code, so 'couldn't remove groups/_ping-test' is now reported as SUCCESS -- the opposite of
   the contract asserted at delete-agent-group.ts:126-128.
4. agent-group-teardown.ts:800 -- fs.rmSync without force:true. An ENOENT raised mid-walk is not
   EACCES/EPERM/ENOTEMPTY, so it skips the container fallback and returns {ok:false}: directory
   left behind, warning only, exit 0. force:true also closes the existsSync/rmSync TOCTOU at :744.
5. src/cli/resources/groups.ts:75-86 -- deleteHandler always throws, but operations.delete stays
   'approval' and dispatch.ts:104-125 requests approval BEFORE invoking the handler. A container
   agent running 'ncl groups delete' (--id auto-filled under cli_scope: group) DMs an admin an
   approval request that looks like agent self-destruction; on approve, the handler throws. The
   refusal should short-circuit ahead of the approval round-trip.
6. agent-group-teardown.ts:579 and :722 -- inbound-edge query/delete use
   'WHERE target_id = ? AND agent_group_id != ?' with no target_type='agent' filter, though
   target_id is polymorphic. The established helper at
   src/modules/agent-to-agent/db/agent-destinations.ts:109 does filter. Not exploitable today
   (both id spaces are UUID/prefixed) and it leaves idx_agent_dest_target unused, but it is a
   latent mismatch on a DESTRUCTIVE statement.
7. agent-group-teardown.ts:337 -- the prose scan globs only top-level CLAUDE*.md per surviving
   group. Per-group skills (groups/<folder>/skills/*/SKILL.md) are group instructions too and are
   never scanned, so a 'querying <deleted group> is mandatory' line in a skill survives teardown
   unreported -- exactly the failure mode AC#3 exists to catch.

ALSO UNRESOLVED (raised by the implementer, not yet addressed): a real teardown races the live
host sweep. The tool stops containers and deletes the wiring first, but the 60s sweep runs
throughout. The runbook does not tell operators to stop the service first. Decide before TASK-13
uses this tool against local-qwen3.6, which is its intended first real use.

The EACCES/root-owned-stub fallback branch is implemented and unit-covered on the non-privileged
path but was NEVER exercised for real -- no synthetic group produced root-owned stubs. That
branch fired for real in TASK-11, so it matters.

CORRECTION + FULL REVIEW RESULT 2026-08-20. Supersedes the framing of finding 2 above.

VERDICT: Spec ✅ compliant (all five ACs verified against the diff AND against live data).
Quality: CHANGES REQUESTED on two Important items. No Critical.

The reviewer independently derived the blocking FK set rather than trusting the runbook and
found NO FK the tool would still trip on. Key structural proof: every inbound reference to
agent_groups uses a column literally named agent_group_id, so the introspection sweep is
PROVABLY complete -- there is no differently-named FK column it could miss. The two sessions
blockers are computed, not hard-coded, and deleted before the sessions DELETE.

The path guard was attacked with 11 hostile folder/id values ('../groups/keeper',
'../../precious', absolute, '..', '.', '/', empty, 'sub/../keeper', etc). ALL 11 BLOCKED, zero
breaches, sibling dirs and out-of-root files survived every case. Symlink-to-directory is not
an escape either (rmSync unlinks the link, target intact). The crud.ts 'genericDelete
unchanged' claim was verified byte-for-byte: 11 changed lines total, deleteHandler set in
exactly one file. The cli_scope self-destruct reasoning was CONFIRMED at dispatch.ts:85-88 --
--id really is auto-filled to the caller's own group, so declining to wire the real teardown
behind that verb was correct. accessToken really is stripped (:508) and the live 'onecli agents
list' really does emit aoc_ tokens, so that mattered.

IMPORTANT #2 IS WORSE THAN RECORDED ABOVE. It is not merely 'silent'; residual mode can NEVER
finish the job, and the run still exits 0. Two halves compose badly:
  (a) planTeardown resolves 'folder' only from the agent_groups row (:527-531). Once that row
      is gone, folder is null, so groups/<folder>/ is NEVER removed -- and passing
      '--id X --folder Y' does NOT help, because opts.folder is ignored entirely whenever
      opts.agentGroupId is set.
  (b) scripts/delete-agent-group.ts:128 calls process.exit(0) UNCONDITIONALLY, regardless of
      result.warnings.
Failure scenario: the DB transaction commits, then 'rm -rf groups/aurora' fails (root-owned
stub, alpine unavailable) and 'onecli agents delete' fails (gateway down). The script prints
warnings and EXITS 0. The operator re-runs with --id as the runbook instructs; residual mode
warns 'folder unknown' and exits 0 again. Net result: a permanently un-cleanable group
directory PLUS a live OneCLI vault agent still holding injectable credentials for a group that
no longer exists -- with success exit codes throughout. The runbook's TL;DR claim that
're-running after a partial failure finishes the job' is therefore FALSE for the group
directory.
  Fix: let --folder supplement --id in residual mode, AND exit non-zero when result.warnings is
  non-empty (at minimum when the directory or OneCLI steps failed). Correct the runbook TL;DR.

Additional minor the earlier list missed: renderPlan can OVERSTATE -- in the escape harness the
plan listed a sibling dir under 'WILL DELETE' for a group whose folder was '../groups/keeper',
even though execution correctly refused it. Fails safe (over-warns, under-deletes) but plan and
execute should agree.

Reviewer's dangling-symlink retest: the ENOENT-mid-walk concern from the other reviewer does
NOT reproduce -- rmSync recursive handled it. So minor #4 above is TOCTOU-only, not a
live-churn hazard.

Reviewer recommendation: approve after the two Important items. Both are small -- import one
constant, and propagate an exit code plus accept --folder in residual mode. Neither risks
destroying the WRONG data on this Docker/Linux install; target selection is the strongest part
of the diff.

Review findings applied on branch task-14-... at commit 32fc2ebe. All 8 findings addressed (2 Important, 6 Minor) plus the open question (documented, not coded). Runtime shell-outs now use CONTAINER_RUNTIME_BIN; failed container discovery renders as COULD NOT CHECK; --folder supplements --id in residual mode behind assertSafePath; both scripts exit 2 when incomplete (shared collectIncomplete); shim exit code honest for setup/auto.ts; force:true on rmSync; ncl groups delete is 'open' so refusal short-circuits the approval round-trip; target_type='agent' filter on the inbound-edge read and DELETE; prose scan covers per-group skills/<name>/SKILL.md; plan applies the executor path guard (REFUSED section). Runbook adds stop/start of nanoclaw-v2-b3501fc6 (+ launchd equivalent) and corrects the TL;DR idempotence claim. tsc clean, 385 tests pass (was 370). Exit codes verified end-to-end on a synthetic sandbox group; the four real agent groups are unchanged.

ROUND-2 REVIEW + FIX COMPLETE 2026-08-21 (orchestrator session c34ccecb). MERGED.

Implementation 5d44af5c, fix round 1 at 32fc2ebe, fix round 2 at 17338768.
Final: tsc clean, 395/395 tests (was 370 at implementation).

CRITICAL FOUND AND FIXED IN ROUND 2 -- introduced by the round-1 fix instruction itself.
Round 1 was told to 'let --folder supplement --id in residual mode'. It did so correctly,
and the instruction was unsafe: assertSafePath proves a folder is a direct child of groups/
with no separator, but says NOTHING about whether a surviving agent_groups row owns it.
  '--id <ghost> --folder keeper --yes' destroyed a LIVE group's directory, left its row,
  wiring and sessions intact, and exited 0 printing 'Torn down agent group ...'.
The host keeps waking that group into a directory whose CLAUDE.md, skills, agent-runner-src/
overlay and workspace are gone and are not in git. Realistic on this install: groups/main
exists on disk with no backing row, and the runbook hands the operator
'--id <id> --folder <name> --yes' as ONE command with no dry-run gate.
  Fix: SELECT id FROM agent_groups WHERE folder = ? after the path guard, before adopting
  opts.folder; refuse with a warning naming the owner. Violated the module's own stated
  invariant ('every directory removal is keyed on the exact target id') until fixed.

IMPORTANT ALSO FIXED IN ROUND 2: a FAILED CHECK exited 0. collectIncomplete counted only
steps attempted-and-failed, so when discovery itself failed (onecli agents list / docker
images erroring) the step was never attempted and never counted -- rendering '(none)' to
the operator. That is exactly the residue the exit-code work existed to prevent: a live
OneCLI vault agent still holding injectable credentials for a deleted group, behind exit 0.
Round 1 had fixed this bug class for containers and left it for images and OneCLI.
Now findImageTags/findOnecliAgent carry unknown:true, plan carries imagesUnknown/onecliUnknown,
render says '(COULD NOT CHECK)', and all three unknowns feed collectIncomplete.

VERIFIED BY REVIEW, NOT ASSUMED: path guard re-attacked with 12 hostile --folder values in
residual mode -- all traversals refused; symlink case safe (rmSync lstats, unlinks the link,
target intact). 'approval'->'open' on ncl groups delete cannot weaken any other authorization:
crud.ts:286 is the sole consumer, registered per-command, and dispatch.ts's cli_scope gate runs
BEFORE the approval gate and is independent of cmd.access. target_type='agent' filter cannot
miss a real edge (column only ever holds 'channel' or 'agent').

stopContainer() NOT used, deliberately -- three reasons, all verified: it calls execSync
directly and so bypasses the TeardownEnv.exec seam every teardown test relies on; it throws
instead of returning a result teardown can turn into a warning and continue; and it hardcodes
-t 1 where teardown uses -t 5 so a container can flush its outbound DB. All five shell-outs
use CONTAINER_RUNTIME_BIN, so an Apple-container install works.

HOST-SWEEP RACE -- decided, documented not coded. The 60s host sweep runs throughout a
teardown. Runbook now opens with stopping the service (systemd unit nanoclaw-v2-b3501fc6,
launchd equivalent given) and closes with starting it. No in-code coordination.

INCIDENT during round 2: the fix agent's first reproduction attempt went through
src/config.ts's process.cwd()-derived DATA_DIR and inserted a synthetic 'ag-keeper' row into
the REAL data/v2.db. It caught and deleted the row itself. Independently verified afterwards
by the orchestrator: agent_groups back to exactly 4 rows, zero keeper/ghost/synth residue in
container_configs / messaging_group_agents / sessions / agent_destinations /
agent_group_members, PRAGMA foreign_key_check clean, PRAGMA integrity_check ok, groups/ and
data/v2-sessions/ untouched. Lesson for anyone testing this tool: a sandbox that imports
src/config.ts is NOT a sandbox.

KNOWN REMAINING GAP (filed as follow-up, not blocking): findOnecliAgent leaves unknown:false
when 'onecli agents list' SUCCEEDS but returns unparseable output (JSON.parse throws). Only
exec failure sets unknown. Narrower than the fixed case and pre-existing.
<!-- SECTION:NOTES:END -->
