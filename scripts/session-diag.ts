#!/usr/bin/env node
/**
 * session-diag.ts — Diagnose session health from all DB layers.
 *
 * Usage:
 *   pnpm exec tsx scripts/session-diag.ts            # overview of all active sessions
 *   pnpm exec tsx scripts/session-diag.ts <sess-id>  # deep-dive on one session
 */
import Database from 'better-sqlite3';
import { existsSync, statSync } from 'fs';
import { join } from 'path';

const CENTRAL_DB = 'data/v2.db';
const SESSIONS_DIR = 'data/v2-sessions';

interface Session {
  id: string;
  agent_group_id: string;
  messaging_group_id: string | null;
  thread_id: string | null;
  status: string;
  container_status: string;
  last_active: string | null;
}

interface AgentGroup {
  id: string;
  name: string;
}

interface MessagingGroup {
  id: string;
  name: string;
  channel_type: string;
}

function ago(ts: string | null): string {
  if (!ts) return '—';
  const secs = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (secs < 0) return 'in future';
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function trunc(s: string | null | undefined, n: number): string {
  if (s == null) return '—';
  const clean = s.replace(/\s+/g, ' ');
  return clean.length > n ? clean.slice(0, n) + '…' : clean;
}

function col(s: string | number | null, width: number): string {
  const str = String(s ?? '—');
  return str.length >= width ? str.slice(0, width) : str.padEnd(width);
}

function openDb(path: string): Database.Database {
  return new Database(path, { readonly: true });
}

function sessionDir(agentGroupId: string, sessionId: string): string {
  return join(SESSIONS_DIR, agentGroupId, sessionId);
}

type DiagLevel = 'ok' | 'warn' | 'error';
interface DiagNote {
  level: DiagLevel;
  msg: string;
}

function diagnoseSession(sess: Session, dir: string): DiagNote[] {
  const notes: DiagNote[] = [];

  // Heartbeat
  const hbPath = join(dir, '.heartbeat');
  let heartbeatAgeSecs: number | null = null;
  if (existsSync(hbPath)) {
    heartbeatAgeSecs = Math.floor((Date.now() - statSync(hbPath).mtimeMs) / 1000);
  }

  // Inbound
  const inPath = join(dir, 'inbound.db');
  let pendingNonWake = 0;
  let onWakeCount = 0;
  let highTriesCount = 0;
  if (existsSync(inPath)) {
    const db = openDb(inPath);
    try {
      // Only count messages that are actually due — exclude on_wake=0 future-scheduled tasks
      pendingNonWake = (
        db.prepare(
          "SELECT count(*) as n FROM messages_in WHERE status='pending' AND on_wake=0 AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))",
        ).get() as any
      ).n;
      onWakeCount = (
        db.prepare("SELECT count(*) as n FROM messages_in WHERE status='pending' AND on_wake=1").get() as any
      ).n;
      highTriesCount = (db.prepare('SELECT count(*) as n FROM messages_in WHERE tries > 2').get() as any).n;
    } finally {
      db.close();
    }
  }

  // Outbound — processing_ack stuck
  const outPath = join(dir, 'outbound.db');
  let processingStuck = 0;
  let oldestStuck: string | null = null;
  if (existsSync(outPath)) {
    const db = openDb(outPath);
    try {
      processingStuck = (
        db.prepare("SELECT count(*) as n FROM processing_ack WHERE status='processing'").get() as any
      ).n;
      if (processingStuck > 0) {
        const row = db
          .prepare("SELECT status_changed FROM processing_ack WHERE status='processing' ORDER BY status_changed ASC LIMIT 1")
          .get() as any;
        oldestStuck = row?.status_changed ?? null;
      }
    } finally {
      db.close();
    }
  }

  const isRunning = sess.container_status === 'running';
  const lastActiveSecs = sess.last_active
    ? Math.floor((Date.now() - new Date(sess.last_active).getTime()) / 1000)
    : null;

  // Container liveness
  if (isRunning) {
    if (heartbeatAgeSecs !== null && heartbeatAgeSecs < 120) {
      notes.push({ level: 'ok', msg: `Container running, heartbeat ${heartbeatAgeSecs}s ago` });
    } else if (heartbeatAgeSecs !== null) {
      notes.push({
        level: 'warn',
        msg: `Container marked running but heartbeat is ${ago(new Date(Date.now() - heartbeatAgeSecs * 1000).toISOString())} old — may be stale/zombie`,
      });
    } else {
      notes.push({ level: 'warn', msg: 'Container marked running but no heartbeat file — may have crashed' });
    }
  } else {
    if (pendingNonWake > 0) {
      notes.push({
        level: 'warn',
        msg: `Container stopped with ${pendingNonWake} pending message(s) (not on_wake) — sweep should have woken it`,
      });
    } else if (onWakeCount > 0) {
      notes.push({ level: 'ok', msg: `Container stopped, ${onWakeCount} on_wake message(s) queued — will fire on next start` });
    } else {
      notes.push({ level: 'ok', msg: 'Container stopped, no pending messages' });
    }
  }

  // Retry storms
  if (highTriesCount > 0) {
    notes.push({
      level: 'error',
      msg: `${highTriesCount} inbound message(s) with >2 retries — container likely crashing on them`,
    });
  }

  // Stuck processing_ack: only warn if the container is running (stopped containers legitimately have processing rows)
  if (processingStuck > 0) {
    const oldAgeSecs = oldestStuck ? Math.floor((Date.now() - new Date(oldestStuck).getTime()) / 1000) : null;
    const threshold = isRunning ? 5 * 60 : 7 * 24 * 3600; // 5m if running, 7d if stopped
    if (oldAgeSecs !== null && oldAgeSecs > threshold) {
      notes.push({
        level: 'warn',
        msg: `${processingStuck} processing_ack row(s) stuck in 'processing' (oldest: ${ago(oldestStuck)}) — check nanoclaw.error.log for delivery failures`,
      });
    }
  }

  // Stale session
  if (lastActiveSecs !== null && lastActiveSecs > 7 * 86400) {
    notes.push({ level: 'warn', msg: `No activity in ${ago(sess.last_active)} — consider closing this session` });
  }

  return notes;
}

// ── Load central DB ───────────────────────────────────────────────────────────

const central = openDb(CENTRAL_DB);

const agentGroups = new Map<string, AgentGroup>(
  (central.prepare('SELECT id, name FROM agent_groups').all() as AgentGroup[]).map((g) => [g.id, g]),
);
const messagingGroups = new Map<string, MessagingGroup>(
  (central.prepare('SELECT id, name, channel_type FROM messaging_groups').all() as MessagingGroup[]).map((m) => [m.id, m]),
);

const [, , sessionArg] = process.argv;

// ── Overview mode ─────────────────────────────────────────────────────────────

if (!sessionArg) {
  const sessions = central
    .prepare("SELECT * FROM sessions WHERE status='active' ORDER BY last_active DESC")
    .all() as Session[];
  central.close();

  if (sessions.length === 0) {
    console.log('No active sessions.');
    process.exit(0);
  }

  const W = { sess: 30, agent: 20, channel: 24, ctr: 9, active: 10 };
  const hr = (n: number) => '─'.repeat(n);

  console.log(
    `${col('SESSION', W.sess)}  ${col('AGENT', W.agent)}  ${col('CHANNEL', W.channel)}  ${col('CONTAINER', W.ctr)}  ${col('LAST ACTIVE', W.active)}  DIAGNOSIS`,
  );
  console.log(
    `${hr(W.sess)}  ${hr(W.agent)}  ${hr(W.channel)}  ${hr(W.ctr)}  ${hr(W.active)}  ${'─'.repeat(55)}`,
  );

  for (const s of sessions) {
    const dir = sessionDir(s.agent_group_id, s.id);
    const notes = existsSync(dir) ? diagnoseSession(s, dir) : [{ level: 'error' as DiagLevel, msg: 'session directory missing' }];
    const worst = notes.find((n) => n.level === 'error') ? 'error' : notes.find((n) => n.level === 'warn') ? 'warn' : 'ok';
    const tag = worst === 'error' ? '[ERR] ' : worst === 'warn' ? '[WARN]' : '[OK]  ';
    const topNote = notes[0]?.msg ?? '—';

    const agName = agentGroups.get(s.agent_group_id)?.name ?? s.agent_group_id.slice(-12);
    const mg = messagingGroups.get(s.messaging_group_id ?? '');
    const mgLabel = mg ? `${mg.name} [${mg.channel_type}]` : (s.messaging_group_id?.slice(-12) ?? '—');

    console.log(
      `${col(s.id, W.sess)}  ${col(agName, W.agent)}  ${col(mgLabel, W.channel)}  ${col(s.container_status, W.ctr)}  ${col(ago(s.last_active), W.active)}  ${tag} ${topNote}`,
    );
  }

  process.exit(0);
}

// ── Deep-dive mode ────────────────────────────────────────────────────────────

const sess = central.prepare('SELECT * FROM sessions WHERE id=?').get(sessionArg) as Session | undefined;
central.close();

if (!sess) {
  console.error(`Session not found: ${sessionArg}`);
  process.exit(1);
}

const ag = agentGroups.get(sess.agent_group_id);
const mg = sess.messaging_group_id ? messagingGroups.get(sess.messaging_group_id) : null;
const dir = sessionDir(sess.agent_group_id, sess.id);

const BAR = '━'.repeat(74);
console.log(`\n${BAR}`);
console.log(`SESSION  ${sess.id}`);
console.log(BAR);
console.log(`Agent:       ${ag?.name ?? '—'} (${sess.agent_group_id})`);
if (mg) console.log(`Channel:     ${mg.name} [${mg.channel_type}] (${sess.messaging_group_id})`);
else if (sess.messaging_group_id) console.log(`Channel:     ${sess.messaging_group_id} (not found in DB)`);
else console.log(`Channel:     — (agent-shared)`);
if (sess.thread_id) console.log(`Thread:      ${sess.thread_id}`);
console.log(`Status:      ${sess.status} / container: ${sess.container_status}`);
console.log(`Last active: ${sess.last_active ?? '—'} (${ago(sess.last_active)})`);
console.log(`Directory:   ${dir}  ${existsSync(dir) ? '✓' : '✗ MISSING'}`);

if (!existsSync(dir)) {
  console.log('\n[ERROR] Session directory missing — DBs cannot be inspected.');
  process.exit(1);
}

// Heartbeat
const hbPath = join(dir, '.heartbeat');
console.log(`\n── HEARTBEAT ${'─'.repeat(61)}`);
if (existsSync(hbPath)) {
  const mtime = statSync(hbPath).mtime;
  const ageSecs = Math.floor((Date.now() - mtime.getTime()) / 1000);
  console.log(`  ${hbPath}`);
  console.log(`  ${mtime.toISOString().slice(0, 19)}  (${ageSecs}s ago)`);
} else {
  console.log(`  NOT FOUND  ${hbPath}`);
}

// Inbound
const inPath = join(dir, 'inbound.db');
console.log(`\n── INBOUND (messages_in) — last 8 ${'─'.repeat(40)}`);
if (existsSync(inPath)) {
  const db = openDb(inPath);
  try {
    type InRow = { seq: number; kind: string; status: string; tries: number; on_wake: number; timestamp: string; content: string };
    const rows = db
      .prepare(
        'SELECT seq, kind, status, tries, on_wake, timestamp, substr(content,1,90) as content FROM messages_in ORDER BY seq DESC LIMIT 8',
      )
      .all() as InRow[];
    if (rows.length === 0) {
      console.log('  (empty)');
    } else {
      console.log(`  ${col('seq', 5)}  ${col('kind', 10)}  ${col('status', 10)}  ${col('tries', 5)}  ${col('wake', 4)}  ${col('timestamp', 19)}  content`);
      console.log(`  ${'─'.repeat(5)}  ${'─'.repeat(10)}  ${'─'.repeat(10)}  ${'─'.repeat(5)}  ${'─'.repeat(4)}  ${'─'.repeat(19)}  ${'─'.repeat(30)}`);
      for (const r of rows) {
        console.log(
          `  ${col(r.seq, 5)}  ${col(r.kind, 10)}  ${col(r.status, 10)}  ${col(r.tries, 5)}  ${col(r.on_wake, 4)}  ${col((r.timestamp ?? '').slice(0, 19), 19)}  ${trunc(r.content, 60)}`,
        );
      }
    }
  } finally {
    db.close();
  }
} else {
  console.log('  inbound.db NOT FOUND');
}

// Outbound
const outPath = join(dir, 'outbound.db');
console.log(`\n── OUTBOUND (messages_out) — last 8 ${'─'.repeat(39)}`);
if (existsSync(outPath)) {
  const db = openDb(outPath);
  try {
    type OutRow = { seq: number; kind: string; timestamp: string; content: string };
    const outRows = db
      .prepare(
        'SELECT seq, kind, timestamp, substr(content,1,90) as content FROM messages_out ORDER BY seq DESC LIMIT 8',
      )
      .all() as OutRow[];
    if (outRows.length === 0) {
      console.log('  (empty)');
    } else {
      console.log(`  ${col('seq', 5)}  ${col('kind', 10)}  ${col('timestamp', 19)}  content`);
      console.log(`  ${'─'.repeat(5)}  ${'─'.repeat(10)}  ${'─'.repeat(19)}  ${'─'.repeat(30)}`);
      for (const r of outRows) {
        console.log(
          `  ${col(r.seq, 5)}  ${col(r.kind, 10)}  ${col((r.timestamp ?? '').slice(0, 19), 19)}  ${trunc(r.content, 60)}`,
        );
      }
    }

    // processing_ack
    console.log(`\n── PROCESSING ACK ${'─'.repeat(56)}`);
    type AckRow = { message_id: string; status: string; status_changed: string };
    const ackRows = db
      .prepare('SELECT message_id, status, status_changed FROM processing_ack ORDER BY status_changed DESC LIMIT 8')
      .all() as AckRow[];
    if (ackRows.length === 0) {
      console.log('  (empty)');
    } else {
      console.log(`  ${col('message_id', 50)}  ${col('status', 12)}  changed`);
      console.log(`  ${'─'.repeat(50)}  ${'─'.repeat(12)}  ${'─'.repeat(19)}`);
      for (const r of ackRows) {
        console.log(
          `  ${col(r.message_id, 50)}  ${col(r.status, 12)}  ${(r.status_changed ?? '').slice(0, 19)}`,
        );
      }
    }

    // session_state
    console.log(`\n── SESSION STATE ${'─'.repeat(58)}`);
    type StateRow = { key: string; value: string; updated_at: string };
    const stateRows = db.prepare('SELECT key, value, updated_at FROM session_state').all() as StateRow[];
    if (stateRows.length === 0) {
      console.log('  (empty)');
    } else {
      for (const r of stateRows) {
        console.log(`  ${col(r.key, 28)}  ${trunc(r.value, 40)}  (${ago(r.updated_at)})`);
      }
    }
  } finally {
    db.close();
  }
} else {
  console.log('  outbound.db NOT FOUND');
  console.log('\n── PROCESSING ACK ─────────────────────────────────────────────────────');
  console.log('  outbound.db NOT FOUND');
  console.log('\n── SESSION STATE ──────────────────────────────────────────────────────');
  console.log('  outbound.db NOT FOUND');
}

// Diagnosis
const notes = diagnoseSession(sess, dir);
console.log(`\n── DIAGNOSIS ${'─'.repeat(61)}`);
for (const note of notes) {
  const tag = note.level === 'error' ? '[ERR] ' : note.level === 'warn' ? '[WARN]' : '[OK]  ';
  console.log(`  ${tag}  ${note.msg}`);
}
if (notes.length === 0) console.log('  [OK]   No issues detected.');
console.log('');
