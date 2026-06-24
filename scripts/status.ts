#!/usr/bin/env node
/**
 * scripts/status.ts — Full NanoClaw server health check.
 *
 * Usage:
 *   pnpm exec tsx scripts/status.ts [--output <path>]
 *
 * Queries the central DB and every active session's inbound/outbound DBs,
 * checks heartbeat files, and writes a structured JSON report.  Also
 * prints a human-readable summary to stdout.
 *
 * Default output: logs/status-<timestamp>.json
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

// ── Constants ─────────────────────────────────────────────────────────────────

const CENTRAL_DB = 'data/v2.db';
const SESSIONS_DIR = 'data/v2-sessions';
const LOGS_DIR = 'logs';

// Thresholds (ms)
const HEARTBEAT_WARN_MS = 5 * 60 * 1000;    // 5 min — stale but maybe ok
const HEARTBEAT_CRIT_MS = 30 * 60 * 1000;   // 30 min — absolute ceiling
const STUCK_RUNNING_MS = 5 * 60 * 1000;     // 5 min — processing_ack stuck (running)
const STUCK_STOPPED_MS = 7 * 24 * 3600 * 1000; // 7 days — stopped
const HIGH_TRIES = 2;                        // > this → retry storm
const APPROVAL_WARN_MS = 24 * 3600 * 1000;  // 24 h — pending approval too old
const STALE_SESSION_MS = 7 * 24 * 3600 * 1000; // 7 days — inactive session

// ── Types ─────────────────────────────────────────────────────────────────────

type Severity = 'critical' | 'warning' | 'info';
type Health = 'healthy' | 'degraded' | 'critical';

interface Issue {
  severity: Severity;
  type: string;
  session_id?: string;
  detail: string;
}

interface SessionHealth {
  id: string;
  agent_group_id: string;
  agent_group_name: string;
  messaging_group_id: string | null;
  messaging_group_name: string | null;
  channel_type: string | null;
  status: string;
  container_status: string;
  last_active: string | null;
  heartbeat_age_s: number | null;
  inbound: {
    pending_due: number;
    on_wake_queued: number;
    high_retry: number;
    failed: number;
  };
  outbound: {
    stuck_processing: number;
    oldest_stuck_age_s: number | null;
  };
  health: Health;
  issues: Issue[];
}

interface StatusReport {
  timestamp: string;
  overall_health: Health;
  summary: {
    active_sessions: number;
    running_containers: number;
    idle_containers: number;
    stopped_containers: number;
    pending_messages_due: number;
    high_retry_messages: number;
    failed_messages: number;
    stuck_processing_claims: number;
    pending_approvals: number;
    unregistered_senders: number;
    agent_groups: number;
    messaging_groups: number;
    wirings: number;
  };
  issues: Issue[];
  sessions: SessionHealth[];
  pending_approvals: Array<{
    approval_id: string;
    session_id: string | null;
    action: string;
    title: string;
    status: string;
    created_at: string;
    age_h: number;
  }>;
  unregistered_senders: Array<{
    channel_type: string;
    platform_id: string;
    reason: string;
    message_count: number;
    first_seen: string;
    last_seen: string;
  }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function openRo(path: string): Database.Database {
  return new Database(path, { readonly: true });
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

function worstHealth(issues: Issue[]): Health {
  if (issues.some((i) => i.severity === 'critical')) return 'critical';
  if (issues.some((i) => i.severity === 'warning')) return 'degraded';
  return 'healthy';
}

function col(s: string | number | null, w: number): string {
  const str = String(s ?? '—');
  return str.length >= w ? str.slice(0, w) : str.padEnd(w);
}

// ── Per-session diagnosis ─────────────────────────────────────────────────────

function diagnoseSession(
  sess: { id: string; agent_group_id: string; messaging_group_id: string | null; thread_id: string | null; status: string; container_status: string; last_active: string | null },
  agentName: string,
  mgName: string | null,
  channelType: string | null,
): SessionHealth {
  const dir = join(SESSIONS_DIR, sess.agent_group_id, sess.id);
  const issues: Issue[] = [];

  // ── Heartbeat ──────────────────────────────────────────────────────────────
  const hbPath = join(dir, '.heartbeat');
  let heartbeatAgeSecs: number | null = null;
  if (existsSync(hbPath)) {
    heartbeatAgeSecs = Math.floor((Date.now() - statSync(hbPath).mtimeMs) / 1000);
  }

  const isRunning = sess.container_status === 'running';

  if (isRunning) {
    if (!existsSync(hbPath)) {
      issues.push({ severity: 'warning', type: 'heartbeat_missing', session_id: sess.id, detail: 'Container marked running but no heartbeat file — may have crashed' });
    } else if (heartbeatAgeSecs !== null && heartbeatAgeSecs * 1000 >= HEARTBEAT_CRIT_MS) {
      issues.push({ severity: 'critical', type: 'stale_heartbeat', session_id: sess.id, detail: `Heartbeat is ${ago(new Date(Date.now() - heartbeatAgeSecs * 1000).toISOString())} old (>${Math.round(HEARTBEAT_CRIT_MS / 60000)}m ceiling)` });
    } else if (heartbeatAgeSecs !== null && heartbeatAgeSecs * 1000 >= HEARTBEAT_WARN_MS) {
      issues.push({ severity: 'warning', type: 'stale_heartbeat', session_id: sess.id, detail: `Heartbeat is ${ago(new Date(Date.now() - heartbeatAgeSecs * 1000).toISOString())} old (>5m, may be stale)` });
    }
  }

  // ── Inbound ────────────────────────────────────────────────────────────────
  const inPath = join(dir, 'inbound.db');
  let pendingDue = 0;
  let onWakeQueued = 0;
  let highRetry = 0;
  let failedIn = 0;

  if (existsSync(inPath)) {
    const db = openRo(inPath);
    try {
      pendingDue = (db.prepare("SELECT count(*) as n FROM messages_in WHERE status='pending' AND on_wake=0 AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))").get() as any).n;
      onWakeQueued = (db.prepare("SELECT count(*) as n FROM messages_in WHERE status='pending' AND on_wake=1").get() as any).n;
      highRetry = (db.prepare(`SELECT count(*) as n FROM messages_in WHERE tries > ${HIGH_TRIES}`).get() as any).n;
      failedIn = (db.prepare("SELECT count(*) as n FROM messages_in WHERE status='failed'").get() as any).n;
    } finally {
      db.close();
    }
  }

  if (highRetry > 0) {
    issues.push({ severity: 'warning', type: 'high_retry_messages', session_id: sess.id, detail: `${highRetry} message(s) with >${HIGH_TRIES} retries — container likely crashing on input` });
  }
  if (failedIn > 0) {
    issues.push({ severity: 'warning', type: 'failed_messages', session_id: sess.id, detail: `${failedIn} inbound message(s) permanently failed` });
  }
  if (!isRunning && pendingDue > 0) {
    issues.push({ severity: 'warning', type: 'pending_not_woken', session_id: sess.id, detail: `${pendingDue} due message(s) pending but container stopped — sweep should have woken it` });
  }

  // ── Outbound / processing_ack ──────────────────────────────────────────────
  const outPath = join(dir, 'outbound.db');
  let stuckProcessing = 0;
  let oldestStuckAgeSecs: number | null = null;

  if (existsSync(outPath)) {
    const db = openRo(outPath);
    try {
      stuckProcessing = (db.prepare("SELECT count(*) as n FROM processing_ack WHERE status='processing'").get() as any).n;
      if (stuckProcessing > 0) {
        const row = db.prepare("SELECT status_changed FROM processing_ack WHERE status='processing' ORDER BY status_changed ASC LIMIT 1").get() as any;
        if (row?.status_changed) {
          oldestStuckAgeSecs = Math.floor((Date.now() - new Date(row.status_changed).getTime()) / 1000);
          const threshold = isRunning ? STUCK_RUNNING_MS : STUCK_STOPPED_MS;
          if (oldestStuckAgeSecs * 1000 > threshold) {
            issues.push({ severity: 'warning', type: 'stuck_processing_ack', session_id: sess.id, detail: `${stuckProcessing} processing_ack row(s) stuck for ${ago(row.status_changed)}` });
          }
        }
      }
    } finally {
      db.close();
    }
  }

  // ── Stale session ──────────────────────────────────────────────────────────
  if (sess.last_active) {
    const inactiveSecs = (Date.now() - new Date(sess.last_active).getTime());
    if (inactiveSecs > STALE_SESSION_MS) {
      issues.push({ severity: 'info', type: 'stale_session', session_id: sess.id, detail: `No activity in ${ago(sess.last_active)} — consider closing this session` });
    }
  }

  return {
    id: sess.id,
    agent_group_id: sess.agent_group_id,
    agent_group_name: agentName,
    messaging_group_id: sess.messaging_group_id,
    messaging_group_name: mgName,
    channel_type: channelType,
    status: sess.status,
    container_status: sess.container_status,
    last_active: sess.last_active,
    heartbeat_age_s: heartbeatAgeSecs,
    inbound: { pending_due: pendingDue, on_wake_queued: onWakeQueued, high_retry: highRetry, failed: failedIn },
    outbound: { stuck_processing: stuckProcessing, oldest_stuck_age_s: oldestStuckAgeSecs },
    health: worstHealth(issues),
    issues,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const outputIdx = args.indexOf('--output');
const outputArg = outputIdx >= 0 ? args[outputIdx + 1] : null;

if (!existsSync(CENTRAL_DB)) {
  console.error(`Central DB not found: ${CENTRAL_DB}\nRun from the nanoclaw repo root.`);
  process.exit(1);
}

const central = openRo(CENTRAL_DB);

// ── Load lookup maps ───────────────────────────────────────────────────────────

const agentGroups = new Map<string, { id: string; name: string }>(
  (central.prepare('SELECT id, name FROM agent_groups').all() as any[]).map((g) => [g.id, g]),
);
const messagingGroups = new Map<string, { id: string; name: string; channel_type: string }>(
  (central.prepare('SELECT id, name, channel_type FROM messaging_groups').all() as any[]).map((m) => [m.id, m]),
);

// Counts
const agentGroupCount: number = (central.prepare('SELECT count(*) as n FROM agent_groups').get() as any).n;
const messagingGroupCount: number = (central.prepare('SELECT count(*) as n FROM messaging_groups').get() as any).n;
const wiringCount: number = (central.prepare('SELECT count(*) as n FROM messaging_group_agents').get() as any).n;

// ── Sessions ───────────────────────────────────────────────────────────────────

const sessions = central.prepare("SELECT * FROM sessions WHERE status='active' ORDER BY last_active DESC").all() as any[];

// ── Pending approvals ──────────────────────────────────────────────────────────

const pendingApprovals = (central.prepare("SELECT approval_id, session_id, action, title, status, created_at FROM pending_approvals WHERE status='pending' ORDER BY created_at ASC").all() as any[]).map((a) => ({
  approval_id: a.approval_id as string,
  session_id: a.session_id as string | null,
  action: a.action as string,
  title: a.title as string,
  status: a.status as string,
  created_at: a.created_at as string,
  age_h: Math.round((Date.now() - new Date(a.created_at).getTime()) / 3600000),
}));

// ── Unregistered senders ────────────────────────────────────────────────────────

const unregisteredSenders = central.prepare('SELECT channel_type, platform_id, reason, message_count, first_seen, last_seen FROM unregistered_senders ORDER BY last_seen DESC').all() as any[];

central.close();

// ── Diagnose each session ──────────────────────────────────────────────────────

const sessionHealths: SessionHealth[] = sessions.map((s) => {
  const ag = agentGroups.get(s.agent_group_id);
  const mg = s.messaging_group_id ? messagingGroups.get(s.messaging_group_id) : null;
  return diagnoseSession(s, ag?.name ?? s.agent_group_id.slice(-8), mg?.name ?? null, mg?.channel_type ?? null);
});

// ── Aggregate ──────────────────────────────────────────────────────────────────

const allIssues: Issue[] = [];

// Session issues
for (const sh of sessionHealths) {
  allIssues.push(...sh.issues);
}

// Approval issues
for (const ap of pendingApprovals) {
  if (ap.age_h > 24) {
    allIssues.push({ severity: 'warning', type: 'old_pending_approval', detail: `Approval "${ap.title || ap.action}" has been pending for ${ap.age_h}h` });
  }
}

const summary = {
  active_sessions: sessions.length,
  running_containers: sessions.filter((s) => s.container_status === 'running').length,
  idle_containers: sessions.filter((s) => s.container_status === 'idle').length,
  stopped_containers: sessions.filter((s) => s.container_status === 'stopped').length,
  pending_messages_due: sessionHealths.reduce((n, s) => n + s.inbound.pending_due, 0),
  high_retry_messages: sessionHealths.reduce((n, s) => n + s.inbound.high_retry, 0),
  failed_messages: sessionHealths.reduce((n, s) => n + s.inbound.failed, 0),
  stuck_processing_claims: sessionHealths.reduce((n, s) => n + s.outbound.stuck_processing, 0),
  pending_approvals: pendingApprovals.length,
  unregistered_senders: unregisteredSenders.length,
  agent_groups: agentGroupCount,
  messaging_groups: messagingGroupCount,
  wirings: wiringCount,
};

const overallHealth = worstHealth(allIssues);

const report: StatusReport = {
  timestamp: new Date().toISOString(),
  overall_health: overallHealth,
  summary,
  issues: allIssues,
  sessions: sessionHealths,
  pending_approvals: pendingApprovals,
  unregistered_senders: unregisteredSenders,
};

// ── Write JSON output ──────────────────────────────────────────────────────────

if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outputPath = outputArg ?? join(LOGS_DIR, `status-${ts}.json`);
writeFileSync(outputPath, JSON.stringify(report, null, 2));

// ── Dashboard ──────────────────────────────────────────────────────────────────

const USE_COLOR = process.stdout.isTTY !== false && !process.env.NO_COLOR;
const TW = Math.max(80, Math.min(process.stdout.columns || 80, 100));
const IW = TW - 2;

type Styler = (s: string) => string;
const mk = (code: string): Styler =>
  USE_COLOR ? (s: string) => `\x1b[${code}m${s}\x1b[0m` : (s: string) => s;

const bold   = mk('1');
const dim    = mk('2');
const green  = mk('32');

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}
function vlen(s: string): number {
  return stripAnsi(s).length;
}
function rpad(s: string, w: number): string {
  const v = vlen(s);
  if (v > w) return stripAnsi(s).slice(0, w);
  if (v === w) return s;
  return s + ' '.repeat(w - v);
}

// Composite ANSI codes avoid nesting-reset issues
const HEALTH_CODE: Record<Health, string>     = { healthy: '32',   degraded: '33',   critical: '31'   };
const HEALTH_BOLD:  Record<Health, string>     = { healthy: '1;32', degraded: '1;33', critical: '1;31' };
const SEV_CODE:     Record<Severity, string>   = { critical: '1;31', warning: '33', info: '2' };
const CTR_CODE:     Record<string, string>     = { running: '32', idle: '2', stopped: '2' };

function hStyle(h: Health): Styler {
  const c = HEALTH_CODE[h];
  return USE_COLOR ? (s) => `\x1b[${c}m${s}\x1b[0m` : (s) => s;
}
function sStyle(sev: Severity): Styler {
  const c = SEV_CODE[sev];
  return USE_COLOR ? (s) => `\x1b[${c}m${s}\x1b[0m` : (s) => s;
}
function ctrStyle(status: string): Styler {
  const c = CTR_CODE[status] ?? '2';
  return USE_COLOR ? (s) => `\x1b[${c}m${s}\x1b[0m` : (s) => s;
}

function printLine(content: string): void {
  const pad = ' '.repeat(Math.max(0, IW - vlen(content)));
  process.stdout.write(`║${content}${pad}║\n`);
}
function printHr(l = '╠', fill = '═', r2 = '╣'): void {
  process.stdout.write(`${l}${fill.repeat(IW)}${r2}\n`);
}
function printBlank(): void {
  process.stdout.write(`║${' '.repeat(IW)}║\n`);
}

const DOT: Record<Health, string> = { healthy: '●', degraded: '◐', critical: '✗' };

// ── Header ────────────────────────────────────────────────────────────────────

const tsStr = report.timestamp.slice(0, 19).replace('T', ' ');
const healthBadge = USE_COLOR
  ? `\x1b[${HEALTH_BOLD[overallHealth]}m${DOT[overallHealth]} ${overallHealth.toUpperCase()}\x1b[0m`
  : `${DOT[overallHealth]} ${overallHealth.toUpperCase()}`;

process.stdout.write(`╔${'═'.repeat(IW)}╗\n`);
{
  const left = ` ${bold('NANOCLAW')}  ${dim(tsStr)}`;
  const right = `${healthBadge} `;
  const gap = Math.max(1, IW - vlen(left) - vlen(right));
  printLine(`${left}${' '.repeat(gap)}${right}`);
}
printHr();

// ── Stats columns ─────────────────────────────────────────────────────────────
// " C1 │ C2 │ C3 "  =>  1 + COL + 3 + COL + 3 + COL + 1 = COL*3+8 = IW

const COL = Math.floor((IW - 8) / 3);

interface StatEntry { val: number | string; label: string; warn?: boolean }

function statBlock(heading: string, rows: StatEntry[]): string[] {
  const lines: string[] = [];
  lines.push(bold(heading));
  lines.push(dim('─'.repeat(Math.min(vlen(heading) + 2, COL))));
  for (const { val, label, warn } of rows) {
    const isWarn = warn !== undefined ? warn : (typeof val === 'number' && val > 0);
    const numStr = isWarn ? bold(String(val)) : dim(String(val));
    lines.push(`${rpad(numStr, 4)} ${dim(label)}`);
  }
  return lines;
}

const sBlk1 = statBlock('SESSIONS', [
  { val: summary.active_sessions,    label: 'active',  warn: false },
  { val: summary.running_containers, label: 'running', warn: false },
  { val: summary.idle_containers,    label: 'idle',    warn: false },
  { val: summary.stopped_containers, label: 'stopped', warn: false },
]);
const sBlk2 = statBlock('MESSAGES', [
  { val: summary.pending_messages_due,    label: 'pending due' },
  { val: summary.high_retry_messages,     label: 'high-retry' },
  { val: summary.failed_messages,         label: 'failed' },
  { val: summary.stuck_processing_claims, label: 'stuck outbound' },
]);
const sBlk3 = statBlock('REGISTRY', [
  { val: summary.agent_groups,         label: 'agent groups', warn: false },
  { val: summary.messaging_groups,     label: 'msg groups',   warn: false },
  { val: summary.wirings,              label: 'wirings',      warn: false },
  { val: summary.pending_approvals,    label: 'approvals' },
  { val: summary.unregistered_senders, label: 'dropped' },
]);

printBlank();
const maxStat = Math.max(sBlk1.length, sBlk2.length, sBlk3.length);
for (let i = 0; i < maxStat; i++) {
  const c1 = rpad(sBlk1[i] ?? '', COL);
  const c2 = rpad(sBlk2[i] ?? '', COL);
  const c3 = rpad(sBlk3[i] ?? '', COL);
  printLine(` ${c1} │ ${c2} │ ${c3} `);
}
printBlank();
printHr();

// ── Issues ────────────────────────────────────────────────────────────────────

const sortedIssues = [...allIssues].sort((a, b) => {
  const o: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  return o[a.severity] - o[b.severity];
});

{
  const critN = allIssues.filter((i) => i.severity === 'critical').length;
  const warnN = allIssues.filter((i) => i.severity === 'warning').length;
  const infoN = allIssues.filter((i) => i.severity === 'info').length;
  const parts: string[] = [];
  if (critN) parts.push(USE_COLOR ? `\x1b[1;31m${critN} critical\x1b[0m` : `${critN} critical`);
  if (warnN) parts.push(USE_COLOR ? `\x1b[33m${warnN} warning\x1b[0m` : `${warnN} warning`);
  if (infoN) parts.push(dim(`${infoN} info`));
  const suffix = parts.length ? `  ${parts.join(', ')}` : '';
  printLine(` ${bold('ISSUES')}${suffix}`);
}

if (allIssues.length === 0) {
  printLine(`   ${green('No issues detected')}`);
} else {
  for (const issue of sortedIssues) {
    const badge  = sStyle(issue.severity)(`[${issue.severity.toUpperCase().slice(0, 4)}]`);
    const sid    = issue.session_id ? ` ${dim(issue.session_id.slice(-8))}` : '';
    const prefix = `   ${badge}${sid}  `;
    const maxDW  = IW - vlen(prefix) - 1;
    const detail = issue.detail.length > maxDW ? issue.detail.slice(0, maxDW) : issue.detail;
    printLine(`${prefix}${detail}`);
  }
}
printHr();

// ── Sessions table ─────────────────────────────────────────────────────────────

if (sessionHealths.length > 0) {
  // " " TID "  " TAG "  " TCH "  " TCTR "  " TACT "  " THL = IW
  // 1 + TID + 2 + TAG + 2 + TCH + 2 + TCTR + 2 + TACT + 2 + THL = IW
  const TID = 10, TAG = 14, TCH = 17, TCTR = 7, TACT = 9;
  const THL = IW - 11 - TID - TAG - TCH - TCTR - TACT;

  function sessionRow(cells: string[]): void {
    const widths = [TID, TAG, TCH, TCTR, TACT, THL];
    const parts  = cells.map((c, i) => rpad(c, widths[i]));
    printLine(` ${parts.join('  ')}`);
  }

  const divLine = dim(` ${[TID, TAG, TCH, TCTR, TACT, THL].map((w) => '─'.repeat(w)).join('  ')}`);

  printLine(` ${bold('SESSIONS')}`);
  printLine(divLine);
  sessionRow([bold('SESSION ID'), bold('AGENT'), bold('CHANNEL'), bold('CTR'), bold('ACTIVE'), bold('HEALTH')]);
  printLine(divLine);

  for (const sh of sessionHealths) {
    const ch     = sh.messaging_group_name
      ? `${sh.messaging_group_name}${sh.channel_type ? ` [${sh.channel_type}]` : ''}`
      : '—';
    const ctrStr = ctrStyle(sh.container_status)(sh.container_status);
    const hStr   = hStyle(sh.health)(`${DOT[sh.health]} ${sh.health}`);
    sessionRow([dim(sh.id.slice(-TID)), sh.agent_group_name, ch, ctrStr, ago(sh.last_active), hStr]);
  }

  printLine(divLine);
  printBlank();
  printHr();
}

// ── Unregistered senders ──────────────────────────────────────────────────────

if (unregisteredSenders.length > 0) {
  printLine(` ${bold('DROPPED')}  ${dim(`${unregisteredSenders.length} unregistered sender(s)`)}`);
  for (const u of unregisteredSenders.slice(0, 5)) {
    const id = `${u.channel_type}/${u.platform_id}`;
    const idStr = USE_COLOR ? `\x1b[36m${id}\x1b[0m` : id;
    printLine(`   ${idStr}  ${bold(`×${u.message_count}`)}  last ${ago(u.last_seen)}  ${dim(u.reason)}`);
  }
  if (unregisteredSenders.length > 5) {
    printLine(`   ${dim(`…and ${unregisteredSenders.length - 5} more`)}`);
  }
  printBlank();
  printHr();
}

// ── Pending approvals ─────────────────────────────────────────────────────────

if (pendingApprovals.length > 0) {
  printLine(` ${bold('APPROVALS')}  ${dim(`${pendingApprovals.length} pending`)}`);
  for (const ap of pendingApprovals) {
    const ageStr = ap.age_h > 24
      ? (USE_COLOR ? `\x1b[33m${ap.age_h}h\x1b[0m` : `${ap.age_h}h`)
      : dim(`${ap.age_h}h`);
    printLine(`   ${ap.title || ap.action}  ${dim('age')} ${ageStr}`);
  }
  printBlank();
  printHr();
}

// ── Footer ────────────────────────────────────────────────────────────────────

printLine(` ${dim('Report:')} ${outputPath}`);
process.stdout.write(`╚${'═'.repeat(IW)}╝\n`);
