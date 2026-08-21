---
id: TASK-14
title: Make agent-group teardown a first-class operation
status: In Progress
assignee:
  - '@orchestrator'
created_date: '2026-07-31 02:51'
updated_date: '2026-08-21 01:03'
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
<!-- SECTION:NOTES:END -->
