---
id: TASK-21
title: 'Retry channel adapter setup on HTTP errors, not just NetworkError'
status: In Progress
assignee:
  - '@orchestrator'
created_date: '2026-08-20 03:41'
updated_date: '2026-08-24 02:49'
labels:
  - channels
  - reliability
dependencies: []
references:
  - src/channels/channel-registry.ts
  - docs/runbooks/matrix-homeserver-resume.md
priority: medium
ordinal: 21000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Discovered 2026-08-19 while debugging why Aurora stopped responding to Matrix DMs (session 09edab14-1853-48d3-8f5c-220e90d60aa3).

Sequence of events:
- nanoclaw-v2-b3501fc6 restarted at 12:49:19 EDT.
- Matrix adapter setup hit a transient 502 from the homeserver (`whoami` check via Caddy/Synapse) at 12:49:21 -- `HTTPError: Server returned 502 error`.
- `initChannelAdapters()` in src/channels/channel-registry.ts:53-93 only retries when the thrown error is a `NetworkError` (duck-typed via `isNetworkError`, channel-registry.ts:15-17). An `HTTPError` doesn't match, so it fails immediately with no retry and is never added to `activeAdapters`.
- Every message on that channel type is silently unroutable from then on -- no crash, no periodic re-check, just `WARN No adapter for channel type channelType="matrix"` on each attempted delivery.
- The homeserver itself came back within seconds/minutes (confirmed healthy via `curl https://thehammeredone.ddns.net/_matrix/client/versions` -> clean 200, ~10 hours later when this was investigated). The only fix was a full host service restart.

This is a general channel-registry gap, not Matrix-specific -- any adapter whose setup call surfaces an HTTP-error-shaped failure (vs the SDK's own NetworkError type) during a brief upstream blip gets permanently disabled until a manual `systemctl restart`. Worth broadening `isNetworkError`'s retry gate (or adding a parallel check) to cover 5xx/timeout-class HTTP errors, and/or adding a periodic background retry for channels that failed setup entirely, not just retries within the initial setup window.

See also docs/runbooks/matrix-homeserver-resume.md, which documents this same channel's history of flaky startup timing (DNS negative-cache issue on 2026-07-09) -- this 502 is a second, distinct way the same 'adapter setup races a still-warming homeserver' class of bug can bite.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Adapter setup retry in channel-registry.ts covers transient HTTP failures (e.g. 502/503 from the platform), not just NetworkError-typed errors
- [ ] #2 A single transient error during adapter setup no longer permanently kills the channel for the rest of the process lifetime
- [ ] #3 Decide and document a retry ceiling so a truly broken credential/config still fails fast rather than retrying forever
<!-- AC:END -->
