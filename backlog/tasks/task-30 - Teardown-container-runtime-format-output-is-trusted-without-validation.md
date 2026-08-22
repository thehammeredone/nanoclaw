---
id: TASK-30
title: 'Teardown: container-runtime --format output is trusted without validation'
status: To Do
assignee: []
created_date: '2026-08-22 14:53'
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
