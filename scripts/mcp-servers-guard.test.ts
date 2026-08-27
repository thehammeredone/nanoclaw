import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { Readable, Writable } from 'stream';
import { afterEach, describe, expect, it } from 'vitest';

import {
  confirmOverwrite,
  getStoredMcpServers,
  isEmptyMcpServers,
  mcpServersDiffText,
  planMcpServersUpdate,
  writeMcpServers,
} from './mcp-servers-guard.js';

/**
 * Hermetic fixture DB — mirrors the pattern in scripts/skylight-mcp-bootstrap.test.ts.
 * Never touches data/v2.db.
 */
function makeFixtureDb(mcpServers: string): { db: Database.Database; path: string } {
  const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-guard-test-')), 'v2.db');
  const db = new Database(tmpDb);
  db.exec(`
    CREATE TABLE container_configs (
      agent_group_id TEXT PRIMARY KEY,
      mcp_servers    TEXT NOT NULL DEFAULT '{}',
      updated_at     TEXT NOT NULL DEFAULT ''
    );
  `);
  db.prepare("INSERT INTO container_configs (agent_group_id, mcp_servers, updated_at) VALUES ('ag-fixture', ?, '')").run(
    mcpServers,
  );
  return { db, path: tmpDb };
}

describe('isEmptyMcpServers', () => {
  it('treats undefined, null, and {} as empty', () => {
    expect(isEmptyMcpServers(undefined)).toBe(true);
    expect(isEmptyMcpServers(null)).toBe(true);
    expect(isEmptyMcpServers({})).toBe(true);
  });

  it('treats a non-empty object as non-empty', () => {
    expect(isEmptyMcpServers({ skylight: {} })).toBe(false);
  });
});

describe('planMcpServersUpdate', () => {
  const next = { skylight: { command: 'bash', env: { A: '1' } } };

  it('writes directly when there is no existing config', () => {
    expect(planMcpServersUpdate({ existing: undefined, next, force: false, dryRun: false })).toEqual({
      kind: 'write',
      reason: 'no-existing-config',
    });
    expect(planMcpServersUpdate({ existing: {}, next, force: false, dryRun: false })).toEqual({
      kind: 'write',
      reason: 'no-existing-config',
    });
  });

  it('writes directly when the stored config is identical to what would be written', () => {
    const existing = { skylight: { command: 'bash', env: { A: '1' } } };
    expect(planMcpServersUpdate({ existing, next, force: false, dryRun: false })).toEqual({
      kind: 'write',
      reason: 'identical',
    });
  });

  it('requires confirmation — does NOT plan a write — when the stored config diverges', () => {
    // Hand-tuned live state the seeder does not know about (the exact TASK-27 scenario:
    // an extra env key present on the live row but not in what the seeder would write).
    const existing = { skylight: { command: 'bash', env: { A: '1', HAND_TUNED_KEY: 'do-not-lose-me' } } };
    const plan = planMcpServersUpdate({ existing, next, force: false, dryRun: false });
    expect(plan.kind).toBe('needs-confirmation');
    if (plan.kind === 'needs-confirmation') {
      expect(plan.diff).toContain('HAND_TUNED_KEY');
    }
  });

  it('force writes over a divergent stored config', () => {
    const existing = { skylight: { command: 'bash', env: { A: '1', HAND_TUNED_KEY: 'x' } } };
    expect(planMcpServersUpdate({ existing, next, force: true, dryRun: false })).toEqual({
      kind: 'write',
      reason: 'forced',
    });
  });

  it('dry-run never plans a write, even when divergent', () => {
    const existing = { skylight: { command: 'bash', env: { A: '1', HAND_TUNED_KEY: 'x' } } };
    const plan = planMcpServersUpdate({ existing, next, force: false, dryRun: true });
    expect(plan.kind).toBe('dry-run');
    if (plan.kind === 'dry-run') {
      expect(plan.reason).toBe('diverges-from-live');
      expect(plan.diff).toContain('HAND_TUNED_KEY');
    }
  });

  it('dry-run also short-circuits force (dry-run wins, nothing is ever written by the plan alone)', () => {
    const existing = { skylight: { command: 'bash', env: { A: '1', HAND_TUNED_KEY: 'x' } } };
    const plan = planMcpServersUpdate({ existing, next, force: true, dryRun: true });
    expect(plan.kind).toBe('dry-run');
  });
});

describe('mcpServersDiffText', () => {
  it('shows both the stored and would-be-written values', () => {
    const text = mcpServersDiffText({ a: 1 }, { a: 2 });
    expect(text).toContain('stored (live)');
    expect(text).toContain('seeder would write');
    expect(text).toContain('"a": 1');
    expect(text).toContain('"a": 2');
  });

  it('renders "(no existing config)" instead of the literal string "undefined" when there is no stored row', () => {
    const text = mcpServersDiffText(undefined, { a: 1 });
    expect(text).toContain('(no existing config)');
    expect(text).not.toMatch(/---\s*\nundefined/);
  });

  it('redacts secret-looking env keys instead of printing their raw values (F1, CRITICAL)', () => {
    const existing = { skylight: { env: { SKYLIGHT_PASSWORD: 'hunter2', SKYLIGHT_EMAIL: 'a@example.com' } } };
    const next = { skylight: { env: { SKYLIGHT_PASSWORD: 'hunter2', SKYLIGHT_EMAIL: 'a@example.com' } } };
    const text = mcpServersDiffText(existing, next);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('a@example.com');
    // key names still visible so an operator can see WHICH keys are secret
    expect(text).toContain('SKYLIGHT_PASSWORD');
    expect(text).toContain('SKYLIGHT_EMAIL');
  });

  it('marks a redacted value as changed vs unchanged without revealing either value', () => {
    const existing = { skylight: { env: { SKYLIGHT_PASSWORD: 'old-secret', SKYLIGHT_TOKEN: 'same-secret-token' } } };
    const next = { skylight: { env: { SKYLIGHT_PASSWORD: 'new-secret', SKYLIGHT_TOKEN: 'same-secret-token' } } };
    const text = mcpServersDiffText(existing, next);
    expect(text).not.toContain('old-secret');
    expect(text).not.toContain('new-secret');
    expect(text).not.toContain('same-secret-token');
    expect(text).toContain('<redacted: value differs>');
    expect(text).toContain('<redacted: unchanged>');
  });

  it('renders an undefined-vs-missing divergence visibly instead of both sides collapsing to nothing (F3)', () => {
    const existing = { a: { b: 1 } };
    const next = { a: { b: 1, u: undefined } };
    // The plan itself must still see these as different...
    expect(planMcpServersUpdate({ existing, next, force: false, dryRun: false }).kind).toBe('needs-confirmation');
    // ...and the rendered diff must show why, not print two identical blobs.
    const text = mcpServersDiffText(existing, next);
    const [stored, wouldWrite] = text.split('--- seeder would write ---');
    expect(stored).not.toEqual(wouldWrite);
    expect(wouldWrite).toContain('<undefined>');
  });
});

describe('getStoredMcpServers / writeMcpServers (hermetic fixture DB)', () => {
  let tmpPath: string | undefined;

  afterEach(() => {
    if (tmpPath && fs.existsSync(path.dirname(tmpPath))) fs.rmSync(path.dirname(tmpPath), { recursive: true, force: true });
    tmpPath = undefined;
  });

  it('parses the stored JSON', () => {
    const { db, path: p } = makeFixtureDb(JSON.stringify({ skylight: { command: 'bash' } }));
    tmpPath = p;
    expect(getStoredMcpServers(db, 'ag-fixture')).toEqual({ skylight: { command: 'bash' } });
    db.close();
  });

  it('throws loudly on corrupt JSON instead of reporting "nothing stored"', () => {
    const { db, path: p } = makeFixtureDb('{not valid json');
    tmpPath = p;
    expect(() => getStoredMcpServers(db, 'ag-fixture')).toThrow(/not valid JSON/);
    db.close();
  });

  it('THE CORE PROTECTIVE BEHAVIOUR: a needs-confirmation plan, left unresolved, does not clobber the stored row', () => {
    const drifted = { skylight: { command: 'bash', env: { A: '1', HAND_TUNED_KEY: 'do-not-lose-me' } } };
    const { db, path: p } = makeFixtureDb(JSON.stringify(drifted));
    tmpPath = p;

    const next = { skylight: { command: 'bash', env: { A: '1' } } }; // seeder doesn't know about HAND_TUNED_KEY
    const existing = getStoredMcpServers(db, 'ag-fixture');
    const plan = planMcpServersUpdate({ existing, next, force: false, dryRun: false });

    expect(plan.kind).toBe('needs-confirmation');

    // Capture the row BEFORE deciding not to call writeMcpServers, so the
    // "unchanged" assertion below is comparing to a real snapshot rather than
    // to `drifted` (which would pass even if the row were never written in
    // the first place — a prior version of this test could not fail).
    const rowBefore = db.prepare('SELECT mcp_servers FROM container_configs WHERE agent_group_id = ?').get('ag-fixture') as {
      mcp_servers: string;
    };

    // Simulate the caller's non-interactive refusal path: it must NOT call writeMcpServers
    // for a 'needs-confirmation' plan.
    // (deliberately not calling writeMcpServers here)

    const rowAfter = db.prepare('SELECT mcp_servers FROM container_configs WHERE agent_group_id = ?').get('ag-fixture') as {
      mcp_servers: string;
    };
    expect(rowAfter.mcp_servers).toBe(rowBefore.mcp_servers);
    expect(JSON.parse(rowAfter.mcp_servers)).toEqual(drifted);

    // Prove the assertion above is real: writing WOULD have changed the row.
    writeMcpServers(db, 'ag-fixture', next);
    const rowIfWritten = db.prepare('SELECT mcp_servers FROM container_configs WHERE agent_group_id = ?').get('ag-fixture') as {
      mcp_servers: string;
    };
    expect(rowIfWritten.mcp_servers).not.toBe(rowBefore.mcp_servers);
    db.close();
  });

  it('writeMcpServers throws loudly instead of silently no-op-ing when the row does not exist (F6)', () => {
    const { db, path: p } = makeFixtureDb('{}');
    tmpPath = p;
    expect(() => writeMcpServers(db, 'ag-does-not-exist', { skylight: {} })).toThrow(/no container_configs row/);
    db.close();
  });

  it('writeMcpServers overwrites the row when the caller decides to (force path)', () => {
    const drifted = { skylight: { command: 'bash', env: { A: '1', HAND_TUNED_KEY: 'x' } } };
    const { db, path: p } = makeFixtureDb(JSON.stringify(drifted));
    tmpPath = p;

    const next = { skylight: { command: 'bash', env: { A: '1' } } };
    writeMcpServers(db, 'ag-fixture', next);

    const row = db.prepare('SELECT mcp_servers FROM container_configs WHERE agent_group_id = ?').get('ag-fixture') as {
      mcp_servers: string;
    };
    expect(JSON.parse(row.mcp_servers)).toEqual(next);
    db.close();
  });
});

describe('confirmOverwrite', () => {
  function fakeStreams(reply: string) {
    const input = Readable.from([reply]);
    const chunks: string[] = [];
    const output = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    });
    return { input, output, chunks };
  }

  it('returns true for y/yes answers', async () => {
    const { input, output } = fakeStreams('y\n');
    await expect(confirmOverwrite('diff text', { input, output })).resolves.toBe(true);
  });

  it('returns false for anything else, including blank', async () => {
    const { input, output } = fakeStreams('\n');
    await expect(confirmOverwrite('diff text', { input, output })).resolves.toBe(false);
  });
});
