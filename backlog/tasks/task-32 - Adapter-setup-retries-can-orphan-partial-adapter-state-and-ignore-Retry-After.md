---
id: TASK-32
title: Adapter setup retries can orphan partial adapter state and ignore Retry-After
status: To Do
assignee: []
created_date: '2026-08-24 03:10'
labels:
  - channels
  - reliability
dependencies: []
ordinal: 32000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Follow-up from task-21 code review (Minor findings, deliberately deferred).

1. src/channels/channel-registry.ts calls adapter.setup() up to 10 times on the SAME adapter instance (3 in-window + 6 background retries) with no adapter.teardown() in between. The Chat SDK bridge's setup() starts sync loops and HTTP listeners, so an attempt that throws late — after it has already started those — orphans them. Every subsequent retry stacks another set. Consider calling teardown() (best-effort, swallowing errors) before each re-attempt, or re-running registration.factory() for a clean instance.

2. A 429 is retried on the fixed ladder and ignores any Retry-After header/field on the error. For a rate-limited platform this can retry far too early and burn the ceiling for nothing.

3. Minor robustness: the in-window ladder uses a 'setupError !== undefined' sentinel to distinguish failure from success, so a literal 'throw undefined' would read as success. Use an explicit boolean.

4. The test-only exports _resetForTests / _pendingBackgroundRetryCount compile into dist. _resetForTests clears the whole registry, so a stray production call would kill every channel. No production callers today; consider guarding or moving them behind a test-only entry point.

5. The in-window ladder is serial across channels and awaited at src/index.ts:132, so a network-cold boot now costs up to ~17s PER channel before delivery polls and the ncl socket start. Consider running adapter setup concurrently, or moving the in-window ladder off the startup critical path entirely (the background ladder already exists).

None of these block the task-21 fix, which is merged.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 adapter.setup() is never re-invoked on an instance whose previous setup partially succeeded without an intervening teardown (or a fresh instance is used)
- [ ] #2 429 responses honour Retry-After when the adapter surfaces it
- [ ] #3 host startup is not serialized behind the full in-window retry ladder for every channel
<!-- AC:END -->
