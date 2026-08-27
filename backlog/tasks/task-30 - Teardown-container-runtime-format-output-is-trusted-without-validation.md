---
id: TASK-30
title: 'Teardown: container-runtime --format output is trusted without validation'
status: In Progress
assignee:
  - '@orchestrator'
created_date: '2026-08-22 14:53'
updated_date: '2026-08-27 06:07'
labels: []
dependencies: []
ordinal: 30000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up from TASK-29 round-1 review (orchestrator eval run). Out of scope for TASK-29's parse-vs-exec distinction, but the same silent-(none)-behind-exit-0 shape.

findImageTags and findContainers in src/teardown/agent-group-teardown.ts invoke CONTAINER_RUNTIME_BIN with a --format Go template and treat the stdout as an authoritative newline-separated list. CONTAINER_RUNTIME_BIN is 'docker' (src/container-runtime.ts:12) and becomes 'container' on an Apple Container install — /convert-to-apple-container switches it by merging upstream/skill/apple-container. If that runtime ignores or mishandles --format, it can exit 0 and emit a human-readable table instead. Every tag/container then fails its match and reads as (none), collectIncomplete stays empty, and teardown exits 0 while images and containers survive.

Both filters were verified against source on 2026-08-22 and they differ, so a fix must cover both shapes: findImageTags builds a Set of trimmed stdout lines and takes exact membership against candidate tags, while findContainers regex-tests each line against ^nanoclaw-v2-<folder>-\d+$. Neither sets unknown:true on anything but !res.ok, which is what lets a zero-exit garbage response through.

Unlike the onecli case there is no JSON envelope to shape-check, so the fix is likely a sanity check on the output form (e.g. reject lines containing whitespace/headers when a template was requested) or a runtime capability probe. Decide deliberately rather than assuming docker semantics.

Verification constraint for AC#2: Apple Container is macOS-only and this install is Linux/WSL2, so the apple-container path cannot be exercised live here. Satisfy it with a table-shaped stdout fixture through the TeardownEnv.exec seam (the same seam every other teardown test uses) and say plainly that the live apple-container run is unverified — do not fabricate a live result.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 findImageTags and findContainers cannot silently report (none) when the container runtime ignores the --format template
- [ ] #2 Behavior verified for at least the docker and apple-container runtime paths
- [ ] #3 docs/runbooks/agent-group-teardown.md updated if the failure-mode list changes
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
2026-08-27 orchestrator review gate: spec initially FAILED AC#1, code quality CHANGES REQUESTED (2 Important, 2 Minor). Fixed in one round (a4e49fc4, 4a828c08) plus two orchestrator-applied fixes.

The review finding that mattered: the first implementation guarded with looksLikeTableRow, a NEGATIVE check keyed on internal whitespace. It closed the table shape only. Whitespace-free non-template output still read as (none) at exit 0 -- the reviewer executed three such cases through the TeardownEnv.exec seam, including compact JSON for both filters and an unpadded single-column REPOSITORY header. This was not hypothetical for the runtime the task names: origin/skill/apple-container rewrites cleanupOrphans to 'container ls --format json' + JSON.parse, so Apple Container's --format takes json|table and a JSON fallback is at least as likely as a table one. Replaced with POSITIVE per-call-site shape checks (CONTAINER_NAME_RE, IMAGE_REF_RE) plus a shared splitTemplateLines(), so a line failing its shape sets unknown:true exactly as !res.ok does and teardown still exits 2.

Two things the orchestrator caught and fixed after the fix round, both in the same class the task is about -- a guard that fails in the opposite direction:
1. IMAGE_REF_RE rejected port-qualified registry references (localhost:5000/org/img:tag, reg.io:443/ns/foo:v1) because the port adds a second colon. That is a FALSE POSITIVE: a legitimate tag would have set unknown and driven an exit 2 on a teardown that should have succeeded. Regex now allows an optional :port on the first component; added a regression test, mutation-proven to go red against the old regex. Verified the change alters nothing else -- old and new agree on every other probe including <none>:<none>, digest refs, and realistic multi-key JSON.
2. RESIDUAL GAP, deliberately not fixed and now documented in the runbook: a shape check cannot separate a single-word header from a legitimate value. docker images-style output is safe (REPOSITORY has no colon so it fails the repo:tag shape), but a single-column CONTAINER table headed NAMES passes the container-name shape, fails the nanoclaw-v2-<folder>-<ts> match, and still reads as (none) at exit 0. Multi-column tables are caught either way since they carry whitespace. If a runtime is ever found to emit a single-column container listing, the fix is a capability probe, not a stronger shape check.

PROCESS NOTE: the delta-verifier for this task was killed by an API error mid-run, DURING mutation testing, and left a perturbation in the working tree (CONTAINER_NAME_RE rewritten to /.*/ , uncommitted). The orchestrator caught it on the next inspection and restored it. A killed verifier can leave the tree mutated -- always check git status after one dies rather than trusting it cleaned up.

AC#2 remains partially unverifiable by construction: Apple Container is macOS-only and this install is Linux/WSL2, so the apple-container path is exercised only through shape fixtures on the exec seam. The live apple-container run is UNVERIFIED and the fixtures are honest stand-ins, not fabricated live results.

pnpm test 482 passed / 1 skipped; pnpm run build clean. No docker mutation commands, no DB writes, no container restarts.
<!-- SECTION:NOTES:END -->
