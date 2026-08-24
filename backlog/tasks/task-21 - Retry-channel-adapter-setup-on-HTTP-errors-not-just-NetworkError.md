---
id: TASK-21
title: 'Retry channel adapter setup on HTTP errors, not just NetworkError'
status: In Progress
assignee:
  - '@orchestrator'
created_date: '2026-08-20 03:41'
updated_date: '2026-08-24 03:11'
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

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented in `src/channels/channel-registry.ts`.

**Classifier.** `isNetworkError` replaced by `isTransientSetupError`, which treats as transient: `NetworkError`, `AbortError`/`TimeoutError`, HTTP 429 and 5xx, and connection/DNS error codes (`ETIMEDOUT`, `ECONNRESET`, `ECONNREFUSED`, `EAI_AGAIN`, `ENOTFOUND`, `EHOSTUNREACH`, `ENETUNREACH`). Status is read defensively from `status`, `statusCode`, `httpStatus`, `response.status`, `response.statusCode`, each validated as an integer in 100-599, and finally sniffed from the message text — matching both the incident's `HTTPError: Server returned 502 error` and got's `HTTPError: Response code 502 (Bad Gateway)`. All 4xx other than 429 remain non-transient by design, so a bad token still fails fast (AC#3).

Both the code and the status lookups walk the `err.cause` chain (depth-bounded at 5, cycle-guarded). This was a round-2 fix and it is the one that matters most in practice: Node's `fetch` rejects with `TypeError: fetch failed` whose own `code` is `undefined` and whose `cause.code` holds the real DNS code — so without the cause-walk, the cold-boot DNS failure this runbook already documented would still have died with zero retries.

**Two ladders (AC#1, AC#2).** In-window 2s/5s/10s (3 retries) during startup; if still transient after that, a background ladder of 6 more attempts at 15s/30s/60s/120s/240s/300s. Timers are `unref()`ed so a pending retry cannot hold the process open. On success the adapter is added to `activeAdapters`; on a non-transient error or the ceiling, it gives up permanently and logs `Channel adapter background retry ceiling reached, giving up permanently`.

**Ceiling (AC#3).** 3 + 6 = 9 retries, ~13 minutes of wall clock, documented in a header comment block in `channel-registry.ts` and in `docs/runbooks/matrix-homeserver-resume.md`, including which log line means an operator restart is genuinely required.

**Teardown cancellation.** A retry chain in flight when `teardownChannelAdapters()` runs is cancelled via a generation counter checked immediately after every `adapter.setup()` await (both ladders, both the resolve and throw paths). Without it a late-resolving attempt could repopulate `activeAdapters` after shutdown, or schedule a timer into just-cleared state — which also leaked across test files, since `teardownChannelAdapters()` is the `afterEach` in `src/modules/approvals/picks.test.ts` and `src/modules/permissions/permissions.test.ts`.

**Tests.** 8 new vitest cases in `src/channels/channel-registry.test.ts` (fake timers, no real waits): 502 retried then succeeds, 401 fails fast with one call, background recovery after the in-window ladder, ceiling reached and terminates, cause-chain `ENOTFOUND`, non-numeric `status` field, got-shaped 502, teardown-during-in-flight-setup. Full suite 428/428, `pnpm run build` clean.

**Deferred to TASK-32** (Minor review findings, none blocking): `setup()` is re-invoked on the same adapter instance without an intervening `teardown()`, so a late-throwing attempt can orphan Chat SDK sync loops/listeners; 429 ignores `Retry-After`; the in-window ladder is serial and on the startup critical path (~17s per channel on a cold network); test-only exports land in `dist`.
<!-- SECTION:NOTES:END -->
