import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BOOTSTRAP_SCRIPT_PATH,
  collapseBootstrapScript,
  skylightBootstrapLine,
} from './skylight-mcp-bootstrap.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNBOOK = path.join(REPO_ROOT, 'docs/runbooks/aurora-skylight-mcp.md');
const CENTRAL_DB = path.join(REPO_ROOT, 'data/v2.db');

/**
 * The live-DB comparison below is the only assertion in this file that
 * reaches outside the repo tree. `data/v2.db` is the *live* Aurora
 * database — an operator can legitimately live-patch
 * `container_configs.mcp_servers` mid-incident (see
 * docs/runbooks/matrix-homeserver-resume.md, "PIP_CERT ... via
 * `ncl groups config add-mcp-server`"), which would otherwise turn every
 * *unrelated* `pnpm test` run red until someone remembers to re-run the
 * seeder. Gate it behind an explicit opt-in so the default `pnpm test` is
 * hermetic; documented in docs/runbooks/aurora-skylight-mcp.md.
 */
const LIVE_DB_CHECK_ENABLED = process.env.SKYLIGHT_LIVE_DB_CHECK === '1';

/** Directories that could plausibly hold a hand-copied duplicate of the line. */
const SCANNED_DIRS = ['scripts', 'src', 'docs', 'backlog', 'container', 'setup'];
const SCANNED_EXTS = new Set(['.md', '.ts', '.js', '.sh', '.json', '.txt', '.yaml', '.yml']);
/**
 * Paths (relative to REPO_ROOT, forward-slash) exempt from the "no stale
 * copy" scan below. `docs/work-records/` is where the `/work-record` skill
 * writes session write-ups; a legitimate incident report quoting this line
 * verbatim is not a hand-synced second copy and shouldn't redden the suite.
 * Add a path here (a directory prefix or an exact file) only when a
 * duplicate hit is a genuine false positive, not to silence a real one.
 */
const SCAN_ALLOWLIST_PREFIXES = ['docs/work-records/'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SCANNED_EXTS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

/**
 * Resolve the Aurora agent group's id by folder rather than a hard-coded
 * literal — `scripts/setup-aurora-agent.ts` mints the id with
 * `generateId('ag')` and looks the group up by `folder='skylight-morning'`,
 * so a documented teardown/re-create changes the id. Returns null (skip)
 * only when the schema itself isn't present yet (fresh/un-migrated DB);
 * any other failure propagates.
 */
function resolveAuroraGroupId(db: Database.Database): string | null {
  try {
    const row = db.prepare('SELECT id FROM agent_groups WHERE folder = ?').get('skylight-morning') as
      | { id: string }
      | undefined;
    return row?.id ?? null;
  } catch (err) {
    if (err instanceof Error && /no such table/i.test(err.message)) return null;
    throw err;
  }
}

/**
 * args[1] of the `skylight` MCP server for the Aurora group.
 *
 * Returns null when there is legitimately nothing to compare against (DB
 * file absent, schema not migrated, Aurora group not seeded here,
 * container_configs row not seeded here). Throws when a row IS present but
 * is malformed — corrupt JSON, a missing `skylight` key, or a renamed
 * column — because those are exactly the TASK-27 wholesale-overwrite/schema
 * -drift failure modes that must fail loudly, not report a silent "nothing
 * to compare" green.
 */
function liveBootstrapLine(dbPath: string = CENTRAL_DB): string | null {
  if (!fs.existsSync(dbPath)) return null;

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    // DB file exists but is unusable (permissions, corrupt header, mid-write
    // lock) — nothing this test can responsibly compare against.
    return null;
  }

  try {
    const groupId = resolveAuroraGroupId(db);
    if (groupId === null) return null; // Aurora not seeded in this DB — nothing to drift against.

    const row = db
      .prepare('SELECT mcp_servers FROM container_configs WHERE agent_group_id = ?')
      .get(groupId) as { mcp_servers: string | null } | undefined;
    if (!row) return null; // container_configs row not seeded — nothing to drift against.

    if (row.mcp_servers === null) {
      throw new Error(
        'container_configs.mcp_servers is NULL for the Aurora group — row present but empty.',
      );
    }

    const servers = JSON.parse(row.mcp_servers) as Record<string, { args?: unknown }>;
    if (!('skylight' in servers)) {
      throw new Error(
        "container_configs.mcp_servers has no 'skylight' key for the Aurora group — " +
          'the MCP server is not configured at all (this is the TASK-27 wholesale-overwrite ' +
          'failure mode, not a legitimate "nothing to compare" case).',
      );
    }

    const args = servers.skylight?.args;
    if (!Array.isArray(args) || typeof args[1] !== 'string') {
      throw new Error(
        'container_configs.mcp_servers.skylight.args[1] is missing or not a string.',
      );
    }
    return args[1];
  } finally {
    db!.close();
  }
}

describe('skylight MCP bootstrap line', () => {
  it('collapses the canonical script into a single `bash -lc` argument', () => {
    const line = skylightBootstrapLine();
    expect(line.startsWith('set -u;')).toBe(true);
    expect(line.endsWith('exec "$V/bin/python" -m server')).toBe(true);
  });

  it('exists nowhere else in the repo', () => {
    // Anything reproducing the head of the line is a second copy that can drift.
    const needle = skylightBootstrapLine().slice(0, 60);
    const duplicates: string[] = [];
    for (const dir of SCANNED_DIRS) {
      const abs = path.join(REPO_ROOT, dir);
      if (!fs.existsSync(abs)) continue;
      for (const file of walk(abs)) {
        if (path.resolve(file) === path.resolve(BOOTSTRAP_SCRIPT_PATH)) continue;
        const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
        if (SCAN_ALLOWLIST_PREFIXES.some((prefix) => rel.startsWith(prefix))) continue;
        const normalized = fs.readFileSync(file, 'utf8').replace(/\s+/g, ' ');
        if (normalized.includes(needle)) duplicates.push(rel);
      }
    }
    expect(duplicates).toEqual([]);
  });

  it('is the definition the runbook points operators at', () => {
    const runbook = fs.readFileSync(RUNBOOK, 'utf8');
    expect(runbook).toContain('scripts/skylight-mcp-bootstrap.sh');
  });

  it.skipIf(!LIVE_DB_CHECK_ENABLED)(
    'matches what is actually stored in the central DB (SKYLIGHT_LIVE_DB_CHECK=1)',
    () => {
      const live = liveBootstrapLine();
      if (live === null) {
        // Fresh clone / CI: the Aurora group is not seeded here, so there is no
        // second copy that could have drifted. Nothing to compare.
        return;
      }
      expect(live).toBe(skylightBootstrapLine());
    },
  );
});

describe('collapseBootstrapScript', () => {
  it('rejects a line ending in a trailing backslash', () => {
    const raw = 'set -u;\nmkdir -p /x \\\n  || die "mkdir failed";\n';
    expect(() => collapseBootstrapScript(raw, 'fixture')).toThrow(/trailing backslash/i);
  });

  it('rejects a `#` outside a full-line comment', () => {
    const raw = 'set -u;\necho hi; # inline comment\n';
    expect(() => collapseBootstrapScript(raw, 'fixture')).toThrow(/full-line comment/i);
  });

  it('rejects runs of two or more spaces', () => {
    const raw = 'set -u;\necho  hi;\n';
    expect(() => collapseBootstrapScript(raw, 'fixture')).toThrow(/consecutive spaces/i);
  });

  it('rejects an empty script', () => {
    const raw = '# just a comment\n\n';
    expect(() => collapseBootstrapScript(raw, 'fixture')).toThrow(/no shell statements/i);
  });

  it('rejects a collapse that is not valid shell syntax (bash -n -c)', () => {
    // A quoted string that never closes anywhere in the file — none of the
    // per-line checks above catch this (no `#`, no double space, no
    // trailing backslash); only a real `bash -n` syntax check can.
    const raw = 'set -u;\necho "unterminated;\n';
    expect(() => collapseBootstrapScript(raw, 'fixture')).toThrow(/syntax check/i);
  });

  it('accepts a well-formed multi-statement script and collapses it correctly', () => {
    const raw = ['set -u;', 'echo one;', 'echo two;'].join('\n');
    expect(collapseBootstrapScript(raw, 'fixture')).toBe('set -u; echo one; echo two;');
  });
});

describe('liveBootstrapLine malformed-row handling (hermetic fixture DB)', () => {
  let tmpDb: string | undefined;

  afterEach(() => {
    if (tmpDb && fs.existsSync(tmpDb)) fs.rmSync(tmpDb);
    tmpDb = undefined;
  });

  function makeFixtureDb(): Database.Database {
    tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skylight-test-')), 'v2.db');
    const db = new Database(tmpDb);
    db.exec(`
      CREATE TABLE agent_groups (
        id     TEXT PRIMARY KEY,
        folder TEXT NOT NULL UNIQUE
      );
      CREATE TABLE container_configs (
        agent_group_id TEXT PRIMARY KEY,
        mcp_servers    TEXT NOT NULL DEFAULT '{}'
      );
      INSERT INTO agent_groups (id, folder) VALUES ('ag-fixture', 'skylight-morning');
    `);
    db.close();
    return new Database(tmpDb);
  }

  it('returns null when the container_configs row is not seeded', () => {
    makeFixtureDb().close();
    expect(liveBootstrapLine(tmpDb!)).toBeNull();
  });

  it('returns the line when the row is well-formed', () => {
    const db = makeFixtureDb();
    db.prepare(
      "INSERT INTO container_configs (agent_group_id, mcp_servers) VALUES ('ag-fixture', ?)",
    ).run(JSON.stringify({ skylight: { args: ['-lc', 'the line'] } }));
    db.close();
    expect(liveBootstrapLine(tmpDb!)).toBe('the line');
  });

  it('throws when mcp_servers is present but has no `skylight` key', () => {
    const db = makeFixtureDb();
    db.prepare(
      "INSERT INTO container_configs (agent_group_id, mcp_servers) VALUES ('ag-fixture', ?)",
    ).run(JSON.stringify({ someOtherServer: {} }));
    db.close();
    expect(() => liveBootstrapLine(tmpDb!)).toThrow(/no 'skylight' key/);
  });

  it('throws on corrupt JSON in mcp_servers rather than reporting "nothing to compare"', () => {
    const db = makeFixtureDb();
    db.prepare(
      "INSERT INTO container_configs (agent_group_id, mcp_servers) VALUES ('ag-fixture', ?)",
    ).run('{not valid json');
    db.close();
    expect(() => liveBootstrapLine(tmpDb!)).toThrow();
  });
});
