---
id: TASK-18
title: Expire stale pending approval rows and decide on a GC pass
status: In Progress
assignee:
  - '@orchestrator'
created_date: '2026-07-31 03:20'
updated_date: '2026-08-22 20:54'
labels:
  - approvals
dependencies: []
references:
  - src/host-sweep.ts
  - docs/db-central.md
priority: medium
ordinal: 18000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
There is a live pending_channel_approvals row created 2026-07-09 -- three weeks stale at time of writing -- for Aurora on the Matrix hammer DM. Its options_json still enumerates every agent group that existed that day, including Coder, Memory, Terminal Agent and local-qwen3.6. If it is still actionable, picking one of those options after the decommission connects a channel to a group that no longer exists.

pending_approvals has an expires_at column; pending_channel_approvals and pending_sender_approvals do not. Nothing observed sweeps any of them. host-sweep (src/host-sweep.ts) handles processing_ack, stale detection, due-message wake and recurrence -- not approval expiry.

Current counts: pending_approvals 0, pending_questions 0, pending_sender_approvals 0, pending_channel_approvals 1.

Two questions to answer:
1. Is a 3-week-old channel approval still clickable, or is it inert because the platform message is gone? Determines whether this is a correctness bug or just clutter.
2. Should there be a GC pass in host-sweep, and what TTL. An approval that outlives the roster it was rendered against is stale by definition.

Note that these tables also matter for teardown: pending_questions references sessions(id) but has no agent_group_id column, so it is invisible to group-scoped sweeps and can block a sessions delete unexpectedly. It happens to be empty today. See TASK-14.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 The stale 2026-07-09 pending_channel_approvals row is cleared
- [ ] #2 Answered whether a stale approval is still actionable
- [ ] #3 GC/TTL for the pending_* tables either implemented in host-sweep or explicitly declined with a reason
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Provenance: Claude Code session 9934a222-4185-48a6-8de2-07b8bbe71cf7 (2026-07-30). Discovery data: docs/work-records/2026-07-30-decommission-planning-aurora-discord-wiring-and-four-agent-groups.md and docs/state-discovery.md

## AC#1 — verified, nothing deleted

`pnpm exec tsx scripts/q.ts data/v2.db "select ... count(*) ..."` at both start and end of the session:

```
pending_approvals|0
pending_questions|0
pending_sender_approvals|0
pending_channel_approvals|0
```

The stale 2026-07-09 `pending_channel_approvals` row for Aurora on the Matrix hammer DM is already gone — cleared by earlier teardown work (TASK-16 lineage). Nothing was deleted by this task; `data/v2.db` was read-only throughout. The host service (`nanoclaw-v2-b3501fc6`) was not stopped or restarted.

## AC#2 — a stale approval IS still actionable. Correctness bug, not clutter.

The click path is entirely DB-backed with no in-memory component and no expiry check anywhere.

1. **The button lives in the platform message, which persists forever.** `src/channels/chat-sdk-bridge.ts:415` renders each option as `Button({ id: 'ncq:<questionId>:<idx>', value: String(idx) })`. For a channel approval, `questionId` is the *messaging group id* (`src/modules/permissions/channel-approval.ts:223`). Matrix/Discord/Slack keep that message in scrollback indefinitely.

2. **Lookup is by explicit stored id, not "most recent pending".** On click, `chat-sdk-bridge.ts:277-306` extracts `questionId` from the custom id, then `getAskQuestionRender(questionId)` (`src/db/sessions.ts:200-227`) re-reads `title` + `options_json` straight out of `pending_channel_approvals` (lines 212-217) / `pending_sender_approvals` (219-224) / `pending_approvals` (205-208) / `pending_questions` (203). `resolveSelectedOption` (`chat-sdk-bridge.ts:101-112`) maps the integer index back to the *stored* option value. Then `setupConfig.onAction` → `src/index.ts:168` → each registered response handler; `handleChannelApprovalResponse` (`src/modules/permissions/index.ts:311`) does `getPendingChannelApproval(payload.questionId)`.

   Consequence: age is irrelevant. Nothing compares timestamps. A host restart does not help — all state is on disk. The card is live for as long as the row exists. Conversely, deleting the row makes the card inert: the handler returns `false`, no other handler claims it, and `src/index.ts:47` logs `Unclaimed response`. **So GC is a complete fix for actionability.**

3. **Selecting an option naming a now-deleted agent group is guarded — no FK error, no dangling wiring.** `src/modules/permissions/index.ts:430-440`: `getAgentGroup(targetAgentGroupId)`; if absent it logs `Channel registration: target agent group no longer exists`, deletes the pending row, returns `true`. The `createMessagingGroupAgent` insert is never reached, so no `messaging_group_agents` row pointing at a missing group is created and `foreign_keys = ON` (`src/db/connection.ts:18,26`) is never tripped. The `choose_existing` branch (index.ts:343-382) is even safer — it re-renders options from a live `getAllAgentGroups()`.

   So the *specific* Coder/Memory/Terminal-Agent/local-qwen3.6 options in that row would have been safe no-ops. **The real damage is elsewhere:**

   - **Selecting a surviving agent group replays a 3-week-old message as live inbound.** `index.ts:452` parses `original_message` and `index.ts:500` calls `routeInbound(event)` with the original timestamp. Per the "agent's only clock is the message `time=` attribute" behavior, the agent would answer a stale prompt believing it is current.
   - **The unresolved row permanently suppresses future cards for that channel.** `hasInFlightChannelApproval` (`src/modules/permissions/db/pending-channel-approvals.ts:47`) is checked at `channel-approval.ts:131-134` and drops the retry silently. `pending_sender_approvals` has the same property via `UNIQUE(messaging_group_id, sender_identity)` (`sender-approval.ts:59`). A forgotten row = that channel/sender can never raise an approval again. This is the most serious effect and it is invisible.
   - **The row blocks teardown.** All four tables carry `NO ACTION` FKs (docs/state-discovery.md:265, 271-274) to `agent_groups` and/or `sessions`. `ncl groups delete` fails while any row survives.

   Not determined: whether every specific platform (Matrix in particular) still *renders* the buttons after N weeks or garbage-collects the interaction affordance client-side. That is platform behavior, not observable from this source tree. It does not change the conclusion — Discord/Slack definitively keep components live, and the host is unconditionally willing to act.

## AC#3 — GC implemented in host-sweep

`sweepExpiredPending(db, now)` in `src/host-sweep.ts`, called once per 60s tick from `sweep()` before the per-session loop (own try/catch so a GC failure can't skip session maintenance). Central DB only — these four tables live in `data/v2.db`, so this is not per-session work.

- **TTL: `PENDING_TTL_MS = 7 days`**, stated once as an exported constant with the rationale in the comment block above it. Covers a human away for a long weekend or short holiday who returns to an unanswered card, while staying well inside the horizon over which the agent-group roster the card was rendered against can change. The row that motivated the task was 3 weeks old.
- **No migration; rows age off `created_at`.** All four tables have `created_at TEXT NOT NULL`. Adding `expires_at` to `pending_channel_approvals` / `pending_sender_approvals` / `pending_questions` would put the expiry policy on every insert path (three call sites) instead of in one constant, and would mean a schema change against a live DB for no behavioral gain. YAGNI.
- **Explicit `expires_at` is authoritative in both directions.** `pending_approvals.expires_at` is populated from the OneCLI gateway's own deadline (`src/modules/approvals/onecli-approvals.ts:192`, a date string — it is fed to `new Date(...).getTime()` at line ~199). When present and parseable it decides alone: a past deadline expires a young row early; a future deadline holds a row past the 7-day TTL. The blanket TTL only applies when `expires_at` is NULL or unparseable.
- **`pending_questions` handled deliberately, and included.** It references `sessions(id)` with no `agent_group_id`, which makes it invisible to every group-scoped sweep and exactly the row that stalls a session delete (TASK-14). Nothing references `pending_questions` in turn, so aging it off has no cascade. The only user-visible effect is that clicking a long-dead question card becomes an `Unclaimed response` warn instead of waking a session that has moved on.
- Timestamps parsed with the existing `parseSqliteUtc` so a timezone-less SQLite timestamp is not read as local time and deleted early on a non-UTC host.
- An unparseable `created_at` **retains** the row and emits `Pending GC: unparseable created_at, row retained`. A wrong delete is unrecoverable; a retained row is clutter.
- Missing tables are skipped via `hasTable`, matching the guards `getAskQuestionRender` already uses (module migrations 011/012 may not have run in every install).
- **Logging:** one `log.info('Expired stale pending rows', { table, count, ids, ttlMs })` per affected table → `logs/nanoclaw.log`. Only primary keys are logged (generated ids / `mg-…`), never `sender_identity` or message content.
- Complementary to, not overlapping with, `src/teardown/agent-group-teardown.ts:941` which clears the same tables explicitly during teardown.

Doc claims kept in sync with the code: `CLAUDE.md` key-files row and `docs/setup-wiring.md:97` now both say `pending_*` GC (7-day TTL).

## Tests (TDD)

Extended `src/host-sweep.test.ts` with a `sweepExpiredPending` suite — 10 cases, all against a real temp DB built by the real `runMigrations()` chain with real `agent_groups` / `messaging_groups` / `sessions` parent rows and `foreign_keys = ON`. No mocks.

Cases: TTL delete across all four tables; retention inside the TTL; no-op on empty tables (today's live state); `expires_at` firing before the TTL; `expires_at` extending past the TTL; unparseable `created_at` retained; timezone-less `created_at` read as UTC; **dedup key cleared** (a second `insertChannelApproval` throws on PK collision while the stale row lives, and succeeds after GC); **FK unblocked** (`DELETE FROM sessions` throws with stale `pending_questions` + `pending_approvals` present, succeeds after GC); missing table skipped.

Red confirmed by mutation, not assumption — neutering the delete branch (`if (expired.length >= 0) continue;`) failed exactly the 4 behavior-asserting cases (all-four-tables, expires_at-early, dedup-key, FK-unblock) and passed the 6 retention/no-op cases, which is the correct signature.

```
pnpm test               → Test Files 34 passed (34), Tests 412 passed (412)
pnpm exec tsc --noEmit  → clean
```

Commit: 6f0b48c7 on branch `task-18-expire-stale-pending-approval-rows-and-decide-on-a-gc-pass`.

## Review-findings follow-up (task-18 review pass)

Fixed 5 findings from code review on this branch:

1. **Per-table isolation (Important)** — sweepExpiredPending's for-loop now wraps each table's body in try/catch; one table's SELECT/DELETE failure (e.g. a pre-007-migration install missing `expires_at` on `pending_approvals`) no longer skips the other three. Logged as `Pending GC: table sweep failed, other tables unaffected` with the table name.

2. **Unparseable created_at warns forever (Important)** — added `warnUnparseableCreatedAtOnce`, a WeakMap<Database, Set<string>> keyed on `${table}:${id}`. First sighting is `log.warn`, every later tick for the same row is `log.debug`. Scoped per DB connection so it resets naturally on process restart and never leaks across test DB instances.

3. **expires_at ceiling (Minor)** — corrected the doc comment's claimed semantics. Old: "wins in both directions... a later one holds it past the blanket TTL." New/actual: explicit expires_at can only bring expiry *forward* (a past deadline always expires the row); it can never push a row past the TTL ceiling measured off created_at. Predicate is now `explicit < now || createdAt < cutoff`. Replaced the old "extends past the TTL" test (which asserted the row survived) with a new one asserting the same row now gets deleted, plus added a "retains a row with future expires_at while inside the TTL" test for the still-valid normal case.

4. **Mid-flow row can be GC'd (Minor)** — `updatePendingChannelApprovalCard` (src/modules/permissions/db/pending-channel-approvals.ts) now also refreshes `created_at` (new optional 4th param, defaults to `new Date().toISOString()`). Verified by grep that no other reader depends on the original creation timestamp for this table — only the GC and the migrations that add the column touch `created_at`. TTL now measures time-since-last-interaction for this table, closing the "choose existing agent" mid-flow GC hole.

5. **Unbounded log / non-atomic deletes (Minor)** — each table's deletes now run inside a single `db.transaction(...)` instead of N implicit ones. Log line still reports the full count but caps the `ids` array at 10 (`ID_LOG_SAMPLE`).

6. **Unpredicated full scan (Minor)** — pushed the age filter into SQL: `WHERE created_at < ?` (plus `OR (expires_at IS NOT NULL AND expires_at < ?)` for pending_approvals). Cutoff/now bound as ISO-8601 strings so the SQL-side lexicographic comparison matches chronological order for all four writers' timestamp format. In-JS parse/retain/warn-once logic is preserved for whatever rows the predicate returns.

### Test evidence
- Added 6 new tests to src/host-sweep.test.ts: per-table isolation, expires_at-ceiling (updated existing + new), unparseable-warn-once, transaction batching, id-log-cap, mid-flow created_at refresh. Total in that describe block: 35 (was ~25).
- Mutation-checked by reverting src/host-sweep.ts and src/modules/permissions/db/pending-channel-approvals.ts to their pre-fix (HEAD) versions and re-running the new tests: all 5 behavioral tests (isolation, ceiling, warn-once, id-cap, mid-flow-refresh) failed as expected against the old code; restored the fix and all 35 passed again.
- Full suite: `pnpm test` → 418 passed, 34 files. `pnpm exec tsc --noEmit` → clean, exit 0.
- CLAUDE.md and docs/setup-wiring.md both only state the TTL generically ("pending_* GC (7-day TTL)") with no directional expires_at claim — no edit needed there. Grepped for other statements of the both-directions claim; only the host-sweep.ts comment block stated it, and that's now corrected.

Round-2 fix (commit bef42fa7): the round-1 SQL prefilter `created_at < ?` is a lexicographic string comparison, so garbage that sorts at/after cutoffIso ('not a date', 'zzzz') was never SELECTed at all -- never warned, never surfaced, retained invisibly forever, still holding its NO ACTION FK. Fixed by OR'ing in a shape check: created_at IS NULL OR created_at = '' OR created_at NOT GLOB '[0-9][0-9][0-9][0-9]-*' (src/host-sweep.ts, sweepExpiredPending). Contract verified across shapes: NULL -- schema-enforced NOT NULL on all 4 tables, unreachable at DB level, defensive-only in code; '' -- surfaced+warned+retained; '0000-00-00' -- surfaced+warned+retained (was already reachable, sorts before cutoff); 'not a date' -- surfaced+warned+retained (previously invisible, now fixed); 'zzzz' -- surfaced+warned+retained (previously invisible, now fixed -- this was the regression); '2020-01-01' bare date well past TTL -- genuinely-old, deleted, no warn; epoch-integer-as-text e.g. '1700000000000' -- surfaced+warned+retained (no leading YYYY-, fails GLOB). Known accepted gap noted in code comment: a value shaped like a date but nonsensical (e.g. '9999-99-99') can still slip past silently if it sorts at/after cutoffIso -- heuristic shape check, not a full date validator. Wrote failing regression test first (zzzz case), confirmed it failed against pre-fix HEAD (AssertionError: expected warn called 1 times, got 0), then fixed. Corrected two masking tests: '0000-00-00' test comment no longer claims the filter is expected to hide garbage; 'not a date' test now asserts warn called once. Added a comprehensive shape-classification test enumerating all shapes above. grepped docs/ and CLAUDE.md for other statements of this created_at/parse semantics -- none found outside src/host-sweep.ts itself and its own test file; docs/db-central.md (referenced by this task) only documents schema/FK shape, no GC semantics to reconcile. Verification: pnpm exec vitest run src/host-sweep.test.ts -> 37/37 passed; pnpm test -> 420/420 passed across 34 files; pnpm exec tsc --noEmit -> clean, exit 0.
<!-- SECTION:NOTES:END -->
