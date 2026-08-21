/**
 * Agent-group teardown — planning + execution.
 *
 * `ncl groups delete` is a bare `DELETE FROM agent_groups` (`src/cli/crud.ts`
 * genericDelete) and every group that has ever been wired or run has blocking
 * FK references, so it cannot work. This module is the real teardown: it
 * computes a plan (safe to print, changes nothing) and can then execute it in
 * an order that never trips a foreign key.
 *
 * Design notes worth keeping:
 *
 *  - **Report, don't rewrite, per-session destination mirrors.** Each session's
 *    `inbound.db` holds a projection of `agent_destinations`. `spawnContainer`
 *    calls `writeDestinations` → `replaceDestinations` (a transactional
 *    `DELETE FROM destinations` + re-insert) on *every* wake, and
 *    `routeAgentMessage` re-validates against the central table anyway. Fixing
 *    the central rows is therefore sufficient; hand-editing a live `inbound.db`
 *    would just be overwritten. We surface stale mirrors so an operator knows
 *    they exist, and leave them alone.
 *  - **Resolve by folder before the row is gone.** `--folder` lookups go
 *    through `agent_groups`, so folder resolution must happen up front. The
 *    plan captures the folder so a resumed run can still find the directory.
 *  - **Every directory removal is keyed on the exact target id.** Removing a
 *    surviving group's session directory would be unrecoverable, so each path
 *    is re-derived from the target id/folder and re-checked against its root
 *    immediately before `rm`.
 *
 * See `docs/runbooks/agent-group-teardown.md` for the operator-facing runbook
 * and the full deletion order with FK evidence.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { hasTable } from '../db/connection.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface TeardownEnv {
  /** Root that contains `v2-sessions/`. Defaults to config DATA_DIR. */
  dataDir: string;
  /** Root that contains `<folder>/`. Defaults to config GROUPS_DIR. */
  groupsDir: string;
  /** Docker image repository base, e.g. `nanoclaw-agent-v2-ab12cd34`. */
  containerImageBase: string;
  /** `nanoclaw-install=<slug>` label stamped on every container we spawn. */
  containerInstallLabel: string;
  /** Command runner. Injected so tests never shell out. */
  exec: (cmd: string, args: string[]) => ExecResult;
}

export interface DestinationEdge {
  agent_group_id: string;
  local_name: string;
  target_type: string;
  target_id: string;
}

export interface StaleMirror {
  path: string;
  agentGroupId: string;
  sessionId: string;
  name: string;
}

export interface ProseReference {
  file: string;
  line: number;
  term: string;
  text: string;
}

export interface OrphanReport {
  /** `data/v2-sessions/<...>` directories with nothing backing them. */
  sessionDirs: { path: string; reason: string }[];
  /** Messaging groups with no wiring at all (before/after this teardown). */
  messagingGroups: { id: string; name: string | null; channel_type: string; reason: string }[];
}

export interface TeardownPlan {
  /** The agent group id being torn down. Every destructive step keys on this. */
  agentGroupId: string;
  /** Display name, if the row still exists. */
  name: string | null;
  /** `groups/<folder>` name, if the row still exists. */
  folder: string | null;
  /** True when the `agent_groups` row is already gone (resumed / partial run). */
  residual: boolean;
  /** Running container names to stop first. */
  containers: string[];
  /** Wirings (`messaging_group_agents`) that will be removed. */
  wirings: { messaging_group_id: string; agent_group_id: string }[];
  /** Session ids owned by this group. */
  sessionIds: string[];
  /** Session-scoped blockers keyed by session id (no `agent_group_id` column). */
  sessionBlockers: { table: string; count: number }[];
  /** `agent_destinations` rows in OTHER groups pointing at this one (no FK). */
  inboundDestinations: DestinationEdge[];
  /** Per-session `destinations` mirrors in other groups. Report-only. */
  staleMirrors: StaleMirror[];
  /** Row counts per table carrying `agent_group_id`. */
  rowCounts: { table: string; count: number; cascades: boolean }[];
  /** Directories that will be removed. Always derived from the target id. */
  directories: string[];
  /** Docker image tags to remove. */
  imageTags: string[];
  /** OneCLI vault agent to delete, if found. */
  onecliAgent: { id: string; name: string; identifier: string } | null;
  /** Prose mentions of this group in surviving groups' instruction files. */
  proseReferences: ProseReference[];
  /** Report-only: orphans that exist now or would exist after this teardown. */
  orphans: OrphanReport;
  /** Non-fatal problems encountered while planning (docker missing, etc.). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

export function defaultExec(cmd: string, args: string[]): ExecResult {
  try {
    const stdout = execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, stdout, stderr: '' };
  } catch (err) {
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    return {
      ok: false,
      stdout: e.stdout ? String(e.stdout) : '',
      stderr: e.stderr ? String(e.stderr) : String(e.message ?? err),
    };
  }
}

// ---------------------------------------------------------------------------
// Path guards
// ---------------------------------------------------------------------------

/**
 * Refuse any path that is not exactly `<root>/<expectedName>`.
 *
 * Deleting the wrong group's session directory is unrecoverable, so this is
 * called immediately before every `rm` rather than only at plan time.
 */
export function assertSafePath(target: string, root: string, expectedName: string): void {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(target);
  const expected = path.resolve(resolvedRoot, expectedName);
  if (resolved !== expected) {
    throw new Error(`refusing to remove ${resolved}: expected ${expected}`);
  }
  if (path.dirname(resolved) !== resolvedRoot) {
    throw new Error(`refusing to remove ${resolved}: not directly under ${resolvedRoot}`);
  }
  if (!expectedName || expectedName === '.' || expectedName === '..' || expectedName.includes(path.sep)) {
    throw new Error(`refusing to remove ${resolved}: unsafe name ${JSON.stringify(expectedName)}`);
  }
}

// ---------------------------------------------------------------------------
// Schema introspection
// ---------------------------------------------------------------------------

/** Every table (except `agent_groups`) carrying an `agent_group_id` column. */
export function agentGroupIdTables(db: Database.Database): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT m.name FROM sqlite_master m
         JOIN pragma_table_info(m.name) p ON p.name = 'agent_group_id'
         WHERE m.type = 'table' AND m.name != 'agent_groups'
         ORDER BY m.name`,
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
}

/** True when `table.agent_group_id` declares `ON DELETE CASCADE`. */
export function cascadesOnAgentGroup(db: Database.Database, table: string): boolean {
  const fks = db.prepare(`SELECT * FROM pragma_foreign_key_list(?)`).all(table) as {
    table: string;
    from: string;
    on_delete: string;
  }[];
  return fks.some((fk) => fk.table === 'agent_groups' && fk.from === 'agent_group_id' && fk.on_delete === 'CASCADE');
}

/**
 * Tables that reference `sessions(id)` with a blocking action AND have no
 * `agent_group_id` column — i.e. the ones a group-scoped sweep misses and
 * which will refuse a `DELETE FROM sessions`.
 *
 * Computed rather than hard-coded so a new migration cannot silently add a
 * blocker the tool does not know about.
 */
export function sessionBlockerTables(db: Database.Database): { table: string; column: string }[] {
  const tables = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as { name: string }[]
  ).map((r) => r.name);
  const out: { table: string; column: string }[] = [];
  for (const table of tables) {
    if (table === 'sessions') continue;
    const fks = db.prepare(`SELECT * FROM pragma_foreign_key_list(?)`).all(table) as {
      table: string;
      from: string;
      on_delete: string;
    }[];
    for (const fk of fks) {
      if (fk.table !== 'sessions') continue;
      if (fk.on_delete === 'CASCADE') continue;
      out.push({ table, column: fk.from });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Filesystem discovery
// ---------------------------------------------------------------------------

function sessionsRoot(env: TeardownEnv): string {
  return path.join(env.dataDir, 'v2-sessions');
}

/**
 * Subdirectories, excluding dot-directories. Every group session root carries a
 * `.claude-shared/` that is shared state, not a session — counting it would
 * both mask a truly empty group directory and report it as an orphan session.
 */
function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Per-session `destinations` mirrors in OTHER groups' `inbound.db` files that
 * still point at `agentGroupId`.
 *
 * Report-only by design — see the module header.
 */
export function findStaleMirrors(
  env: TeardownEnv,
  agentGroupId: string,
): { mirrors: StaleMirror[]; warnings: string[] } {
  const mirrors: StaleMirror[] = [];
  const warnings: string[] = [];
  const root = sessionsRoot(env);
  for (const groupDir of listDirs(root)) {
    if (groupDir === agentGroupId) continue;
    for (const sessDir of listDirs(path.join(root, groupDir))) {
      const dbPath = path.join(root, groupDir, sessDir, 'inbound.db');
      if (!fs.existsSync(dbPath)) continue;
      let db: Database.Database | undefined;
      try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
        db.pragma('busy_timeout = 2000');
        if (!hasTable(db, 'destinations')) continue;
        const rows = db.prepare(`SELECT name FROM destinations WHERE agent_group_id = ?`).all(agentGroupId) as {
          name: string;
        }[];
        for (const row of rows) {
          mirrors.push({ path: dbPath, agentGroupId: groupDir, sessionId: sessDir, name: row.name });
        }
      } catch (err) {
        warnings.push(`could not read ${dbPath}: ${(err as Error).message}`);
      } finally {
        db?.close();
      }
    }
  }
  return { mirrors, warnings };
}

// ---------------------------------------------------------------------------
// Prose reference scan (AC#3)
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Grep surviving groups' `CLAUDE*.md` for the deleted group's name and for the
 * `local_name`s by which each surviving group refers to it.
 *
 * This is the check that catches instructions like "querying <group> is
 * mandatory" left behind in another agent's CLAUDE.md.
 */
export function scanProseReferences(
  env: TeardownEnv,
  opts: { deletedFolder: string | null; deletedName: string | null; inboundDestinations: DestinationEdge[] },
  folderOf: (agentGroupId: string) => string | null,
): { references: ProseReference[]; warnings: string[] } {
  const references: ProseReference[] = [];
  const warnings: string[] = [];

  const globalTerms = [opts.deletedName].filter((t): t is string => !!t && t.trim().length >= 3);
  if (opts.deletedName && globalTerms.length === 0) {
    warnings.push(`group name ${JSON.stringify(opts.deletedName)} is too short to grep for safely — skipped`);
  }

  // Per-surviving-group extra terms: the local_name that group uses for us.
  const perFolderTerms = new Map<string, string[]>();
  for (const edge of opts.inboundDestinations) {
    const folder = folderOf(edge.agent_group_id);
    if (!folder) continue;
    if (edge.local_name.trim().length < 3) continue;
    perFolderTerms.set(folder, [...(perFolderTerms.get(folder) ?? []), edge.local_name]);
  }

  for (const folder of listDirs(env.groupsDir)) {
    if (opts.deletedFolder && folder === opts.deletedFolder) continue;
    const terms = [...new Set([...globalTerms, ...(perFolderTerms.get(folder) ?? [])])];
    if (terms.length === 0) continue;
    const patterns = terms.map((t) => ({ term: t, re: new RegExp(`\\b${escapeRegExp(t)}\\b`, 'i') }));

    let entries: string[];
    try {
      entries = fs
        .readdirSync(path.join(env.groupsDir, folder))
        .filter((f) => /^CLAUDE.*\.md$/i.test(f))
        .sort();
    } catch {
      continue;
    }
    for (const file of entries) {
      const full = path.join(env.groupsDir, folder, file);
      let content: string;
      try {
        content = fs.readFileSync(full, 'utf-8');
      } catch (err) {
        warnings.push(`could not read ${full}: ${(err as Error).message}`);
        continue;
      }
      content.split('\n').forEach((text, i) => {
        for (const { term, re } of patterns) {
          if (re.test(text)) {
            references.push({ file: full, line: i + 1, term, text: text.trim().slice(0, 200) });
            break;
          }
        }
      });
    }
  }
  return { references, warnings };
}

// ---------------------------------------------------------------------------
// Orphan reporting (AC#4)
// ---------------------------------------------------------------------------

/**
 * Report-only. `excludeAgentGroupId` (the group being torn down) is left out
 * so its own soon-to-be-deleted rows don't show up as pre-existing orphans;
 * `pendingWiringRemoval` lets the caller ask "which messaging groups will be
 * orphaned *after* this teardown".
 */
export function findOrphans(
  db: Database.Database,
  env: TeardownEnv,
  opts: { excludeAgentGroupId?: string } = {},
): OrphanReport {
  const exclude = opts.excludeAgentGroupId;

  const groupIds = new Set((db.prepare('SELECT id FROM agent_groups').all() as { id: string }[]).map((r) => r.id));
  const sessions = db.prepare('SELECT id, agent_group_id FROM sessions').all() as {
    id: string;
    agent_group_id: string;
  }[];
  const sessionIds = new Set(sessions.map((s) => s.id));
  const groupsWithSessions = new Set(sessions.map((s) => s.agent_group_id));

  const sessionDirs: { path: string; reason: string }[] = [];
  const root = sessionsRoot(env);
  for (const groupDir of listDirs(root)) {
    const full = path.join(root, groupDir);
    if (!groupIds.has(groupDir)) {
      sessionDirs.push({ path: full, reason: 'no agent_groups row' });
      continue;
    }
    if (groupDir === exclude) continue;
    const subdirs = listDirs(full);
    if (subdirs.length === 0 && !groupsWithSessions.has(groupDir)) {
      sessionDirs.push({ path: full, reason: 'agent group has no sessions rows and no session subdirectories' });
      continue;
    }
    for (const sessDir of subdirs) {
      if (!sessionIds.has(sessDir)) {
        sessionDirs.push({ path: path.join(full, sessDir), reason: 'no sessions row' });
      }
    }
  }

  const messagingGroups = (
    db
      .prepare(
        `SELECT mg.id, mg.name, mg.channel_type,
                (SELECT COUNT(*) FROM messaging_group_agents a WHERE a.messaging_group_id = mg.id) AS wirings,
                (SELECT COUNT(*) FROM messaging_group_agents a
                   WHERE a.messaging_group_id = mg.id AND a.agent_group_id != COALESCE(?, '')) AS survivingWirings
         FROM messaging_groups mg ORDER BY mg.id`,
      )
      .all(exclude ?? null) as {
      id: string;
      name: string | null;
      channel_type: string;
      wirings: number;
      survivingWirings: number;
    }[]
  )
    .filter((r) => r.survivingWirings === 0)
    .map((r) => ({
      id: r.id,
      name: r.name,
      channel_type: r.channel_type,
      reason: r.wirings === 0 ? 'already has no wiring' : 'would have no wiring after this teardown',
    }));

  return { sessionDirs, messagingGroups };
}

// ---------------------------------------------------------------------------
// Docker / OneCLI discovery
// ---------------------------------------------------------------------------

/** Running container names belonging to this group. `nanoclaw-v2-<folder>-<ts>`. */
export function findContainers(env: TeardownEnv, folder: string | null): { names: string[]; warnings: string[] } {
  if (!folder) return { names: [], warnings: [] };
  const res = env.exec('docker', ['ps', '--filter', `label=${env.containerInstallLabel}`, '--format', '{{.Names}}']);
  if (!res.ok) {
    return { names: [], warnings: [`docker ps failed: ${res.stderr.trim() || 'unknown error'}`] };
  }
  const re = new RegExp(`^nanoclaw-v2-${escapeRegExp(folder)}-\\d+$`);
  return {
    names: res.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((n) => re.test(n)),
    warnings: [],
  };
}

/** Per-group image tags: `<base>:<agent-group-id>`, plus whatever the config records. */
export function findImageTags(
  env: TeardownEnv,
  agentGroupId: string,
  configImageTag: string | null,
): { tags: string[]; warnings: string[] } {
  const res = env.exec('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}']);
  if (!res.ok) {
    return { tags: [], warnings: [`docker images failed: ${res.stderr.trim() || 'unknown error'}`] };
  }
  const existing = new Set(
    res.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const candidates = new Set<string>([`${env.containerImageBase}:${agentGroupId}`]);
  // Only ever consider a config-recorded tag when it is unambiguously ours.
  if (configImageTag && configImageTag.endsWith(`:${agentGroupId}`)) candidates.add(configImageTag);
  return { tags: [...candidates].filter((t) => existing.has(t)), warnings: [] };
}

/** OneCLI identifier for a group: the id, `ag-`-prefixed when it starts with a digit. */
export function onecliIdentifier(agentGroupId: string): string {
  return /^[a-z]/i.test(agentGroupId) ? agentGroupId : `ag-${agentGroupId}`;
}

export function findOnecliAgent(
  env: TeardownEnv,
  agentGroupId: string,
): { agent: { id: string; name: string; identifier: string } | null; warnings: string[] } {
  const res = env.exec('onecli', ['agents', 'list']);
  if (!res.ok) {
    return { agent: null, warnings: [`onecli agents list failed: ${res.stderr.trim() || 'unknown error'}`] };
  }
  let parsed: { data?: { id: string; name: string; identifier: string; isDefault?: boolean }[] };
  try {
    parsed = JSON.parse(res.stdout);
  } catch (err) {
    return { agent: null, warnings: [`could not parse onecli agents list: ${(err as Error).message}`] };
  }
  const wanted = onecliIdentifier(agentGroupId);
  const match = (parsed.data ?? []).find((a) => a.identifier === wanted || a.identifier === agentGroupId);
  if (!match) return { agent: null, warnings: [] };
  if (match.isDefault) {
    return { agent: null, warnings: [`refusing to touch the OneCLI default agent (${match.identifier})`] };
  }
  // Deliberately drop every other field — `agents list` includes accessToken.
  return { agent: { id: match.id, name: match.name, identifier: match.identifier }, warnings: [] };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface PlanOptions {
  agentGroupId?: string;
  folder?: string;
  keepOnecli?: boolean;
  keepImages?: boolean;
}

export function planTeardown(db: Database.Database, env: TeardownEnv, opts: PlanOptions): TeardownPlan {
  const warnings: string[] = [];

  let row: { id: string; name: string; folder: string } | undefined;
  if (opts.agentGroupId) {
    row = db.prepare('SELECT id, name, folder FROM agent_groups WHERE id = ?').get(opts.agentGroupId) as typeof row;
  } else if (opts.folder) {
    // Folder resolution must happen while the row still exists — a resumed run
    // has to be given --id instead.
    row = db.prepare('SELECT id, name, folder FROM agent_groups WHERE folder = ?').get(opts.folder) as typeof row;
  }
  if (!row && !opts.agentGroupId) {
    throw new Error(
      `no agent group with folder "${opts.folder}". Re-run with --id <agent-group-id> to clean up residual state.`,
    );
  }

  const agentGroupId = row?.id ?? (opts.agentGroupId as string);
  const folder = row?.folder ?? null;
  const residual = !row;
  if (residual) {
    warnings.push(
      `no agent_groups row for ${agentGroupId} — residual mode: DB sweep, directories, image and OneCLI agent only.`,
    );
  }

  // Containers
  const containersRes = findContainers(env, folder);
  warnings.push(...containersRes.warnings);

  // Wirings + sessions
  const wirings = db
    .prepare('SELECT messaging_group_id, agent_group_id FROM messaging_group_agents WHERE agent_group_id = ?')
    .all(agentGroupId) as { messaging_group_id: string; agent_group_id: string }[];
  const sessionIds = (
    db.prepare('SELECT id FROM sessions WHERE agent_group_id = ? ORDER BY id').all(agentGroupId) as { id: string }[]
  ).map((r) => r.id);

  // Session-scoped blockers (no agent_group_id column → missed by the sweep)
  const sessionBlockers: { table: string; count: number }[] = [];
  if (sessionIds.length > 0) {
    const placeholders = sessionIds.map(() => '?').join(', ');
    for (const { table, column } of sessionBlockerTables(db)) {
      const { n } = db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} IN (${placeholders})`)
        .get(...sessionIds) as { n: number };
      sessionBlockers.push({ table, count: n });
    }
  } else {
    for (const { table } of sessionBlockerTables(db)) sessionBlockers.push({ table, count: 0 });
  }

  // Inbound destination edges from OTHER groups (target_id has no FK)
  const inboundDestinations = hasTable(db, 'agent_destinations')
    ? (db
        .prepare(
          `SELECT agent_group_id, local_name, target_type, target_id
             FROM agent_destinations WHERE target_id = ? AND agent_group_id != ?`,
        )
        .all(agentGroupId, agentGroupId) as DestinationEdge[])
    : [];

  // Per-session mirrors — report only
  const mirrorsRes = findStaleMirrors(env, agentGroupId);
  warnings.push(...mirrorsRes.warnings);

  // Row counts across every agent_group_id table
  const rowCounts = agentGroupIdTables(db).map((table) => {
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE agent_group_id = ?`).get(agentGroupId) as {
      n: number;
    };
    return { table, count: n, cascades: cascadesOnAgentGroup(db, table) };
  });

  // Directories — always derived from the target id / folder, never from a scan
  const directories: string[] = [];
  if (folder) {
    const groupDir = path.join(env.groupsDir, folder);
    if (fs.existsSync(groupDir)) directories.push(groupDir);
  } else if (residual) {
    warnings.push('folder unknown (row already deleted) — groups/<folder>/ will not be removed.');
  }
  const sessDir = path.join(sessionsRoot(env), agentGroupId);
  if (fs.existsSync(sessDir)) directories.push(sessDir);

  // Images
  let imageTags: string[] = [];
  if (!opts.keepImages) {
    const configTag = hasTable(db, 'container_configs')
      ? ((
          db.prepare('SELECT image_tag FROM container_configs WHERE agent_group_id = ?').get(agentGroupId) as
            | { image_tag: string | null }
            | undefined
        )?.image_tag ?? null)
      : null;
    const imgRes = findImageTags(env, agentGroupId, configTag);
    imageTags = imgRes.tags;
    warnings.push(...imgRes.warnings);
  }

  // OneCLI
  let onecliAgent: TeardownPlan['onecliAgent'] = null;
  if (!opts.keepOnecli) {
    const oneRes = findOnecliAgent(env, agentGroupId);
    onecliAgent = oneRes.agent;
    warnings.push(...oneRes.warnings);
  }

  // Prose references (AC#3)
  const folderOf = (id: string): string | null =>
    (db.prepare('SELECT folder FROM agent_groups WHERE id = ?').get(id) as { folder: string } | undefined)?.folder ??
    null;
  const proseRes = scanProseReferences(
    env,
    { deletedFolder: folder, deletedName: row?.name ?? null, inboundDestinations },
    folderOf,
  );
  warnings.push(...proseRes.warnings);

  // Orphans (AC#4)
  const orphans = findOrphans(db, env, { excludeAgentGroupId: agentGroupId });

  return {
    agentGroupId,
    name: row?.name ?? null,
    folder,
    residual,
    containers: containersRes.names,
    wirings,
    sessionIds,
    sessionBlockers,
    inboundDestinations,
    staleMirrors: mirrorsRes.mirrors,
    rowCounts,
    directories,
    imageTags,
    onecliAgent,
    proseReferences: proseRes.references,
    orphans,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface ExecuteResult {
  steps: { step: string; detail: string }[];
  warnings: string[];
}

/**
 * Execute a plan. Ordering is load-bearing — see the runbook. Every step is
 * idempotent, so a partial run can simply be re-run.
 */
export function executeTeardown(db: Database.Database, env: TeardownEnv, plan: TeardownPlan): ExecuteResult {
  const steps: { step: string; detail: string }[] = [];
  const warnings: string[] = [];
  const say = (step: string, detail: string) => steps.push({ step, detail });

  // 1. Stop running containers before the rows they depend on disappear.
  for (const name of plan.containers) {
    const res = env.exec('docker', ['stop', '-t', '5', name]);
    if (res.ok) say('stop-container', name);
    else warnings.push(`docker stop ${name} failed: ${res.stderr.trim()}`);
  }

  // 2-8. Central DB, in FK-safe order, as one transaction.
  const sessionIds = (
    db.prepare('SELECT id FROM sessions WHERE agent_group_id = ? ORDER BY id').all(plan.agentGroupId) as {
      id: string;
    }[]
  ).map((r) => r.id);
  const blockers = sessionBlockerTables(db);
  const sweepTables = agentGroupIdTables(db);

  const tx = db.transaction(() => {
    // 2. Wiring first — stops inbound routing immediately.
    const w = db.prepare('DELETE FROM messaging_group_agents WHERE agent_group_id = ?').run(plan.agentGroupId);
    say('delete-wirings', `messaging_group_agents: ${w.changes}`);

    // 3. Session-scoped blockers (pending_questions / pending_approvals).
    //    These reference sessions(id) with NO ACTION and have no
    //    agent_group_id column, so the sweep in step 5 cannot reach them.
    if (sessionIds.length > 0) {
      const placeholders = sessionIds.map(() => '?').join(', ');
      for (const { table, column } of blockers) {
        const r = db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${placeholders})`).run(...sessionIds);
        if (r.changes > 0) say('clear-session-blockers', `${table}: ${r.changes}`);
      }
    }

    // 4. Sessions.
    const s = db.prepare('DELETE FROM sessions WHERE agent_group_id = ?').run(plan.agentGroupId);
    say('delete-sessions', `sessions: ${s.changes}`);

    // 5. Inbound destination edges from OTHER groups — no FK, silently dangle.
    if (hasTable(db, 'agent_destinations')) {
      const d = db
        .prepare('DELETE FROM agent_destinations WHERE target_id = ? AND agent_group_id != ?')
        .run(plan.agentGroupId, plan.agentGroupId);
      say('delete-inbound-destinations', `agent_destinations (other groups → this group): ${d.changes}`);
    }

    // 6. Everything else carrying agent_group_id (includes this group's own
    //    outbound destinations, members, roles, unregistered_senders,
    //    pending_* approvals). container_configs cascades but is swept anyway
    //    so the counts in the plan and the result agree.
    for (const table of sweepTables) {
      const r = db.prepare(`DELETE FROM ${table} WHERE agent_group_id = ?`).run(plan.agentGroupId);
      if (r.changes > 0) say('sweep', `${table}: ${r.changes}`);
    }

    // 7. The group itself.
    const g = db.prepare('DELETE FROM agent_groups WHERE id = ?').run(plan.agentGroupId);
    say('delete-agent-group', `agent_groups: ${g.changes}`);
  });
  tx();

  // 8. Filesystem. Re-derive and re-guard every path.
  for (const dir of plan.directories) {
    if (!fs.existsSync(dir)) continue;
    const parent = path.dirname(dir);
    const name = path.basename(dir);
    if (parent === path.resolve(sessionsRoot(env))) {
      if (name !== plan.agentGroupId) {
        warnings.push(`skipped ${dir}: not this group's session directory`);
        continue;
      }
      assertSafePath(dir, sessionsRoot(env), plan.agentGroupId);
    } else if (parent === path.resolve(env.groupsDir)) {
      if (!plan.folder || name !== plan.folder) {
        warnings.push(`skipped ${dir}: not this group's folder`);
        continue;
      }
      assertSafePath(dir, env.groupsDir, plan.folder);
    } else {
      warnings.push(`skipped ${dir}: outside groups/ and data/v2-sessions/`);
      continue;
    }
    const res = removeDirectory(env, dir);
    if (res.ok) say('remove-directory', `${dir}${res.usedContainer ? ' (via throwaway container)' : ''}`);
    else warnings.push(`could not remove ${dir}: ${res.error}`);
  }

  // 9. Per-group image tags.
  for (const tag of plan.imageTags) {
    const res = env.exec('docker', ['rmi', tag]);
    if (res.ok) say('remove-image', tag);
    else warnings.push(`docker rmi ${tag} failed: ${res.stderr.trim()}`);
  }

  // 10. OneCLI vault agent. Removes the agent and its secret ASSIGNMENTS —
  //     shared vault secrets themselves survive.
  if (plan.onecliAgent) {
    const res = env.exec('onecli', ['agents', 'delete', '--id', plan.onecliAgent.id]);
    if (res.ok) say('delete-onecli-agent', `${plan.onecliAgent.identifier} (${plan.onecliAgent.id})`);
    else warnings.push(`onecli agents delete failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }

  return { steps, warnings };
}

/**
 * `rm -rf` a directory, falling back to a throwaway container when Docker
 * left root-owned bind-mount stubs behind (`extra/<name>`, `group/`, …).
 *
 * The fallback fires only on EACCES/EPERM — it is not the normal path. `sudo`
 * is not an option (needs an interactive password), so we mount the directory
 * into `alpine:3` as uid 0, empty it from the inside, then `rmdir` the now
 * empty mount point from the host.
 */
export function removeDirectory(
  env: TeardownEnv,
  dir: string,
): { ok: boolean; usedContainer: boolean; error?: string } {
  try {
    fs.rmSync(dir, { recursive: true });
    return { ok: true, usedContainer: false };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM' && code !== 'ENOTEMPTY') {
      return { ok: false, usedContainer: false, error: `${code}: ${(err as Error).message}` };
    }
  }
  // Root-owned leftovers — empty from inside a container running as uid 0.
  const res = env.exec('docker', [
    'run',
    '--rm',
    '-v',
    `${dir}:/target`,
    'alpine:3',
    'sh',
    '-c',
    'find /target -mindepth 1 -delete',
  ]);
  if (!res.ok) {
    return { ok: false, usedContainer: true, error: `container cleanup failed: ${res.stderr.trim()}` };
  }
  try {
    fs.rmdirSync(dir);
  } catch (err) {
    return { ok: false, usedContainer: true, error: (err as Error).message };
  }
  return { ok: true, usedContainer: true };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function renderPlan(plan: TeardownPlan): string {
  const out: string[] = [];
  const h = (s: string) => out.push('', s, '─'.repeat(s.length));
  const bullet = (s: string) => out.push(`  ${s}`);
  const none = () => out.push('  (none)');

  out.push(`Agent group : ${plan.name ?? '(row already deleted)'}`);
  out.push(`Id          : ${plan.agentGroupId}`);
  out.push(`Folder      : ${plan.folder ?? '(unknown)'}`);
  if (plan.residual) out.push('Mode        : residual cleanup (no agent_groups row)');

  h('WILL STOP — running containers');
  plan.containers.length ? plan.containers.forEach(bullet) : none();

  h('WILL DELETE — central DB (data/v2.db), in this order');
  bullet(`1. messaging_group_agents (wiring): ${plan.wirings.length}`);
  const blockerLines = plan.sessionBlockers.filter((b) => b.count > 0);
  bullet(
    `2. session-scoped blockers: ${blockerLines.length ? blockerLines.map((b) => `${b.table}=${b.count}`).join(', ') : 'none'}` +
      `  [checked: ${plan.sessionBlockers.map((b) => b.table).join(', ') || 'none'}]`,
  );
  bullet(`3. sessions: ${plan.sessionIds.length}`);
  bullet(`4. agent_destinations pointing AT this group from other groups: ${plan.inboundDestinations.length}`);
  for (const e of plan.inboundDestinations) bullet(`     ${e.agent_group_id} calls it "${e.local_name}"`);
  bullet('5. sweep of every table carrying agent_group_id:');
  for (const r of plan.rowCounts) {
    if (r.count > 0) bullet(`     ${r.table}: ${r.count}${r.cascades ? ' (would cascade anyway)' : ''}`);
  }
  bullet('6. agent_groups: 1');

  h('WILL DELETE — filesystem');
  plan.directories.length ? plan.directories.forEach(bullet) : none();

  h('WILL DELETE — docker images');
  plan.imageTags.length ? plan.imageTags.forEach(bullet) : none();

  h('WILL DELETE — OneCLI vault agent');
  if (plan.onecliAgent) {
    bullet(`${plan.onecliAgent.name} — identifier ${plan.onecliAgent.identifier} (id ${plan.onecliAgent.id})`);
    bullet('removes the agent and its secret assignments; shared vault secrets survive');
  } else none();

  h('REPORT ONLY — stale per-session destination mirrors');
  if (plan.staleMirrors.length) {
    for (const m of plan.staleMirrors) bullet(`${m.path} → destinations."${m.name}"`);
    bullet('not rewritten on purpose: spawnContainer calls writeDestinations →');
    bullet('replaceDestinations (DELETE + re-insert) on every wake, so these self-heal.');
  } else none();

  h('REPORT ONLY — prose references in surviving groups');
  if (plan.proseReferences.length) {
    for (const r of plan.proseReferences) bullet(`${r.file}:${r.line}  [${r.term}]  ${r.text}`);
  } else none();

  h('REPORT ONLY — orphaned messaging groups');
  if (plan.orphans.messagingGroups.length) {
    for (const m of plan.orphans.messagingGroups) {
      bullet(`${m.id} (${m.name ?? 'unnamed'} / ${m.channel_type}) — ${m.reason}`);
    }
  } else none();

  h('REPORT ONLY — orphaned session directories');
  if (plan.orphans.sessionDirs.length) {
    for (const d of plan.orphans.sessionDirs) bullet(`${d.path} — ${d.reason}`);
  } else none();

  if (plan.warnings.length) {
    h('WARNINGS');
    plan.warnings.forEach(bullet);
  }

  return out.join('\n');
}
