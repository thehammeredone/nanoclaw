---
id: TASK-34
title: ncl positional-ID parsing fails for multi-hyphen UUIDs
status: To Do
assignee: []
created_date: '2026-09-04 12:09'
labels:
  - bug
dependencies: []
ordinal: 34000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
ncl <resource> get/delete <uuid> (positional-ID form) fails when the ID is a multi-hyphen UUID (e.g. wirings, or any UUID-keyed resource). src/cli/client.ts joins all positional args with dashes into a single command string; src/cli/dispatch.ts's fallback only trims the last dash-segment to recover the ID, which works for single-segment ids like ag-xxxx-yyyy but not a 5-segment UUID.

Repro: `ncl wirings get 95b041ba-7a62-4d03-82a6-c961bb1f76af` -> `error (unknown-command): no command "wirings-get-95b041ba-7a62-4d03-82a6-c961bb1f76af"`. Reproduced against a second unrelated UUID (35671fb9-b06c-4e77-a6b3-5d3d3e7bba34) to confirm it's general.

Workaround: use the --id <uuid> flag form instead of positional (bypasses the join-then-trim logic entirely).

Found while executing session 65bd4636-38ea-4980-bbab-4b2ac84f63f6, task 2 of docs/superpowers/plans/2026-09-03-aurora-ann-split.md.
<!-- SECTION:DESCRIPTION:END -->
