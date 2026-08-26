import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { BOOTSTRAP_SCRIPT_PATH, skylightBootstrapLine } from './skylight-mcp-bootstrap.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNBOOK = path.join(REPO_ROOT, 'docs/runbooks/aurora-skylight-mcp.md');
const CENTRAL_DB = path.join(REPO_ROOT, 'data/v2.db');
const AURORA_GROUP_ID = 'ag-1782273071167-th1q6f';

/** Directories that could plausibly hold a hand-copied duplicate of the line. */
const SCANNED_DIRS = ['scripts', 'src', 'docs', 'backlog', 'container', 'setup'];
const SCANNED_EXTS = new Set(['.md', '.ts', '.js', '.sh', '.json', '.txt', '.yaml', '.yml']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SCANNED_EXTS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

/** args[1] of the `skylight` MCP server for the Aurora group, or null if not seeded here. */
function liveBootstrapLine(): string | null {
  if (!fs.existsSync(CENTRAL_DB)) return null;
  const db = new Database(CENTRAL_DB, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare('SELECT mcp_servers FROM container_configs WHERE agent_group_id = ?')
      .get(AURORA_GROUP_ID) as { mcp_servers: string | null } | undefined;
    if (!row?.mcp_servers) return null;
    const servers = JSON.parse(row.mcp_servers) as Record<string, { args?: string[] }> | null;
    const args = servers?.skylight?.args;
    return Array.isArray(args) && typeof args[1] === 'string' ? args[1] : null;
  } catch {
    // Table missing (un-migrated DB) — nothing to drift against.
    return null;
  } finally {
    db.close();
  }
}

describe('skylight MCP bootstrap line', () => {
  it('collapses the canonical script into a single `bash -lc` argument', () => {
    const line = skylightBootstrapLine();
    expect(fs.existsSync(BOOTSTRAP_SCRIPT_PATH)).toBe(true);
    expect(path.relative(REPO_ROOT, BOOTSTRAP_SCRIPT_PATH)).toBe(
      path.join('scripts', 'skylight-mcp-bootstrap.sh'),
    );
    expect(line).not.toMatch(/[\n\r]/);
    // A `#` would comment out the rest of the joined line.
    expect(line).not.toContain('#');
    expect(line).not.toMatch(/ {2}/);
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
        const normalized = fs.readFileSync(file, 'utf8').replace(/\s+/g, ' ');
        if (normalized.includes(needle)) duplicates.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(duplicates).toEqual([]);
  });

  it('is the definition the runbook points operators at', () => {
    const runbook = fs.readFileSync(RUNBOOK, 'utf8');
    expect(runbook).toContain('scripts/skylight-mcp-bootstrap.sh');
  });

  it('matches what is actually stored in the central DB', () => {
    const live = liveBootstrapLine();
    if (live === null) {
      // Fresh clone / CI: the Aurora group is not seeded here, so there is no
      // second copy that could have drifted. Nothing to compare.
      return;
    }
    expect(live).toBe(skylightBootstrapLine());
  });
});
