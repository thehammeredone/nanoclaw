/**
 * Host sweep — periodic maintenance of all session DBs.
 *
 * Two-DB architecture:
 *   - Reads processing_ack + container_state from outbound.db
 *   - Writes to inbound.db (host-owned) for status updates + recurrence
 *   - Uses heartbeat file mtime for liveness (never polls DB for it)
 *   - Never writes to outbound.db — preserves single-writer-per-file invariant
 *
 * Stuck / idle detection (replaces the old IDLE_TIMEOUT setTimeout + 10-min
 * heartbeat threshold):
 *
 *   If the container isn't running and there are 'processing' rows left over
 *   (e.g. it crashed mid-turn) → reset them to pending with backoff +
 *   tries++. Existing retry machinery does the rest.
 *
 *   If the container IS running:
 *     1. Absolute ceiling: heartbeat age > max(30 min, current_bash_timeout)
 *        → kill. Covers the "alive but silent for 30 min" case. Extended
 *        only while Bash is declared as running longer, honouring the
 *        user's own timeout directive. Kill then resets processing rows.
 *
 *     2. Message-scoped stuck: for each 'processing' row, tolerance =
 *        max(60s, current_bash_timeout_ms_if_Bash_running). If
 *        (claim_age > tolerance) AND (heartbeat_mtime <= status_changed)
 *        → kill + reset this message + tries++. Semantics: "container
 *        claimed a message and went quiet past tolerance since the claim."
 *
 * Also runs a once-per-tick GC over the central DB's four `pending_*` tables
 * (approval / question cards that were never answered). See the
 * `PENDING_TTL_MS` comment block below for why they need one.
 */
import type Database from 'better-sqlite3';
import fs from 'fs';

import { getActiveSessions } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import {
  countDueMessages,
  deleteOrphanProcessingClaims,
  getContainerState,
  getMessageForRetry,
  getProcessingClaims,
  markMessageFailed,
  retryWithBackoff,
  syncProcessingAcks,
  type ContainerState,
} from './db/session-db.js';
import { log } from './log.js';
import { openInboundDb, openOutboundDb, openOutboundDbRw, inboundDbPath, heartbeatPath } from './session-manager.js';
import { isContainerRunning, killContainer, wakeContainer } from './container-runner.js';
import type { Session } from './types.js';

/**
 * SQLite TIMESTAMP columns store UTC without a timezone marker. Date.parse
 * treats timezoneless ISO strings as local time, so on non-UTC hosts every
 * timestamp looks (TZ offset) hours stale — leading to spurious kill-claim
 * decisions on freshly-claimed messages. Append "Z" when no zone marker is
 * present so Date.parse interprets the string as UTC.
 */
export function parseSqliteUtc(s: string): number {
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z');
}

const SWEEP_INTERVAL_MS = 60_000;
// Absolute idle ceiling for a running container. If the heartbeat file hasn't
// been touched in this long, the container is either stuck or doing genuinely
// nothing — kill and restart on the next inbound.
export const ABSOLUTE_CEILING_MS = 30 * 60 * 1000;
// Stuck tolerance window applied per 'processing' claim — "did we see any
// signs of life since this message was claimed?"
export const CLAIM_STUCK_MS = 60 * 1000;
const MAX_TRIES = 5;
const BACKOFF_BASE_MS = 5000;

export type StuckDecision =
  | { action: 'ok' }
  | { action: 'kill-ceiling'; heartbeatAgeMs: number; ceilingMs: number }
  | { action: 'kill-claim'; messageId: string; claimAgeMs: number; toleranceMs: number };

/**
 * Pure decision for whether a running container should be killed this sweep
 * tick. Inputs are all deterministic; filesystem + DB reads happen in the
 * caller.
 */
export function decideStuckAction(args: {
  now: number;
  heartbeatMtimeMs: number; // 0 when heartbeat file absent
  containerState: ContainerState | null;
  claims: Array<{ message_id: string; status_changed: string }>;
}): StuckDecision {
  const { now, heartbeatMtimeMs, containerState, claims } = args;
  const declaredBashMs = bashTimeoutMs(containerState);

  // Ceiling check only applies when we have an actual heartbeat timestamp.
  // A freshly-spawned container hasn't had any SDK activity yet so no
  // heartbeat file exists — if we treated that as infinitely stale we'd
  // kill every container within seconds of spawn. Genuinely-dead containers
  // that never wrote a heartbeat are caught by the separate "container
  // process not running" cleanup path, not here. If a fresh container is
  // hanging at the gate (claimed a message but never did anything) the
  // claim-stuck check below handles it.
  if (heartbeatMtimeMs !== 0) {
    const heartbeatAge = now - heartbeatMtimeMs;
    const ceiling = Math.max(ABSOLUTE_CEILING_MS, declaredBashMs ?? 0);
    if (heartbeatAge > ceiling) {
      return { action: 'kill-ceiling', heartbeatAgeMs: heartbeatAge, ceilingMs: ceiling };
    }
  }

  const tolerance = Math.max(CLAIM_STUCK_MS, declaredBashMs ?? 0);
  for (const claim of claims) {
    const claimedAt = parseSqliteUtc(claim.status_changed);
    if (Number.isNaN(claimedAt)) continue;
    const claimAge = now - claimedAt;
    if (claimAge <= tolerance) continue;
    if (heartbeatMtimeMs > claimedAt) continue;
    return { action: 'kill-claim', messageId: claim.message_id, claimAgeMs: claimAge, toleranceMs: tolerance };
  }

  return { action: 'ok' };
}

// ── Pending-approval GC ─────────────────────────────────────────────────────
//
// Approval cards are fully DB-backed and never expire on their own. The
// button's platform payload is `ncq:<questionId>:<optionIndex>` and the
// option list is re-read from the row's `options_json` on click
// (src/db/sessions.ts:200 getAskQuestionRender), so a card stays clickable
// for as long as the row exists — across host restarts, indefinitely. Three
// concrete failures follow from that:
//
//   1. A card renders a roster (e.g. "connect this channel to <agent>") that
//      goes stale. Selecting a deleted agent group is guarded
//      (src/modules/permissions/index.ts:432) but selecting a *surviving* one
//      replays a weeks-old stored message as if it just arrived.
//   2. `pending_channel_approvals` (PK messaging_group_id) and
//      `pending_sender_approvals` (UNIQUE messaging_group_id, sender_identity)
//      double as in-flight dedup keys. A row that is never resolved silently
//      suppresses every future approval card for that channel/sender.
//   3. All four tables hold `NO ACTION` foreign keys (to agent_groups and/or
//      sessions), so a forgotten row blocks agent-group and session deletion
//      — see docs/runbooks/agent-group-teardown.md.
//
// TTL: 7 days. The window has to cover a human who is away for a long weekend
// or a short holiday and comes back to an unanswered card, while staying well
// inside the horizon over which the roster the card was rendered against can
// change. The row that motivated this was 3 weeks old.
//
// No schema change: `pending_channel_approvals`, `pending_sender_approvals`
// and `pending_questions` have no `expires_at` column, and adding one would
// put the policy on every insert path instead of in one place here. Rows are
// aged off `created_at` (NOT NULL on all four tables). Where an explicit
// `expires_at` does exist — `pending_approvals`, populated from the OneCLI
// gateway's own deadline (src/modules/approvals/onecli-approvals.ts:192) — it
// wins in both directions: an earlier deadline expires the row early, a later
// one holds it past the blanket TTL.
export const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface PendingTableSpec {
  table: string;
  /** Primary-key column, used to delete and to name rows in the log. */
  idColumn: string;
  /** Whether the table carries an explicit per-row deadline. */
  hasExpiresAt?: boolean;
}

// `pending_questions` is included deliberately. It is the odd one out — it
// references sessions(id) and has no agent_group_id, so it is invisible to
// every group-scoped sweep and is exactly the row that blocks a session
// delete during teardown. Nothing references pending_questions in turn, so
// aging it off is safe; the only effect is that a click on a long-dead
// question card becomes an "Unclaimed response" warn instead of waking a
// session that has moved on.
const PENDING_TABLES: PendingTableSpec[] = [
  { table: 'pending_approvals', idColumn: 'approval_id', hasExpiresAt: true },
  { table: 'pending_questions', idColumn: 'question_id' },
  { table: 'pending_sender_approvals', idColumn: 'id' },
  { table: 'pending_channel_approvals', idColumn: 'messaging_group_id' },
];

/**
 * Delete pending approval/question rows that have outlived their usefulness.
 * Returns the per-table count of deleted rows (tables with nothing to delete
 * are omitted) so callers and tests can assert on what happened.
 */
export function sweepExpiredPending(db: Database.Database, now: number = Date.now()): Record<string, number> {
  const cutoff = now - PENDING_TTL_MS;
  const deleted: Record<string, number> = {};

  for (const spec of PENDING_TABLES) {
    if (!hasTable(db, spec.table)) continue;

    const cols = spec.hasExpiresAt
      ? `${spec.idColumn} AS id, created_at, expires_at`
      : `${spec.idColumn} AS id, created_at, NULL AS expires_at`;
    const rows = db.prepare(`SELECT ${cols} FROM ${spec.table}`).all() as Array<{
      id: string;
      created_at: string;
      expires_at: string | null;
    }>;

    const expired: string[] = [];
    for (const row of rows) {
      const explicit = row.expires_at ? parseSqliteUtc(row.expires_at) : NaN;
      if (!Number.isNaN(explicit)) {
        // An explicit deadline is authoritative — never overridden by the TTL.
        if (explicit < now) expired.push(row.id);
        continue;
      }
      const createdAt = parseSqliteUtc(row.created_at);
      // An unparseable created_at is left alone rather than guessed at; a
      // wrong delete here is unrecoverable, a retained row is only clutter.
      if (Number.isNaN(createdAt)) {
        log.warn('Pending GC: unparseable created_at, row retained', {
          table: spec.table,
          id: row.id,
          createdAt: row.created_at,
        });
        continue;
      }
      if (createdAt < cutoff) expired.push(row.id);
    }

    if (expired.length === 0) continue;

    const stmt = db.prepare(`DELETE FROM ${spec.table} WHERE ${spec.idColumn} = ?`);
    for (const id of expired) stmt.run(id);
    deleted[spec.table] = expired.length;
    log.info('Expired stale pending rows', {
      table: spec.table,
      count: expired.length,
      ids: expired,
      ttlMs: PENDING_TTL_MS,
    });
  }

  return deleted;
}

let running = false;

export function startHostSweep(): void {
  if (running) return;
  running = true;
  sweep();
}

export function stopHostSweep(): void {
  running = false;
}

async function sweep(): Promise<void> {
  if (!running) return;

  // Central-DB GC runs once per tick, not per session — these tables live in
  // data/v2.db. Isolated in its own try so a GC failure can't skip the
  // per-session maintenance below.
  try {
    sweepExpiredPending(getDb());
  } catch (err) {
    log.error('Pending GC error', { err });
  }

  try {
    const sessions = getActiveSessions();
    for (const session of sessions) {
      await sweepSession(session);
    }
  } catch (err) {
    log.error('Host sweep error', { err });
  }

  setTimeout(sweep, SWEEP_INTERVAL_MS);
}

async function sweepSession(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  const inPath = inboundDbPath(agentGroup.id, session.id);
  if (!fs.existsSync(inPath)) return;

  let inDb: Database.Database;
  let outDb: Database.Database | null = null;
  try {
    inDb = openInboundDb(agentGroup.id, session.id);
  } catch {
    return;
  }

  try {
    outDb = openOutboundDb(agentGroup.id, session.id);
  } catch {
    // outbound.db might not exist yet (container hasn't started)
  }

  try {
    // 1. Sync processing_ack → messages_in status
    if (outDb) {
      syncProcessingAcks(inDb, outDb);
    }

    // 2. Wake a container if work is due and nothing is running. Ordered
    // before the crashed-container cleanup so a fresh container gets a chance
    // to clean its own orphan processing_ack rows on startup (see
    // container/agent-runner/src/db/connection.ts). Otherwise the reset path
    // would keep bumping process_after into the future, dueCount would stay 0,
    // and the wake would never fire.
    const dueCount = countDueMessages(inDb);
    if (dueCount > 0 && !isContainerRunning(session.id)) {
      log.info('Waking container for due messages', { sessionId: session.id, count: dueCount });
      // wakeContainer never throws — transient spawn failures (OneCLI down,
      // etc.) return false and leave messages pending for the next tick.
      await wakeContainer(session);
    }

    const alive = isContainerRunning(session.id);

    // 3. Running-container SLA: absolute ceiling + per-claim stuck rules.
    if (alive && outDb) {
      enforceRunningContainerSla(inDb, outDb, session, agentGroup.id);
    }

    // 4. Crashed-container cleanup: processing rows left behind get retried.
    // Only fires when wake in step 2 didn't pick up the work (no due messages,
    // or wake failed). resetStuckProcessingRows itself is idempotent — it
    // skips messages already scheduled for a future retry.
    if (!alive && outDb) {
      resetStuckProcessingRows(inDb, outDb, session, 'container not running');
    }

    // 5. Recurrence fanout for completed recurring tasks.
    // MODULE-HOOK:scheduling-recurrence:start
    const { handleRecurrence } = await import('./modules/scheduling/recurrence.js');
    await handleRecurrence(inDb, session);
    // MODULE-HOOK:scheduling-recurrence:end
  } finally {
    inDb.close();
    outDb?.close();
  }
}

function heartbeatMtimeMs(agentGroupId: string, sessionId: string): number {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    return fs.statSync(hbPath).mtimeMs;
  } catch {
    return 0;
  }
}

function bashTimeoutMs(state: ContainerState | null): number | null {
  if (!state || state.current_tool !== 'Bash') return null;
  return typeof state.tool_declared_timeout_ms === 'number' ? state.tool_declared_timeout_ms : null;
}

function enforceRunningContainerSla(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  agentGroupId: string,
): void {
  const decision = decideStuckAction({
    now: Date.now(),
    heartbeatMtimeMs: heartbeatMtimeMs(agentGroupId, session.id),
    containerState: getContainerState(outDb),
    claims: getProcessingClaims(outDb),
  });

  if (decision.action === 'ok') return;

  if (decision.action === 'kill-ceiling') {
    log.warn('Killing container past absolute ceiling', {
      sessionId: session.id,
      heartbeatAgeMs: decision.heartbeatAgeMs,
      ceilingMs: decision.ceilingMs,
    });
    killContainer(session.id, 'absolute-ceiling');
    resetStuckProcessingRows(inDb, outDb, session, 'absolute-ceiling');
    return;
  }

  log.warn('Killing container — message claimed then silent', {
    sessionId: session.id,
    messageId: decision.messageId,
    claimAgeMs: decision.claimAgeMs,
    toleranceMs: decision.toleranceMs,
  });
  killContainer(session.id, 'claim-stuck');
  resetStuckProcessingRows(inDb, outDb, session, 'claim-stuck');
}

export function _resetStuckProcessingRowsForTesting(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  reason: string,
): void {
  resetStuckProcessingRows(inDb, outDb, session, reason, outDb);
}

function resetStuckProcessingRows(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  reason: string,
  writableOutDb?: Database.Database,
): void {
  const claims = getProcessingClaims(outDb);
  const now = Date.now();
  for (const { message_id } of claims) {
    const msg = getMessageForRetry(inDb, message_id, 'pending');
    if (!msg) continue;

    // Already rescheduled for a future retry — don't bump tries again. The
    // wake path (sweep step 2) will fire when process_after elapses and a
    // fresh container will clean the orphan claim on startup.
    if (msg.processAfter && parseSqliteUtc(msg.processAfter) > now) continue;

    if (msg.tries >= MAX_TRIES) {
      markMessageFailed(inDb, msg.id);
      log.warn('Message marked as failed after max retries', {
        messageId: msg.id,
        sessionId: session.id,
        reason,
      });
    } else {
      const backoffMs = BACKOFF_BASE_MS * Math.pow(2, msg.tries);
      const backoffSec = Math.floor(backoffMs / 1000);
      retryWithBackoff(inDb, msg.id, backoffSec);
      log.info('Reset stale message with backoff', {
        messageId: msg.id,
        tries: msg.tries,
        backoffMs,
        reason,
      });
    }
  }

  // Drop the orphan 'processing' rows. Without this, the next sweep tick
  // would re-read them, see the old status_changed timestamp, conclude the
  // freshly respawned container is stuck, and SIGKILL it before its
  // agent-runner has a chance to run clearStaleProcessingAcks() on startup.
  const ownsDb = !writableOutDb;
  let useDb: Database.Database | null = writableOutDb ?? null;
  try {
    if (!useDb) useDb = openOutboundDbRw(session.agent_group_id, session.id);
    const cleared = deleteOrphanProcessingClaims(useDb);
    if (cleared > 0) {
      log.info('Cleared orphan processing claims', { sessionId: session.id, cleared, reason });
    }
  } catch (err) {
    log.warn('Failed to clear orphan processing claims', { sessionId: session.id, err });
  } finally {
    if (ownsDb) useDb?.close();
  }
}
