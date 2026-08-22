/**
 * Unit tests for the stuck-container decision logic introduced by
 * ACTION-ITEMS item 9. Lives on the pure helper `decideStuckAction` so we
 * don't have to mock the filesystem or the container runner.
 */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { deleteOrphanProcessingClaims, getProcessingClaims } from './db/session-db.js';
import {
  ABSOLUTE_CEILING_MS,
  CLAIM_STUCK_MS,
  PENDING_TTL_MS,
  _resetStuckProcessingRowsForTesting,
  decideStuckAction,
  parseSqliteUtc,
  sweepExpiredPending,
} from './host-sweep.js';
import type { Session } from './types.js';

const BASE = Date.parse('2026-04-20T12:00:00.000Z');

function claim(id: string, offsetMs: number) {
  return { message_id: id, status_changed: new Date(BASE - offsetMs).toISOString() };
}

describe('decideStuckAction', () => {
  it('returns ok when heartbeat is fresh and no claims', () => {
    expect(
      decideStuckAction({
        now: BASE,
        heartbeatMtimeMs: BASE - 5_000,
        containerState: null,
        claims: [],
      }),
    ).toEqual({ action: 'ok' });
  });

  it('returns kill-ceiling when heartbeat older than 30 min', () => {
    const heartbeatMtimeMs = BASE - ABSOLUTE_CEILING_MS - 1_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs,
      containerState: null,
      claims: [],
    });
    expect(res.action).toBe('kill-ceiling');
    if (res.action !== 'kill-ceiling') return;
    expect(res.ceilingMs).toBe(ABSOLUTE_CEILING_MS);
    expect(res.heartbeatAgeMs).toBeGreaterThan(ABSOLUTE_CEILING_MS);
  });

  it('skips the ceiling check when no heartbeat file exists (fresh container not yet ticked)', () => {
    // A freshly-spawned container hasn't produced any SDK events yet, so no
    // heartbeat. Prior behavior treated this as infinitely stale and killed
    // every container within seconds of spawn. With no claims either, we
    // should conclude everything is fine.
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0,
      containerState: null,
      claims: [],
    });
    expect(res.action).toBe('ok');
  });

  it('kills on claim-stuck when heartbeat is absent AND a claim has aged past tolerance', () => {
    // Hanging fresh container: spawned, picked up a message (claim recorded
    // in processing_ack), but never wrote a heartbeat. Falls through the
    // skipped ceiling check into claim-stuck — which correctly fires.
    const claimedAgeMs = CLAIM_STUCK_MS + 5_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0,
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('kill-claim');
  });

  it('extends the ceiling when Bash has a declared timeout longer than 30 min', () => {
    const twoHrMs = 2 * 60 * 60 * 1000;
    const res = decideStuckAction({
      now: BASE,
      // 45 min — over the default ceiling, but under the Bash timeout
      heartbeatMtimeMs: BASE - 45 * 60 * 1000,
      containerState: {
        current_tool: 'Bash',
        tool_declared_timeout_ms: twoHrMs,
        tool_started_at: new Date(BASE - 45 * 60 * 1000).toISOString(),
      },
      claims: [],
    });
    expect(res.action).toBe('ok');
  });

  it('returns kill-claim when a claim is past 60s and heartbeat has not moved', () => {
    const claimedAgeMs = CLAIM_STUCK_MS + 10_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - claimedAgeMs - 5_000, // older than the claim
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('kill-claim');
    if (res.action !== 'kill-claim') return;
    expect(res.messageId).toBe('msg-1');
    expect(res.toleranceMs).toBe(CLAIM_STUCK_MS);
  });

  it('does not kill when heartbeat has been touched since the claim', () => {
    const claimedAgeMs = CLAIM_STUCK_MS + 10_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 2_000, // fresh, updated after the claim
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('ok');
  });

  it('does not kill when claim age is below tolerance', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - CLAIM_STUCK_MS - 10_000, // old, but claim is recent
      containerState: null,
      claims: [claim('msg-1', 5_000)],
    });
    expect(res.action).toBe('ok');
  });

  it('widens per-claim tolerance for a running Bash with long timeout', () => {
    const tenMinMs = 10 * 60 * 1000;
    const res = decideStuckAction({
      now: BASE,
      // 5 min since claim, over the 60s default but under the declared Bash timeout
      heartbeatMtimeMs: BASE - 5 * 60 * 1000 - 5_000,
      containerState: {
        current_tool: 'Bash',
        tool_declared_timeout_ms: tenMinMs,
        tool_started_at: new Date(BASE - 5 * 60 * 1000).toISOString(),
      },
      claims: [claim('msg-1', 5 * 60 * 1000)],
    });
    expect(res.action).toBe('ok');
  });

  it('ignores claims with unparseable timestamps', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 5_000,
      containerState: null,
      claims: [{ message_id: 'x', status_changed: 'not-a-date' }],
    });
    expect(res.action).toBe('ok');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Orphan claim cleanup (regression test for the SIGKILL → claim-stuck loop)
//
// Repro of the production bug seen 2026-04-30: container A claimed message M
// (writes processing_ack row with status='processing'). Host kills A by
// absolute-ceiling. Old behavior: messages_in.M was reset to pending but
// processing_ack.M survived. On the next sweep tick, wakeContainer spawned B,
// the same-tick SLA check saw M's stale claim age (hours), and SIGKILL'd B
// before agent-runner could run clearStaleProcessingAcks(). Loop. The fix
// deletes processing_ack 'processing' rows when the host kills/cleans the
// container, breaking the loop atomically.
// ─────────────────────────────────────────────────────────────────────────────

function makeSessionDbs(): { inDb: Database.Database; outDb: Database.Database } {
  const inDb = new Database(':memory:');
  inDb.exec(`
    CREATE TABLE messages_in (
      id            TEXT PRIMARY KEY,
      seq           INTEGER UNIQUE,
      kind          TEXT NOT NULL,
      timestamp     TEXT NOT NULL,
      status        TEXT DEFAULT 'pending',
      process_after TEXT,
      recurrence    TEXT,
      series_id     TEXT,
      tries         INTEGER DEFAULT 0,
      trigger       INTEGER NOT NULL DEFAULT 1,
      platform_id   TEXT,
      channel_type  TEXT,
      thread_id     TEXT,
      content       TEXT NOT NULL
    );
  `);
  const outDb = new Database(':memory:');
  outDb.exec(`
    CREATE TABLE processing_ack (
      message_id     TEXT PRIMARY KEY,
      status         TEXT NOT NULL,
      status_changed TEXT NOT NULL
    );
  `);
  return { inDb, outDb };
}

function fakeSession(): Session {
  return {
    id: 'sess-test',
    agent_group_id: 'ag-test',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

describe('deleteOrphanProcessingClaims', () => {
  it('removes only processing rows, leaves completed/failed alone', () => {
    const { outDb } = makeSessionDbs();
    const ts = new Date().toISOString();
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-proc', 'processing', ?)").run(ts);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-done', 'completed', ?)").run(ts);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-fail', 'failed', ?)").run(ts);

    const removed = deleteOrphanProcessingClaims(outDb);

    expect(removed).toBe(1);
    const remaining = outDb.prepare('SELECT message_id, status FROM processing_ack ORDER BY message_id').all();
    expect(remaining).toEqual([
      { message_id: 'm-done', status: 'completed' },
      { message_id: 'm-fail', status: 'failed' },
    ]);
  });

  it('returns 0 when nothing to clear', () => {
    const { outDb } = makeSessionDbs();
    expect(deleteOrphanProcessingClaims(outDb)).toBe(0);
  });
});

describe('resetStuckProcessingRows — orphan claim cleanup', () => {
  it('deletes orphan processing_ack rows so next sweep tick does not see them', () => {
    const { inDb, outDb } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago

    // messages_in.status stays 'pending' during processing — only the
    // container's processing_ack moves to 'processing'. See
    // src/db/schema.ts header comment on processing_ack.
    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES ('m-1', 1, 'chat', ?, 'pending', '{}')",
      )
      .run(claimedAt);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-1', 'processing', ?)").run(claimedAt);

    // Sanity: the orphan claim is what would trip claim-stuck.
    expect(getProcessingClaims(outDb)).toHaveLength(1);

    _resetStuckProcessingRowsForTesting(inDb, outDb, fakeSession(), 'absolute-ceiling');

    // Regression assertion: orphan claim is gone — next sweep tick will see
    // an empty claims list and not kill the freshly respawned container.
    expect(getProcessingClaims(outDb)).toEqual([]);

    // And the message itself was rescheduled with backoff (existing behavior).
    const row = inDb.prepare('SELECT status, tries, process_after FROM messages_in WHERE id = ?').get('m-1') as {
      status: string;
      tries: number;
      process_after: string | null;
    };
    expect(row.status).toBe('pending');
    expect(row.tries).toBe(1);
    expect(row.process_after).not.toBeNull();
  });

  it('still clears orphan claims even when the inbound message has already been retried (skip path)', () => {
    // Edge case: the inbound row was already rescheduled (process_after in
    // future), so the per-message retry loop skips it. The orphan in
    // processing_ack must still be removed — otherwise the bug remains.
    const { inDb, outDb } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();

    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, tries, content) VALUES ('m-2', 2, 'chat', ?, 'pending', ?, 1, '{}')",
      )
      .run(claimedAt, future);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-2', 'processing', ?)").run(claimedAt);

    _resetStuckProcessingRowsForTesting(inDb, outDb, fakeSession(), 'claim-stuck');

    expect(getProcessingClaims(outDb)).toEqual([]);
    const row = inDb.prepare('SELECT tries FROM messages_in WHERE id = ?').get('m-2') as { tries: number };
    expect(row.tries).toBe(1); // not bumped, the skip path held
  });
});

describe('sweepExpiredPending', () => {
  // Real schema from the real migration chain against a temp DB — the FK
  // graph (pending_* → agent_groups / messaging_groups / sessions) is the
  // thing under test as much as the TTL arithmetic is.
  const NOW = Date.parse('2026-08-22T12:00:00.000Z');
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  const ahead = (ms: number) => new Date(NOW + ms).toISOString();
  const DAY = 24 * 60 * 60 * 1000;

  function freshDb(): Database.Database {
    const db = initTestDb();
    runMigrations(db);
    db.prepare("INSERT INTO agent_groups VALUES ('ag-1', 'Agent One', 'agent-one', NULL, ?)").run(ago(90 * DAY));
    db.prepare(
      "INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at) VALUES ('mg-1', 'matrix', '!room:example.org', 'Room', 0, 'strict', ?)",
    ).run(ago(90 * DAY));
    db.prepare(
      "INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at) VALUES ('sess-1', 'ag-1', 'mg-1', NULL, NULL, 'active', 'stopped', ?, ?)",
    ).run(ago(90 * DAY), ago(90 * DAY));
    return db;
  }

  function insertChannelApproval(db: Database.Database, createdAt: string): void {
    db.prepare(
      `INSERT INTO pending_channel_approvals
         (messaging_group_id, agent_group_id, original_message, approver_user_id, created_at, title, options_json)
       VALUES ('mg-1', 'ag-1', '{}', 'matrix:@hammer:example.org', ?, 'Card', '[]')`,
    ).run(createdAt);
  }

  function insertSenderApproval(db: Database.Database, id: string, createdAt: string): void {
    db.prepare(
      `INSERT INTO pending_sender_approvals
         (id, messaging_group_id, agent_group_id, sender_identity, sender_name, original_message,
          approver_user_id, created_at, title, options_json)
       VALUES (?, 'mg-1', 'ag-1', ?, 'Someone', '{}', 'matrix:@hammer:example.org', ?, 'Card', '[]')`,
    ).run(id, `matrix:@${id}:example.org`, createdAt);
  }

  function insertQuestion(db: Database.Database, id: string, createdAt: string): void {
    db.prepare(
      `INSERT INTO pending_questions
         (question_id, session_id, message_out_id, platform_id, channel_type, thread_id, title, options_json, created_at)
       VALUES (?, 'sess-1', 'mo-1', '!room:example.org', 'matrix', NULL, 'Q', '[]', ?)`,
    ).run(id, createdAt);
  }

  function insertApproval(db: Database.Database, id: string, createdAt: string, expiresAt: string | null): void {
    db.prepare(
      `INSERT INTO pending_approvals
         (approval_id, session_id, request_id, action, payload, created_at, agent_group_id,
          channel_type, platform_id, platform_message_id, expires_at, status, title, options_json)
       VALUES (?, 'sess-1', 'req-1', 'install_packages', '{}', ?, 'ag-1', 'matrix',
               '!room:example.org', NULL, ?, 'pending', 'Card', '[]')`,
    ).run(id, createdAt, expiresAt);
  }

  const count = (db: Database.Database, table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

  afterEach(() => {
    closeDb();
  });

  it('deletes rows older than the TTL across all four pending_* tables', () => {
    const db = freshDb();
    const stale = ago(PENDING_TTL_MS + DAY);
    insertChannelApproval(db, stale);
    insertSenderApproval(db, 'psa-old', stale);
    insertQuestion(db, 'pq-old', stale);
    insertApproval(db, 'pa-old', stale, null);

    const deleted = sweepExpiredPending(db, NOW);

    expect(deleted).toEqual({
      pending_approvals: 1,
      pending_questions: 1,
      pending_sender_approvals: 1,
      pending_channel_approvals: 1,
    });
    expect(count(db, 'pending_channel_approvals')).toBe(0);
    expect(count(db, 'pending_sender_approvals')).toBe(0);
    expect(count(db, 'pending_questions')).toBe(0);
    expect(count(db, 'pending_approvals')).toBe(0);
  });

  it('leaves rows inside the TTL alone', () => {
    const db = freshDb();
    const fresh = ago(PENDING_TTL_MS - DAY);
    insertChannelApproval(db, fresh);
    insertSenderApproval(db, 'psa-new', fresh);
    insertQuestion(db, 'pq-new', fresh);
    insertApproval(db, 'pa-new', fresh, null);

    expect(sweepExpiredPending(db, NOW)).toEqual({});
    expect(count(db, 'pending_channel_approvals')).toBe(1);
    expect(count(db, 'pending_sender_approvals')).toBe(1);
    expect(count(db, 'pending_questions')).toBe(1);
    expect(count(db, 'pending_approvals')).toBe(1);
  });

  it('is a no-op on empty tables (the current live state)', () => {
    const db = freshDb();
    expect(sweepExpiredPending(db, NOW)).toEqual({});
  });

  it('honours an explicit expires_at that fires before the TTL', () => {
    // pending_approvals rows from the OneCLI gateway carry the gateway's own
    // deadline. A young row with a past deadline must go.
    const db = freshDb();
    insertApproval(db, 'pa-expired', ago(DAY), ago(60 * 60 * 1000));

    expect(sweepExpiredPending(db, NOW)).toEqual({ pending_approvals: 1 });
    expect(count(db, 'pending_approvals')).toBe(0);
  });

  it('honours an explicit expires_at that extends past the TTL', () => {
    // The blanket TTL must not override a deadline someone set deliberately.
    const db = freshDb();
    insertApproval(db, 'pa-long', ago(PENDING_TTL_MS + 5 * DAY), ahead(DAY));

    expect(sweepExpiredPending(db, NOW)).toEqual({});
    expect(count(db, 'pending_approvals')).toBe(1);
  });

  it('retains rows whose created_at cannot be parsed rather than guessing', () => {
    const db = freshDb();
    insertChannelApproval(db, 'not a date');

    expect(sweepExpiredPending(db, NOW)).toEqual({});
    expect(count(db, 'pending_channel_approvals')).toBe(1);
  });

  it('treats a timezone-less created_at as UTC (no TZ-dependent early delete)', () => {
    // Same trap parseSqliteUtc exists for: a bare SQLite timestamp exactly one
    // hour inside the TTL must survive on hosts east or west of UTC.
    const db = freshDb();
    insertChannelApproval(db, new Date(NOW - PENDING_TTL_MS + 60 * 60 * 1000).toISOString().replace('Z', ''));

    expect(sweepExpiredPending(db, NOW)).toEqual({});
    expect(count(db, 'pending_channel_approvals')).toBe(1);
  });

  it('clears the dedup key so a new approval card can be raised for the channel', () => {
    // The real-world failure: pending_channel_approvals PK is the messaging
    // group id, so an unresolved row suppresses every future card for that
    // channel (channel-approval.ts hasInFlightChannelApproval). After GC the
    // insert must succeed again.
    const db = freshDb();
    insertChannelApproval(db, ago(PENDING_TTL_MS + DAY));
    expect(() => insertChannelApproval(db, ago(DAY))).toThrow(); // PK collision while stale row lives

    sweepExpiredPending(db, NOW);

    expect(() => insertChannelApproval(db, ago(DAY))).not.toThrow();
    expect(count(db, 'pending_channel_approvals')).toBe(1);
  });

  it('unblocks the NO ACTION foreign keys that stall teardown', () => {
    // pending_* rows reference agent_groups / sessions with no ON DELETE
    // clause, so a forgotten row makes `ncl groups delete` fail. GC must
    // remove that blocker.
    const db = freshDb();
    const stale = ago(PENDING_TTL_MS + DAY);
    insertQuestion(db, 'pq-block', stale);
    insertApproval(db, 'pa-block', stale, null);
    expect(() => db.prepare("DELETE FROM sessions WHERE id = 'sess-1'").run()).toThrow();

    sweepExpiredPending(db, NOW);

    expect(() => db.prepare("DELETE FROM sessions WHERE id = 'sess-1'").run()).not.toThrow();
  });

  it('skips tables that do not exist in this install', () => {
    // pending_sender_approvals / pending_channel_approvals arrive via later
    // migrations; core code guards every read of them with hasTable.
    const db = initTestDb();
    runMigrations(db);
    db.exec('DROP TABLE pending_channel_approvals');
    expect(() => sweepExpiredPending(db, NOW)).not.toThrow();
  });
});

describe('parseSqliteUtc', () => {
  // Regression: SQLite TIMESTAMP strings have no zone marker, but Date.parse
  // treats those as local time. On non-UTC hosts this made every claim look
  // (TZ offset) hours stale and tripped kill-claim on freshly-claimed messages.
  // The helper appends "Z" only when no marker is present, so parsing is
  // always anchored to UTC regardless of host timezone.

  const utcMs = Date.parse('2026-04-20T12:00:00.000Z');

  it('treats a SQLite-style timestamp (no zone) as UTC', () => {
    expect(parseSqliteUtc('2026-04-20 12:00:00')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T12:00:00')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T12:00:00.000')).toBe(utcMs);
  });

  it('preserves an explicit Z marker', () => {
    expect(parseSqliteUtc('2026-04-20T12:00:00.000Z')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T12:00:00z')).toBe(utcMs);
  });

  it('preserves an explicit numeric offset', () => {
    // 14:00+02:00 == 12:00 UTC
    expect(parseSqliteUtc('2026-04-20T14:00:00+02:00')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T14:00:00+0200')).toBe(utcMs);
    // 07:00-05:00 == 12:00 UTC
    expect(parseSqliteUtc('2026-04-20T07:00:00-05:00')).toBe(utcMs);
  });

  it('returns NaN for unparseable input', () => {
    expect(Number.isNaN(parseSqliteUtc('not a date'))).toBe(true);
  });

  it('does not drift across host timezones for SQLite-style input', () => {
    // The helper itself is timezone-independent because it forces UTC parsing.
    // (Verifying the regex branch — without the helper, `Date.parse` of the
    // bare string returns different values depending on the host TZ.)
    const bare = '2026-04-20T12:00:00';
    expect(parseSqliteUtc(bare)).toBe(Date.parse(bare + 'Z'));
  });
});
