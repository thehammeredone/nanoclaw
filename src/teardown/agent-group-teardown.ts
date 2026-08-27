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
 *    Once the row IS gone the folder is unrecoverable from the DB, so in
 *    residual mode an operator-supplied `--folder` supplements `--id` — put
 *    through the same `assertSafePath` guard as any DB-derived value, AND
 *    checked against `agent_groups` for a surviving owner (the path guard only
 *    proves the name is shaped safely, not that nothing else still owns it — a
 *    typo must not be able to point removal at a live group's directory).
 *    Without a usable `--folder`, `groups/<folder>/` can never be removed and
 *    the run is incomplete.
 *  - **Every directory removal is keyed on the exact target id.** Removing a
 *    surviving group's session directory would be unrecoverable, so each path
 *    is re-derived from the target id/folder and re-checked against its root
 *    immediately before `rm`. The *plan* applies the same guard, so a path the
 *    executor would refuse is shown as refused rather than as `WILL DELETE`.
 *  - **Never hardcode `docker`.** Every shell-out uses `CONTAINER_RUNTIME_BIN`
 *    from `src/container-runtime.ts`, so swapping runtimes (the
 *    `/convert-to-apple-container` skill rewrites that one file) stays a
 *    one-file change. We call `env.exec(CONTAINER_RUNTIME_BIN, …)` rather than
 *    that module's `stopContainer()` helper for three reasons: teardown has to
 *    turn a failed stop into a reported warning, and `stopContainer` throws
 *    instead of returning a result; `stopContainer` hardcodes `-t 1` where
 *    teardown deliberately uses `-t 5` so a container gets a chance to flush
 *    its outbound DB; and `env.exec` is the injection point that keeps tests
 *    from ever shelling out.
 *  - **A failed discovery is not an empty result.** If the runtime binary or
 *    `onecli` is missing or errors, `WILL STOP — (none)` / `WILL DELETE —
 *    docker images (none)` / `WILL DELETE — OneCLI vault agent (none)` would
 *    read as "nothing exists" when the truth is "could not check", and the
 *    operator would approve deleting rows and directories out from under a
 *    live container, or leave a vault agent still holding injectable
 *    credentials for a group that no longer exists. Discovery failure is
 *    surfaced as `(COULD NOT CHECK)` for containers, images AND the OneCLI
 *    agent, and all three are counted in `collectIncomplete` so the exit code
 *    reflects it too. This includes an exec that *succeeds* but returns
 *    output that cannot be parsed or is not the expected shape. For
 *    `findOnecliAgent` (TASK-29, round 2) that means a `JSON.parse` failure, a
 *    well-formed-but-unexpected value (a bare array, a scalar, `null`,
 *    `{"data":{}}`), and an exec failure are all treated the same way, because
 *    each reaches the same dangerous end state behind exit 0: a live vault
 *    agent reported as `(none)`. `findImageTags` and `findContainers` share
 *    the same underlying risk one level down: a runtime that ignores
 *    `--format` and exits 0 with something else entirely — a human-readable
 *    table, OR (TASK-30 round 2) compact JSON, which is at least as likely a
 *    fallback shape: `origin/skill/apple-container` rewrites orphan cleanup
 *    to `container ls --format json` + `JSON.parse`, i.e. that runtime's
 *    `--format` flag takes `json|table`, not a Go template. Every line of
 *    either shape then fails the exact-tag-membership check (`findImageTags`)
 *    or the `^nanoclaw-v2-<folder>-\d+$` regex (`findContainers`), which is
 *    indistinguishable from "checked, nothing found" — the same silent-(none)-
 *    behind-exit-0 shape as the onecli case, reached through a malformed
 *    *shape* instead of a parse exception. A negative check keyed on internal
 *    whitespace (the round-1 fix) only catches the table shape — compact JSON
 *    and an unpadded single-column header are both whitespace-free and sail
 *    straight through it. Both filters instead validate the POSITIVE shape a
 *    valid line must have — `CONTAINER_NAME_RE` / `IMAGE_REF_RE`, applied via
 *    the shared `splitTemplateLines` — before the match/membership step; any
 *    line that fails is treated exactly like a discovery failure
 *    (`unknown: true`), never filtered out or merely logged. See their
 *    docstrings for why an output-form sanity check was used instead of a
 *    runtime capability probe.
 *
 * See `docs/runbooks/agent-group-teardown.md` for the operator-facing runbook
 * and the full deletion order with FK evidence.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { CONTAINER_RUNTIME_BIN } from '../container-runtime.js';
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
  /**
   * True when container discovery could not run (runtime binary missing or
   * erroring). `containers` is then "unknown", NOT "none" — see the header.
   */
  containersUnknown: boolean;
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
  /**
   * Candidate directories the path guard refused at plan time. The executor
   * refuses them too — they are listed so the plan an operator approves never
   * over-promises.
   */
  refusedDirectories: { path: string; reason: string }[];
  /** Docker image tags to remove. */
  imageTags: string[];
  /**
   * True when image-tag discovery could not run (runtime binary erroring).
   * `imageTags` is then "unknown", NOT "none" — see the module header.
   */
  imagesUnknown: boolean;
  /** OneCLI vault agent to delete, if found. */
  onecliAgent: { id: string; name: string; identifier: string } | null;
  /**
   * True when OneCLI discovery did not produce a usable answer — `onecli agents
   * list` erroring, OR exiting 0 with output that cannot be parsed or is not
   * the expected shape. `onecliAgent` is then "unknown", NOT "none" — see the
   * module header.
   */
  onecliUnknown: boolean;
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
 * Instruction files belonging to one surviving group: top-level `CLAUDE*.md`
 * plus each per-group skill's `SKILL.md`.
 *
 * Deliberately bounded to two known shapes — `groups/<folder>/CLAUDE*.md` and
 * `groups/<folder>/skills/<skill>/SKILL.md`. A recursive walk of the group
 * directory would drag in workspaces, caches and checked-out repos.
 */
function instructionFiles(groupDir: string): string[] {
  const files: string[] = [];
  try {
    for (const f of fs.readdirSync(groupDir).sort()) {
      if (/^CLAUDE.*\.md$/i.test(f)) files.push(path.join(groupDir, f));
    }
  } catch {
    return files;
  }
  // Per-group skills are group instructions too — a "querying <group> is
  // mandatory" line in a SKILL.md outlives the group just as readily.
  for (const skill of listDirs(path.join(groupDir, 'skills'))) {
    const skillMd = path.join(groupDir, 'skills', skill, 'SKILL.md');
    if (fs.existsSync(skillMd)) files.push(skillMd);
  }
  return files;
}

/**
 * Grep surviving groups' instruction files (`CLAUDE*.md` and each per-group
 * `skills/<name>/SKILL.md`) for the deleted group's name and for the
 * `local_name`s by which each surviving group refers to it.
 *
 * This is the check that catches instructions like "querying <group> is
 * mandatory" left behind in another agent's CLAUDE.md or skill.
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

    for (const full of instructionFiles(path.join(env.groupsDir, folder))) {
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

/**
 * Split `--format` stdout into trimmed, non-blank lines. `.trim()` strips a
 * trailing `\r` too, so CRLF output from a Windows-flavoured runtime is
 * handled the same as `\n`. Shared by `findContainers` and `findImageTags` so
 * the split/trim/blank-filter step can never drift out of lockstep between
 * them — the per-call-site shape check that runs over the result stays
 * distinct (see `CONTAINER_NAME_RE` / `IMAGE_REF_RE`), because container
 * names and image references are not the same shape.
 */
function splitTemplateLines(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Shape of a single `{{.Names}}` token: starts with an alphanumeric,
 * followed by alphanumeric, `.`, `_`, `/`, `@`, or `-`.
 */
const CONTAINER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/@-]*$/;

/**
 * Shape of a single `{{.Repository}}:{{.Tag}}` token: a whitespace-free
 * repository (whose first `/`-separated component may carry a `:port`)
 * joined to a `:`-free tag by the final `:`. Passes `<none>:<none>`,
 * registry-qualified refs (`ghcr.io/org/img:tag`) and refs against a
 * registry with an explicit port (`localhost:5000/org/img:tag`).
 */
const IMAGE_REF_RE = /^[^\s:]+(?::\d+)?(?:\/[^\s:]+)*:[^\s:]+$/;

/**
 * Running container names belonging to this group. `nanoclaw-v2-<folder>-<ts>`.
 *
 * `unknown: true` means discovery did not run — no folder to match against,
 * the runtime binary failed, OR it exited 0 with a line that does not match
 * the container-name token shape (`CONTAINER_NAME_RE`) — a table row/header,
 * compact JSON, or anything else instead of a bare name. It must never be
 * presented as "nothing running".
 */
export function findContainers(
  env: TeardownEnv,
  folder: string | null,
): { names: string[]; unknown: boolean; warnings: string[] } {
  if (!folder) {
    return {
      names: [],
      unknown: true,
      warnings: [
        'folder unknown — container discovery skipped. Running containers for this group are NOT stopped. ' +
          'Re-run with --folder <name> if this group may still have a container up.',
      ],
    };
  }
  const res = env.exec(CONTAINER_RUNTIME_BIN, [
    'ps',
    '--filter',
    `label=${env.containerInstallLabel}`,
    '--format',
    '{{.Names}}',
  ]);
  if (!res.ok) {
    return {
      names: [],
      unknown: true,
      warnings: [`${CONTAINER_RUNTIME_BIN} ps failed: ${res.stderr.trim() || 'unknown error'}`],
    };
  }
  const lines = splitTemplateLines(res.stdout);
  const garbage = lines.find((l) => !CONTAINER_NAME_RE.test(l));
  if (garbage !== undefined) {
    return {
      names: [],
      unknown: true,
      warnings: [
        `${CONTAINER_RUNTIME_BIN} ps --format output does not look like the requested template ` +
          `(line does not look like a container name: ${JSON.stringify(garbage)}) — the runtime may be ignoring ` +
          '--format and printing something else (a table, JSON, …) instead. Running containers for this group ' +
          'are NOT confirmed stopped.',
      ],
    };
  }
  const re = new RegExp(`^nanoclaw-v2-${escapeRegExp(folder)}-\\d+$`);
  return {
    names: lines.filter((n) => re.test(n)),
    unknown: false,
    warnings: [],
  };
}

/**
 * Per-group image tags: `<base>:<agent-group-id>`, plus whatever the config records.
 *
 * `unknown: true` means discovery did not run — the runtime binary failed, OR
 * it exited 0 with a line that does not match the `repo:tag` token shape
 * (`IMAGE_REF_RE`). It must never be presented as "no image tag exists" —
 * see the module header.
 *
 * TASK-29 audited this for a parse-vs-exec gap (`findOnecliAgent`'s
 * `JSON.parse` failure mode) and found none: `--format
 * '{{.Repository}}:{{.Tag}}'` output is plain newline-delimited text, and
 * split/trim/filter into a Set of raw strings cannot throw the way
 * `JSON.parse` can. TASK-30 found the gap that check missed: a runtime that
 * ignores `--format` entirely and exits 0 with something else — a human
 * table, OR compact JSON, OR an unpadded single-column header — needs no
 * exception to reach the same dangerous end state — every such line simply
 * fails the exact-membership check below and reads as "no tag exists",
 * exactly as garbage would in `findContainers`. Guarded the same way: reject
 * before the membership check if any non-blank line does not itself look
 * like a `repo:tag` token (`IMAGE_REF_RE`) — a POSITIVE shape check, not a
 * negative one keyed on whitespace, because a JSON line or a bare
 * single-word header is whitespace-free and would sail through that.
 */
export function findImageTags(
  env: TeardownEnv,
  agentGroupId: string,
  configImageTag: string | null,
): { tags: string[]; unknown: boolean; warnings: string[] } {
  const res = env.exec(CONTAINER_RUNTIME_BIN, ['images', '--format', '{{.Repository}}:{{.Tag}}']);
  if (!res.ok) {
    return {
      tags: [],
      unknown: true,
      warnings: [`${CONTAINER_RUNTIME_BIN} images failed: ${res.stderr.trim() || 'unknown error'}`],
    };
  }
  const lines = splitTemplateLines(res.stdout);
  const garbage = lines.find((l) => !IMAGE_REF_RE.test(l));
  if (garbage !== undefined) {
    return {
      tags: [],
      unknown: true,
      warnings: [
        `${CONTAINER_RUNTIME_BIN} images --format output does not look like the requested template ` +
          `(line does not look like a repo:tag reference: ${JSON.stringify(garbage)}) — the runtime may be ` +
          "ignoring --format and printing something else (a table, JSON, …) instead. This group's image tag " +
          'is NOT confirmed absent.',
      ],
    };
  }
  const existing = new Set(lines);
  const candidates = new Set<string>([`${env.containerImageBase}:${agentGroupId}`]);
  // Only ever consider a config-recorded tag when it is unambiguously ours.
  if (configImageTag && configImageTag.endsWith(`:${agentGroupId}`)) candidates.add(configImageTag);
  return { tags: [...candidates].filter((t) => existing.has(t)), unknown: false, warnings: [] };
}

/** OneCLI identifier for a group: the id, `ag-`-prefixed when it starts with a digit. */
export function onecliIdentifier(agentGroupId: string): string {
  return /^[a-z]/i.test(agentGroupId) ? agentGroupId : `ag-${agentGroupId}`;
}

/**
 * `unknown: true` means discovery did not run to a trustworthy result — the
 * `onecli agents list` call itself failed, OR it exited 0 with output
 * `JSON.parse` cannot handle, OR it exited 0 with valid JSON that is not the
 * expected `{ data: [...] }` shape (e.g. a bare array, a scalar, `null`, or
 * `{ data: {} }`), OR (TASK-31) `data` is an array but contains a non-object
 * element, OR (TASK-31) the element that matches this group's identifier is
 * missing `id`. All of these must never be presented as "no vault agent
 * exists" — see the module header. Treating any of them as `unknown: false`
 * (or letting a shape mismatch throw out of `findOnecliAgent` uncaught, or
 * letting a match with no `id` drive a delete call with an `undefined` id)
 * is the exact residual TASK-14/TASK-29/TASK-31 review findings identified:
 * a live vault agent still holding injectable credentials for a deleted
 * group, behind exit 0 (or an uncaught exception mis-surfaced as exit 1) —
 * reached through a parse failure, a top-level shape mismatch, or (TASK-31)
 * a per-element shape mismatch, instead of an exec failure. A malformed
 * element that does NOT match this group's identifier is a different,
 * lower-stakes situation — see the comment at the `match.id` check below for
 * why only the target's own element poisons the result.
 */
export function findOnecliAgent(
  env: TeardownEnv,
  agentGroupId: string,
): { agent: { id: string; name: string; identifier: string } | null; unknown: boolean; warnings: string[] } {
  const res = env.exec('onecli', ['agents', 'list']);
  if (!res.ok) {
    return {
      agent: null,
      unknown: true,
      warnings: [`onecli agents list failed: ${res.stderr.trim() || 'unknown error'}`],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch (err) {
    return {
      agent: null,
      unknown: true,
      warnings: [`could not parse onecli agents list: ${(err as Error).message}`],
    };
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { data?: unknown }).data)) {
    return {
      agent: null,
      unknown: true,
      warnings: ['unexpected onecli agents list shape: expected an object with a "data" array'],
    };
  }
  const rawData = (parsed as { data: unknown[] }).data;
  // TASK-31: the top-level guard above only proves `data` is an array — its
  // elements are still untrusted. A `null`/scalar element throws out of the
  // `.find` predicate below (`a.identifier` on `null`) or silently reads as
  // "not this agent" (a scalar's `.identifier` is `undefined`, no throw) —
  // either way the same silent-(none)/uncaught-exception failure mode as the
  // top-level shape gap. One such element poisons the WHOLE result here
  // (unknown:true immediately), matching the `findContainers`/`findImageTags`
  // convention above of rejecting the whole batch on one garbage line: a
  // non-object element means the response itself is malformed, not just one
  // record, so nothing in it can be trusted enough to search through.
  const badElement = rawData.find((a) => a === null || typeof a !== 'object' || Array.isArray(a));
  if (badElement !== undefined) {
    return {
      agent: null,
      unknown: true,
      warnings: [`unexpected onecli agents list element shape: expected an object, got ${JSON.stringify(badElement)}`],
    };
  }
  const data = rawData as { id?: string; name?: string; identifier?: string; isDefault?: boolean }[];
  const wanted = onecliIdentifier(agentGroupId);
  const match = data.find((a) => a.identifier === wanted || a.identifier === agentGroupId);
  if (!match) return { agent: null, unknown: false, warnings: [] };
  if (match.isDefault) {
    return {
      agent: null,
      unknown: false,
      warnings: [`refusing to touch the OneCLI default agent (${match.identifier})`],
    };
  }
  if (!match.id) {
    // The matched element genuinely IS this group's vault agent (its
    // `identifier` matched) but is missing `id` — discovery failed for THIS
    // specific agent, not for some unrelated record. Two possible outs here
    // (AC#2): unknown:true, or skip-with-warning. Skipping would let
    // `collectIncomplete` see `onecliAgent: null` and report a clean
    // teardown while a live vault agent — still holding injectable
    // credentials — survives untouched. That's exactly the silent "(none)"
    // failure mode this module exists against, and it would also mean never
    // issuing a delete call with an `undefined` id (AC#2's other
    // requirement) by construction. So: unknown:true, not skip.
    return {
      agent: null,
      unknown: true,
      warnings: [`onecli agents list entry for "${match.identifier}" is missing "id" — cannot safely delete it`],
    };
  }
  // A malformed element for a DIFFERENT agent (no "id", wrong/missing
  // "identifier") never reaches here — it fails the `match` comparison above
  // and is otherwise ignored, same as any other non-matching row. Poisoning
  // this group's teardown over another agent's bad record would be a
  // disproportionate blast radius for data this call never touches.
  // Deliberately drop every other field — `agents list` includes accessToken.
  return {
    agent: { id: match.id, name: match.name ?? '', identifier: match.identifier ?? wanted },
    unknown: false,
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface PlanOptions {
  agentGroupId?: string;
  /**
   * Resolves the group when `agentGroupId` is absent. When `agentGroupId` is
   * given AND its row still exists the DB is authoritative and this is
   * ignored; in residual mode (row already deleted) it is the only way to
   * recover the folder, so it supplements `agentGroupId` there.
   */
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
    // Folder resolution must happen while the row still exists. A resumed run
    // passes --id; it may pass --folder as well, which is picked up below.
    row = db.prepare('SELECT id, name, folder FROM agent_groups WHERE folder = ?').get(opts.folder) as typeof row;
  }
  if (!row && !opts.agentGroupId) {
    throw new Error(
      `no agent group with folder "${opts.folder}". Re-run with --id <agent-group-id> to clean up residual state.`,
    );
  }

  const agentGroupId = row?.id ?? (opts.agentGroupId as string);
  let folder = row?.folder ?? null;
  const residual = !row;
  if (residual) {
    warnings.push(
      `no agent_groups row for ${agentGroupId} — residual mode: DB sweep, directories, image and OneCLI agent only.`,
    );
    // The row that carried the folder is gone, so a resumed run can only learn
    // it from the operator. `--folder` supplements `--id` here (it is ignored
    // when the row still exists — the DB is authoritative then), and it goes
    // through exactly the same path guard as every DB-derived folder value.
    if (opts.folder) {
      try {
        assertSafePath(path.join(env.groupsDir, opts.folder), env.groupsDir, opts.folder);
        // The path guard only proves the folder name is shaped safely — it says
        // nothing about who owns it. A residual --id paired with a live group's
        // folder (e.g. a typo) must not be allowed to point removal at that
        // group's directory. The DB is already open and has the answer.
        const owner = db.prepare('SELECT id FROM agent_groups WHERE folder = ?').get(opts.folder) as
          | { id: string }
          | undefined;
        if (owner) {
          warnings.push(
            `ignoring --folder ${JSON.stringify(opts.folder)}: it belongs to surviving agent group ${owner.id}. ` +
              `Refusing to remove another group's directory.`,
          );
        } else {
          folder = opts.folder;
          warnings.push(`using operator-supplied --folder ${JSON.stringify(opts.folder)} for residual cleanup.`);
        }
      } catch (err) {
        warnings.push(`ignoring --folder ${JSON.stringify(opts.folder)}: ${(err as Error).message}`);
      }
    }
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

  // Inbound destination edges from OTHER groups (target_id has no FK).
  // `target_id` is polymorphic — a messaging group id OR an agent group id,
  // per `target_type` — so it is only meaningful together with its type
  // filter. Matches `getDestinationReferencers`
  // (`src/modules/agent-to-agent/db/agent-destinations.ts`), and lets
  // `idx_agent_dest_target` be used.
  const inboundDestinations = hasTable(db, 'agent_destinations')
    ? (db
        .prepare(
          `SELECT agent_group_id, local_name, target_type, target_id
             FROM agent_destinations
            WHERE target_type = 'agent' AND target_id = ? AND agent_group_id != ?`,
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

  // Directories — always derived from the target id / folder, never from a
  // scan, and put through the SAME guard the executor applies so the plan can
  // never promise a removal that execution will refuse.
  const directories: string[] = [];
  const refusedDirectories: { path: string; reason: string }[] = [];
  const considerDir = (dir: string, root: string, expectedName: string): void => {
    try {
      assertSafePath(dir, root, expectedName);
    } catch (err) {
      refusedDirectories.push({ path: dir, reason: (err as Error).message });
      return;
    }
    if (fs.existsSync(dir)) directories.push(dir);
  };
  if (folder) {
    considerDir(path.join(env.groupsDir, folder), env.groupsDir, folder);
  } else if (residual) {
    warnings.push(
      'folder unknown (row already deleted) — groups/<folder>/ will NOT be removed. ' +
        'Re-run with --id <id> --folder <name> to finish it.',
    );
  }
  considerDir(path.join(sessionsRoot(env), agentGroupId), sessionsRoot(env), agentGroupId);

  // Images
  let imageTags: string[] = [];
  let imagesUnknown = false;
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
    imagesUnknown = imgRes.unknown;
    warnings.push(...imgRes.warnings);
  }

  // OneCLI
  let onecliAgent: TeardownPlan['onecliAgent'] = null;
  let onecliUnknown = false;
  if (!opts.keepOnecli) {
    const oneRes = findOnecliAgent(env, agentGroupId);
    onecliAgent = oneRes.agent;
    onecliUnknown = oneRes.unknown;
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
    containersUnknown: containersRes.unknown,
    wirings,
    sessionIds,
    sessionBlockers,
    inboundDestinations,
    staleMirrors: mirrorsRes.mirrors,
    rowCounts,
    directories,
    refusedDirectories,
    imageTags,
    imagesUnknown,
    onecliAgent,
    onecliUnknown,
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
  /**
   * Destructive steps that were attempted and failed. Non-empty means the
   * teardown did NOT finish — callers must not report success. `warnings` is
   * the superset (it also carries advisory notes); this is the exit-code
   * signal.
   */
  failures: { step: string; detail: string }[];
}

/**
 * Execute a plan. Ordering is load-bearing — see the runbook. Every step is
 * idempotent, so a partial run can simply be re-run.
 */
export function executeTeardown(db: Database.Database, env: TeardownEnv, plan: TeardownPlan): ExecuteResult {
  const steps: { step: string; detail: string }[] = [];
  const warnings: string[] = [];
  const failures: { step: string; detail: string }[] = [];
  const say = (step: string, detail: string) => steps.push({ step, detail });
  const fail = (step: string, detail: string) => {
    failures.push({ step, detail });
    warnings.push(detail);
  };

  // 0. Discovery that could not run is not discovery that found nothing.
  if (plan.containersUnknown) {
    warnings.push(
      'proceeding without knowing whether containers are running — see the plan WARNINGS. ' +
        'A live container may still be writing to the session directories removed below.',
    );
  }

  // 1. Stop running containers before the rows they depend on disappear.
  for (const name of plan.containers) {
    const res = env.exec(CONTAINER_RUNTIME_BIN, ['stop', '-t', '5', name]);
    if (res.ok) say('stop-container', name);
    else fail('stop-container', `${CONTAINER_RUNTIME_BIN} stop ${name} failed: ${res.stderr.trim()}`);
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
    //    `target_id` is polymorphic, so the delete carries the `target_type`
    //    filter its meaning depends on.
    if (hasTable(db, 'agent_destinations')) {
      const d = db
        .prepare("DELETE FROM agent_destinations WHERE target_type = 'agent' AND target_id = ? AND agent_group_id != ?")
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

  // 8. Filesystem. Re-derive and re-guard every path. `planTeardown` applied
  //    the same guard, so anything refused here is already reported as refused
  //    in the plan — this is defence in depth, not the first check.
  for (const dir of plan.directories) {
    if (!fs.existsSync(dir)) continue;
    const parent = path.dirname(dir);
    const name = path.basename(dir);
    if (parent === path.resolve(sessionsRoot(env))) {
      if (name !== plan.agentGroupId) {
        fail('remove-directory', `skipped ${dir}: not this group's session directory`);
        continue;
      }
      assertSafePath(dir, sessionsRoot(env), plan.agentGroupId);
    } else if (parent === path.resolve(env.groupsDir)) {
      if (!plan.folder || name !== plan.folder) {
        fail('remove-directory', `skipped ${dir}: not this group's folder`);
        continue;
      }
      assertSafePath(dir, env.groupsDir, plan.folder);
    } else {
      fail('remove-directory', `skipped ${dir}: outside groups/ and data/v2-sessions/`);
      continue;
    }
    const res = removeDirectory(env, dir);
    if (res.ok) say('remove-directory', `${dir}${res.usedContainer ? ' (via throwaway container)' : ''}`);
    else fail('remove-directory', `could not remove ${dir}: ${res.error}`);
  }

  // 9. Per-group image tags.
  for (const tag of plan.imageTags) {
    const res = env.exec(CONTAINER_RUNTIME_BIN, ['rmi', tag]);
    if (res.ok) say('remove-image', tag);
    else fail('remove-image', `${CONTAINER_RUNTIME_BIN} rmi ${tag} failed: ${res.stderr.trim()}`);
  }

  // 10. OneCLI vault agent. Removes the agent and its secret ASSIGNMENTS —
  //     shared vault secrets themselves survive. Leaving it behind means a
  //     vault agent still holding injectable credentials for a group that no
  //     longer exists, so a failure here is a failure of the teardown.
  if (plan.onecliAgent) {
    const res = env.exec('onecli', ['agents', 'delete', '--id', plan.onecliAgent.id]);
    if (res.ok) say('delete-onecli-agent', `${plan.onecliAgent.identifier} (${plan.onecliAgent.id})`);
    else fail('delete-onecli-agent', `onecli agents delete failed: ${res.stderr.trim() || res.stdout.trim()}`);
  }

  return { steps, warnings, failures };
}

/**
 * Everything a run left undone, as operator-readable lines.
 *
 * Empty means the teardown finished; non-empty means a caller MUST exit
 * non-zero. The DB half is transactional, but the steps after it are not, and a
 * run that left `groups/<folder>/` on disk or an OneCLI vault agent alive has
 * not torn the group down — reporting that as success is how a group becomes
 * permanently un-cleanable while a vault agent keeps holding injectable
 * credentials for it.
 */
export function collectIncomplete(plan: TeardownPlan, result: ExecuteResult): string[] {
  const out = [
    ...result.failures.map((f) => `${f.step}: ${f.detail}`),
    ...plan.refusedDirectories.map((d) => `remove-directory: refused ${d.path} — ${d.reason}`),
  ];
  if (plan.residual && !plan.folder) {
    out.push(
      `remove-directory: groups/<folder>/ was NOT removed — the agent_groups row is gone, so the folder ` +
        `could not be resolved. Re-run with: --id ${plan.agentGroupId} --folder <name> --yes`,
    );
  }
  // A failed discovery is not an empty result — see the module header. If we
  // never learned whether containers/images/a vault agent exist, the run is
  // not complete, even though nothing was "attempted and failed" in the usual
  // sense. Without this, a run with every binary unavailable exits 0 while a
  // vault agent still holds injectable credentials for a deleted group.
  if (plan.containersUnknown) {
    out.push(
      `stop-container: could not determine whether containers are running for this group — see WARNINGS. ` +
        `A live container may still be up.`,
    );
  }
  if (plan.imagesUnknown) {
    out.push(`remove-image: could not check for this group's image tag — see WARNINGS. It may still exist.`);
  }
  if (plan.onecliUnknown) {
    out.push(
      `delete-onecli-agent: could not check the OneCLI vault for this group's agent — see WARNINGS. ` +
        `A vault agent may still hold injectable credentials for this group.`,
    );
  }
  return out;
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
    // `force` swallows ENOENT only. It closes the existsSync/rmSync race in
    // the caller and stops an entry that vanishes mid-walk (a dangling symlink,
    // a container tidying up) from short-circuiting to `{ok: false}` — ENOENT
    // is not one of the codes the container fallback below handles.
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true, usedContainer: false };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM' && code !== 'ENOTEMPTY') {
      return { ok: false, usedContainer: false, error: `${code}: ${(err as Error).message}` };
    }
  }
  // Root-owned leftovers — empty from inside a container running as uid 0.
  // Uses the configured runtime binary like every other shell-out here.
  const res = env.exec(CONTAINER_RUNTIME_BIN, [
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
  if (plan.containers.length) plan.containers.forEach(bullet);
  else if (plan.containersUnknown) {
    // Never render a failed check as "(none)" — see the module header.
    bullet('(COULD NOT CHECK — see WARNINGS. Containers may still be running.)');
  } else none();

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

  if (plan.refusedDirectories.length) {
    h('REFUSED — filesystem (path guard); execution will skip these too');
    for (const d of plan.refusedDirectories) bullet(`${d.path} — ${d.reason}`);
  }

  h('WILL DELETE — docker images');
  if (plan.imageTags.length) plan.imageTags.forEach(bullet);
  else if (plan.imagesUnknown) {
    // Never render a failed check as "(none)" — see the module header.
    bullet('(COULD NOT CHECK — see WARNINGS. An image tag may still exist.)');
  } else none();

  h('WILL DELETE — OneCLI vault agent');
  if (plan.onecliAgent) {
    bullet(`${plan.onecliAgent.name} — identifier ${plan.onecliAgent.identifier} (id ${plan.onecliAgent.id})`);
    bullet('removes the agent and its secret assignments; shared vault secrets survive');
  } else if (plan.onecliUnknown) {
    // Never render a failed check as "(none)" — see the module header.
    bullet('(COULD NOT CHECK — see WARNINGS. A vault agent may still exist, still holding injectable credentials.)');
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
