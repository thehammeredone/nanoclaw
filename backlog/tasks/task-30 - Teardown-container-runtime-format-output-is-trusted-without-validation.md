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

findImageTags and findContainers in src/teardown/agent-group-teardown.ts invoke CONTAINER_RUNTIME_BIN with a --format Go template and treat the stdout as an authoritative newline-separated list. CONTAINER_RUNTIME_BIN is rewritten to 'container' by /convert-to-apple-container. If that runtime ignores or mishandles --format, it can exit 0 and emit a human-readable table instead. Every tag/container then fails exact Set membership and reads as (none), collectIncomplete stays empty, and teardown exits 0 while images and containers survive.

Unlike the onecli case there is no JSON envelope to shape-check, so the fix is likely a sanity check on the output form (e.g. reject lines containing whitespace/headers when a template was requested) or a runtime capability probe. Decide deliberately rather than assuming docker semantics.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 findImageTags and findContainers cannot silently report (none) when the container runtime ignores the --format template
- [ ] #2 Behavior verified for at least the docker and apple-container runtime paths
- [ ] #3 docs/runbooks/agent-group-teardown.md updated if the failure-mode list changes
<!-- AC:END -->
