import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { CONTAINER_RUNTIME_BIN } from '../container-runtime.js';
import { closeDb, initTestDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import {
  agentGroupIdTables,
  assertSafePath,
  collectIncomplete,
  findContainers,
  cascadesOnAgentGroup,
  executeTeardown,
  findOrphans,
  findStaleMirrors,
  onecliIdentifier,
  planTeardown,
  renderPlan,
  scanProseReferences,
  sessionBlockerTables,
  type ExecResult,
  type TeardownEnv,
} from './agent-group-teardown.js';

let db: Database.Database;
let tmp: string;
let env: TeardownEnv;
let execCalls: { cmd: string; args: string[] }[];

/** Records every shell-out and returns canned output — nothing runs. */
function fakeExec(responses: Record<string, ExecResult> = {}) {
  return (cmd: string, args: string[]): ExecResult => {
    execCalls.push({ cmd, args });
    const key = [cmd, ...args].join(' ');
    for (const [prefix, res] of Object.entries(responses)) {
      if (key.startsWith(prefix)) return res;
    }
    return { ok: true, stdout: '', stderr: '' };
  };
}

function now() {
  return new Date().toISOString();
}

function seedGroup(id: string, name: string, folder: string) {
  db.prepare(`INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, NULL, ?)`).run(
    id,
    name,
    folder,
    now(),
  );
  fs.mkdirSync(path.join(tmp, 'groups', folder), { recursive: true });
}

function seedMessagingGroup(id: string, name: string) {
  db.prepare(
    `INSERT INTO messaging_groups (id, channel_type, platform_id, name, created_at)
     VALUES (?, 'discord', ?, ?, ?)`,
  ).run(id, `plat-${id}`, name, now());
}

function seedSession(id: string, agentGroupId: string, messagingGroupId: string) {
  db.prepare(
    `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, created_at, last_active)
     VALUES (?, ?, ?, NULL, ?, ?)`,
  ).run(id, agentGroupId, messagingGroupId, now(), now());
  fs.mkdirSync(path.join(tmp, 'data', 'v2-sessions', agentGroupId, id), { recursive: true });
}

beforeEach(() => {
  db = initTestDb();
  runMigrations(db);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teardown-test-'));
  fs.mkdirSync(path.join(tmp, 'groups'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'data', 'v2-sessions'), { recursive: true });
  execCalls = [];
  env = {
    dataDir: path.join(tmp, 'data'),
    groupsDir: path.join(tmp, 'groups'),
    containerImageBase: 'nanoclaw-agent-v2-testslug',
    containerInstallLabel: 'nanoclaw-install=testslug',
    exec: fakeExec(),
  };
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── Schema introspection ────────────────────────────────────────────────────

describe('schema introspection', () => {
  it('finds every table carrying agent_group_id', () => {
    const tables = agentGroupIdTables(db);
    for (const t of [
      'agent_destinations',
      'agent_group_members',
      'container_configs',
      'messaging_group_agents',
      'pending_approvals',
      'sessions',
      'unregistered_senders',
      'user_roles',
    ]) {
      expect(tables).toContain(t);
    }
    expect(tables).not.toContain('agent_groups');
  });

  it('knows container_configs is the only agent_group cascade', () => {
    const cascading = agentGroupIdTables(db).filter((t) => cascadesOnAgentGroup(db, t));
    expect(cascading).toEqual(['container_configs']);
  });

  it('finds session blockers that a group-scoped sweep would miss', () => {
    const blockers = sessionBlockerTables(db);
    const names = blockers.map((b) => b.table);
    expect(names).toContain('pending_questions');
    expect(names).toContain('pending_approvals');
    // The whole point: pending_questions has no agent_group_id column.
    expect(agentGroupIdTables(db)).not.toContain('pending_questions');
    for (const b of blockers) expect(b.column).toBe('session_id');
  });
});

// ── Path guards ─────────────────────────────────────────────────────────────

describe('assertSafePath', () => {
  it('accepts the exact target directory', () => {
    expect(() => assertSafePath('/data/v2-sessions/ag-1', '/data/v2-sessions', 'ag-1')).not.toThrow();
  });

  it('refuses a sibling group directory', () => {
    expect(() => assertSafePath('/data/v2-sessions/ag-2', '/data/v2-sessions', 'ag-1')).toThrow(/refusing/);
  });

  it('refuses traversal and nesting', () => {
    expect(() => assertSafePath('/data/v2-sessions/ag-1/..', '/data/v2-sessions', 'ag-1')).toThrow(/refusing/);
    expect(() => assertSafePath('/data/v2-sessions/a/b', '/data/v2-sessions', 'a/b')).toThrow(/refusing/);
    expect(() => assertSafePath('/data/v2-sessions', '/data/v2-sessions', '')).toThrow(/refusing/);
  });
});

describe('findContainers', () => {
  it('flags "could not check" rather than returning an empty list', () => {
    // No folder: discovery cannot even be attempted.
    const noFolder = findContainers(env, null);
    expect(noFolder.names).toEqual([]);
    expect(noFolder.unknown).toBe(true);
    expect(noFolder.warnings.join()).toMatch(/NOT stopped/);
    expect(execCalls).toEqual([]);

    // Runtime binary present but failing — same class of unknown.
    env.exec = fakeExec({ 'docker ps': { ok: false, stdout: '', stderr: 'command not found' } });
    const failed = findContainers(env, 'doomed');
    expect(failed.names).toEqual([]);
    expect(failed.unknown).toBe(true);
    expect(failed.warnings.join()).toMatch(/command not found/);
  });

  it('reports a clean empty result as known-empty', () => {
    env.exec = fakeExec({ 'docker ps': { ok: true, stdout: '\n', stderr: '' } });
    const res = findContainers(env, 'doomed');
    expect(res).toEqual({ names: [], unknown: false, warnings: [] });
  });
});

describe('onecliIdentifier', () => {
  it('prefixes ids that start with a digit', () => {
    expect(onecliIdentifier('103c34dd-8610-4bd6')).toBe('ag-103c34dd-8610-4bd6');
    expect(onecliIdentifier('ag-1782273071167-th1q6f')).toBe('ag-1782273071167-th1q6f');
    expect(onecliIdentifier('f09aa5a1-1111')).toBe('f09aa5a1-1111');
  });
});

// ── Planning + ordering ─────────────────────────────────────────────────────

describe('planTeardown', () => {
  beforeEach(() => {
    seedGroup('ag-doomed', 'Doomed', 'doomed');
    seedGroup('ag-keeper', 'Keeper', 'keeper');
    seedMessagingGroup('mg-solo', 'solo');
    seedMessagingGroup('mg-shared', 'shared');
    db.prepare(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, session_mode, created_at)
       VALUES ('w1', ?, ?, 'shared', ?)`,
    ).run('mg-solo', 'ag-doomed', now());
    db.prepare(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, session_mode, created_at)
       VALUES ('w2', ?, ?, 'shared', ?)`,
    ).run('mg-shared', 'ag-doomed', now());
    db.prepare(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, session_mode, created_at)
       VALUES ('w3', ?, ?, 'shared', ?)`,
    ).run('mg-shared', 'ag-keeper', now());
    seedSession('sess-doomed', 'ag-doomed', 'mg-solo');
    seedSession('sess-keeper', 'ag-keeper', 'mg-shared');
    // Blocker that the agent_group_id sweep cannot see.
    db.prepare(
      `INSERT INTO pending_questions
         (question_id, session_id, message_out_id, platform_id, channel_type, thread_id, title, options_json, created_at)
       VALUES ('q1', 'sess-doomed', 'mo1', 'p', 'discord', NULL, 'why?', '[]', ?)`,
    ).run(now());
    // Inbound edge from the surviving group — no FK, silently dangles.
    db.prepare(
      `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES ('ag-keeper', 'oracle', 'agent', 'ag-doomed', ?)`,
    ).run(now());
    // The doomed group's own outbound edge.
    db.prepare(
      `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES ('ag-doomed', 'solo', 'channel', 'mg-solo', ?)`,
    ).run(now());
  });

  it('resolves by folder and by id', () => {
    expect(planTeardown(db, env, { folder: 'doomed' }).agentGroupId).toBe('ag-doomed');
    expect(planTeardown(db, env, { agentGroupId: 'ag-doomed' }).folder).toBe('doomed');
  });

  it('throws a pointer to --id when the folder is unknown', () => {
    expect(() => planTeardown(db, env, { folder: 'nope' })).toThrow(/--id/);
  });

  it('plans residual cleanup when the row is already gone', () => {
    const plan = planTeardown(db, env, { agentGroupId: 'ag-vanished' });
    expect(plan.residual).toBe(true);
    expect(plan.folder).toBeNull();
    expect(plan.warnings.join('\n')).toMatch(/residual mode/);
    // The whole point of the warning: without a folder the group directory is
    // unreachable, so the operator has to be told what to pass.
    expect(plan.warnings.join('\n')).toMatch(/--folder <name>/);
  });

  it('accepts --folder alongside --id in residual mode, and only there', () => {
    fs.mkdirSync(path.join(tmp, 'groups', 'vanished'), { recursive: true });
    const residual = planTeardown(db, env, { agentGroupId: 'ag-vanished', folder: 'vanished' });
    expect(residual.residual).toBe(true);
    expect(residual.folder).toBe('vanished');
    expect(residual.directories).toContain(path.join(tmp, 'groups', 'vanished'));
    expect(residual.warnings.join('\n')).toMatch(/operator-supplied --folder/);

    // While the row exists the DB stays authoritative — a mismatched --folder
    // must not redirect the removal at a surviving group.
    const live = planTeardown(db, env, { agentGroupId: 'ag-doomed', folder: 'keeper' });
    expect(live.folder).toBe('doomed');
    expect(live.directories.join('|')).not.toMatch(/keeper/);
  });

  it('puts an operator-supplied residual --folder through the path guard', () => {
    const plan = planTeardown(db, env, { agentGroupId: 'ag-vanished', folder: '../groups/keeper' });
    expect(plan.folder).toBeNull();
    expect(plan.warnings.join('\n')).toMatch(/ignoring --folder/);
    expect(plan.directories.join('|')).not.toMatch(/keeper/);
    expect(fs.existsSync(path.join(tmp, 'groups', 'keeper'))).toBe(true);
  });

  it('reports a folder the guard refuses instead of listing it as WILL DELETE', () => {
    db.prepare(`UPDATE agent_groups SET folder = ? WHERE id = 'ag-doomed'`).run('../groups/keeper');
    const plan = planTeardown(db, env, { agentGroupId: 'ag-doomed' });
    expect(plan.directories.join('|')).not.toMatch(/keeper/);
    expect(plan.refusedDirectories.map((d) => d.path)).toContain(path.join(tmp, 'groups', 'keeper'));
    const text = renderPlan(plan);
    expect(text).toMatch(/REFUSED — filesystem/);
  });

  it('reports failed container discovery as unknown, never as none', () => {
    env.exec = fakeExec({ 'docker ps': { ok: false, stdout: '', stderr: 'Cannot connect to the daemon' } });
    const plan = planTeardown(db, env, { agentGroupId: 'ag-doomed' });
    expect(plan.containers).toEqual([]);
    expect(plan.containersUnknown).toBe(true);
    const text = renderPlan(plan);
    expect(text).toMatch(/COULD NOT CHECK/);
    expect(text).not.toMatch(/WILL STOP — running containers\n─+\n {2}\(none\)/);
  });

  it('counts the session blockers a sweep would miss', () => {
    const plan = planTeardown(db, env, { agentGroupId: 'ag-doomed' });
    expect(plan.sessionBlockers.find((b) => b.table === 'pending_questions')?.count).toBe(1);
  });

  it('finds inbound destination edges from other groups only', () => {
    const plan = planTeardown(db, env, { agentGroupId: 'ag-doomed' });
    expect(plan.inboundDestinations).toEqual([
      { agent_group_id: 'ag-keeper', local_name: 'oracle', target_type: 'agent', target_id: 'ag-doomed' },
    ]);
  });

  it('lists only this group directories, never a sibling', () => {
    const plan = planTeardown(db, env, { agentGroupId: 'ag-doomed' });
    expect(plan.directories).toEqual([
      path.join(tmp, 'groups', 'doomed'),
      path.join(tmp, 'data', 'v2-sessions', 'ag-doomed'),
    ]);
    expect(plan.directories.join('|')).not.toMatch(/keeper/);
  });

  it('changes nothing', () => {
    planTeardown(db, env, { agentGroupId: 'ag-doomed' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_groups').get()).toEqual({ n: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 2 });
    expect(fs.existsSync(path.join(tmp, 'groups', 'doomed'))).toBe(true);
  });

  it('renders without throwing', () => {
    const text = renderPlan(planTeardown(db, env, { agentGroupId: 'ag-doomed' }));
    expect(text).toMatch(/WILL DELETE — central DB/);
    expect(text).toMatch(/REPORT ONLY — orphaned session directories/);
  });
});

// ── Execution order ─────────────────────────────────────────────────────────

describe('executeTeardown', () => {
  beforeEach(() => {
    seedGroup('ag-doomed', 'Doomed', 'doomed');
    seedGroup('ag-keeper', 'Keeper', 'keeper');
    seedMessagingGroup('mg-solo', 'solo');
    db.prepare(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, session_mode, created_at)
       VALUES ('w1', 'mg-solo', 'ag-doomed', 'shared', ?)`,
    ).run(now());
    seedSession('sess-doomed', 'ag-doomed', 'mg-solo');
    seedSession('sess-keeper', 'ag-keeper', 'mg-solo');
    db.prepare(
      `INSERT INTO pending_questions
         (question_id, session_id, message_out_id, platform_id, channel_type, thread_id, title, options_json, created_at)
       VALUES ('q1', 'sess-doomed', 'mo1', 'p', 'discord', NULL, 'why?', '[]', ?)`,
    ).run(now());
    db.prepare(
      `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES ('ag-keeper', 'oracle', 'agent', 'ag-doomed', ?)`,
    ).run(now());
    db.prepare(`INSERT INTO container_configs (agent_group_id, updated_at) VALUES ('ag-doomed', ?)`).run(now());
    db.prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES ('discord:x', 'human', 'X', ?)`).run(
      now(),
    );
    db.prepare(
      `INSERT INTO agent_group_members (user_id, agent_group_id, added_at) VALUES ('discord:x', 'ag-doomed', ?)`,
    ).run(now());
  });

  it('tears the group down without an FK error and leaves the survivor intact', () => {
    const plan = planTeardown(db, env, { agentGroupId: 'ag-doomed' });
    const result = executeTeardown(db, env, plan);

    expect(db.prepare(`SELECT id FROM agent_groups`).all()).toEqual([{ id: 'ag-keeper' }]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE agent_group_id = 'ag-doomed'`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE agent_group_id = 'ag-keeper'`).get()).toEqual({ n: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM pending_questions`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM agent_destinations`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM messaging_group_agents`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM container_configs`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM agent_group_members`).get()).toEqual({ n: 0 });
    // Messaging group survives — teardown reports it, never deletes it.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM messaging_groups`).get()).toEqual({ n: 1 });

    expect(fs.existsSync(path.join(tmp, 'groups', 'doomed'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'data', 'v2-sessions', 'ag-doomed'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'groups', 'keeper'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'data', 'v2-sessions', 'ag-keeper', 'sess-keeper'))).toBe(true);

    expect(result.warnings).toEqual([]);
    const order = result.steps.map((s) => s.step);
    expect(order.indexOf('delete-wirings')).toBeLessThan(order.indexOf('clear-session-blockers'));
    expect(order.indexOf('clear-session-blockers')).toBeLessThan(order.indexOf('delete-sessions'));
    expect(order.indexOf('delete-sessions')).toBeLessThan(order.indexOf('delete-agent-group'));
    expect(order.indexOf('delete-agent-group')).toBeLessThan(order.indexOf('remove-directory'));
  });

  it('stops the group containers and only those', () => {
    env.exec = fakeExec({
      'docker ps': {
        ok: true,
        stdout: 'nanoclaw-v2-doomed-123\nnanoclaw-v2-keeper-456\nnanoclaw-v2-doomed-2-789\n',
        stderr: '',
      },
    });
    const plan = planTeardown(db, env, { agentGroupId: 'ag-doomed' });
    expect(plan.containers).toEqual(['nanoclaw-v2-doomed-123']);
    executeTeardown(db, env, plan);
    expect(execCalls.some((c) => c.args[0] === 'stop' && c.args.includes('nanoclaw-v2-doomed-123'))).toBe(true);
    expect(execCalls.some((c) => c.args.includes('nanoclaw-v2-keeper-456'))).toBe(false);
  });

  it('removes only an image tag that actually exists', () => {
    env.exec = fakeExec({
      'docker images': {
        ok: true,
        stdout: 'nanoclaw-agent-v2-testslug:ag-doomed\nnanoclaw-agent-v2-testslug:ag-keeper\nalpine:3\n',
        stderr: '',
      },
    });
    const plan = planTeardown(db, env, { agentGroupId: 'ag-doomed' });
    expect(plan.imageTags).toEqual(['nanoclaw-agent-v2-testslug:ag-doomed']);
    executeTeardown(db, env, plan);
    expect(execCalls.some((c) => c.args[0] === 'rmi' && c.args[1] === 'nanoclaw-agent-v2-testslug:ag-doomed')).toBe(
      true,
    );
  });

  it('deletes the OneCLI agent by id but never the default agent', () => {
    env.exec = fakeExec({
      'onecli agents list': {
        ok: true,
        stdout: JSON.stringify({
          data: [
            { id: 'one-default', name: 'Default Agent', identifier: 'default', isDefault: true, accessToken: 'aoc_x' },
            { id: 'one-doomed', name: 'Doomed', identifier: 'ag-doomed', isDefault: false, accessToken: 'aoc_y' },
          ],
        }),
        stderr: '',
      },
    });
    const plan = planTeardown(db, env, { agentGroupId: 'ag-doomed' });
    expect(plan.onecliAgent).toEqual({ id: 'one-doomed', name: 'Doomed', identifier: 'ag-doomed' });
    // Access tokens must never reach the plan (it gets printed).
    expect(JSON.stringify(plan)).not.toMatch(/aoc_/);
    executeTeardown(db, env, plan);
    expect(execCalls.some((c) => c.cmd === 'onecli' && c.args.join(' ') === 'agents delete --id one-doomed')).toBe(
      true,
    );
  });

  it('honours --keep-onecli and --keep-images', () => {
    const plan = planTeardown(db, env, { agentGroupId: 'ag-doomed', keepOnecli: true, keepImages: true });
    expect(plan.onecliAgent).toBeNull();
    expect(plan.imageTags).toEqual([]);
    expect(execCalls.some((c) => c.cmd === 'onecli')).toBe(false);
  });

  it('is idempotent — a second run is a no-op', () => {
    const plan = planTeardown(db, env, { agentGroupId: 'ag-doomed' });
    executeTeardown(db, env, plan);
    const second = planTeardown(db, env, { agentGroupId: 'ag-doomed' });
    expect(second.residual).toBe(true);
    const result = executeTeardown(db, env, second);
    // Residual mode cannot discover containers (no folder), and says so — but
    // nothing was attempted and failed.
    expect(result.failures).toEqual([]);
    expect(db.prepare(`SELECT id FROM agent_groups`).all()).toEqual([{ id: 'ag-keeper' }]);
  });

  it('every container shell-out goes through the configured runtime binary', () => {
    env.exec = fakeExec({
      'docker ps': { ok: true, stdout: 'nanoclaw-v2-doomed-123\n', stderr: '' },
      'docker images': { ok: true, stdout: 'nanoclaw-agent-v2-testslug:ag-doomed\n', stderr: '' },
    });
    const plan = planTeardown(db, env, { agentGroupId: 'ag-doomed' });
    executeTeardown(db, env, plan);
    const runtimeCalls = execCalls.filter((c) => c.cmd !== 'onecli');
    expect(runtimeCalls.length).toBeGreaterThan(0);
    // Not the literal string 'docker' — the exported constant, so the Apple
    // Container swap (which rewrites container-runtime.ts) carries this file.
    for (const c of runtimeCalls) expect(c.cmd).toBe(CONTAINER_RUNTIME_BIN);
    expect(runtimeCalls.map((c) => c.args[0])).toEqual(expect.arrayContaining(['ps', 'images', 'stop', 'rmi']));
  });

  it('records a failed destructive step as a failure, not just a warning', () => {
    env.exec = fakeExec({
      'docker ps': { ok: true, stdout: 'nanoclaw-v2-doomed-123\n', stderr: '' },
      'docker stop': { ok: false, stdout: '', stderr: 'no such container' },
      'onecli agents list': {
        ok: true,
        stdout: JSON.stringify({ data: [{ id: 'one-doomed', name: 'Doomed', identifier: 'ag-doomed' }] }),
        stderr: '',
      },
      'onecli agents delete': { ok: false, stdout: '', stderr: 'gateway down' },
    });
    const plan = planTeardown(db, env, { agentGroupId: 'ag-doomed' });
    const result = executeTeardown(db, env, plan);
    const failed = result.failures.map((f) => f.step);
    expect(failed).toContain('stop-container');
    expect(failed).toContain('delete-onecli-agent');
    // Failures are also warnings — warnings stay the human-readable superset.
    expect(result.warnings.join('\n')).toMatch(/gateway down/);
  });

  it('leaves inbound edges of a different target_type alone', () => {
    // target_id is polymorphic. A channel edge whose target_id happens to
    // collide with an agent group id must not be swept by the agent teardown.
    db.prepare(
      `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES ('ag-keeper', 'coincidence', 'channel', 'ag-doomed', ?)`,
    ).run(now());
    const plan = planTeardown(db, env, { agentGroupId: 'ag-doomed' });
    expect(plan.inboundDestinations.map((e) => e.local_name)).toEqual(['oracle']);
    executeTeardown(db, env, plan);
    expect(db.prepare(`SELECT local_name FROM agent_destinations`).all()).toEqual([{ local_name: 'coincidence' }]);
  });
});

// ── Exit-code signal ────────────────────────────────────────────────────────

describe('collectIncomplete (drives the scripts exit code)', () => {
  beforeEach(() => {
    seedGroup('ag-doomed', 'Doomed', 'doomed');
    seedMessagingGroup('mg-solo', 'solo');
  });

  it('is empty for a clean run', () => {
    const plan = planTeardown(db, env, { agentGroupId: 'ag-doomed' });
    const result = executeTeardown(db, env, plan);
    expect(collectIncomplete(plan, result)).toEqual([]);
  });

  it('reports a failed OneCLI delete — a live vault agent for a dead group', () => {
    env.exec = fakeExec({
      'onecli agents list': {
        ok: true,
        stdout: JSON.stringify({ data: [{ id: 'one-doomed', name: 'Doomed', identifier: 'ag-doomed' }] }),
        stderr: '',
      },
      'onecli agents delete': { ok: false, stdout: '', stderr: 'gateway down' },
    });
    const plan = planTeardown(db, env, { agentGroupId: 'ag-doomed' });
    const result = executeTeardown(db, env, plan);
    expect(collectIncomplete(plan, result).join('\n')).toMatch(/delete-onecli-agent.*gateway down/);
  });

  it('reports an unresolvable folder in residual mode and names the fix', () => {
    // First run removes the row; the folder is now unrecoverable from the DB.
    const first = planTeardown(db, env, { agentGroupId: 'ag-doomed' });
    executeTeardown(db, env, first);
    fs.mkdirSync(path.join(tmp, 'groups', 'doomed'), { recursive: true }); // survived the rm

    const second = planTeardown(db, env, { agentGroupId: 'ag-doomed' });
    const lines = collectIncomplete(second, executeTeardown(db, env, second));
    expect(lines.join('\n')).toMatch(/--id ag-doomed --folder <name> --yes/);
    expect(fs.existsSync(path.join(tmp, 'groups', 'doomed'))).toBe(true);

    // ...and supplying it finishes the job, which is the whole point.
    const third = planTeardown(db, env, { agentGroupId: 'ag-doomed', folder: 'doomed' });
    expect(collectIncomplete(third, executeTeardown(db, env, third))).toEqual([]);
    expect(fs.existsSync(path.join(tmp, 'groups', 'doomed'))).toBe(false);
  });
});

// ── Reporting ───────────────────────────────────────────────────────────────

describe('findOrphans', () => {
  it('reports a group session directory with no sessions rows', () => {
    seedGroup('ag-quiet', 'Quiet', 'quiet');
    fs.mkdirSync(path.join(tmp, 'data', 'v2-sessions', 'ag-quiet'), { recursive: true });
    const orphans = findOrphans(db, env);
    expect(orphans.sessionDirs).toEqual([
      {
        path: path.join(tmp, 'data', 'v2-sessions', 'ag-quiet'),
        reason: 'agent group has no sessions rows and no session subdirectories',
      },
    ]);
  });

  it('ignores .claude-shared when deciding what is a session directory', () => {
    seedGroup('ag-quiet', 'Quiet', 'quiet');
    fs.mkdirSync(path.join(tmp, 'data', 'v2-sessions', 'ag-quiet', '.claude-shared'), { recursive: true });
    const orphans = findOrphans(db, env);
    // .claude-shared is shared group state, not a session — it must neither be
    // reported as an orphan session nor mask an otherwise empty group dir.
    expect(orphans.sessionDirs).toEqual([
      {
        path: path.join(tmp, 'data', 'v2-sessions', 'ag-quiet'),
        reason: 'agent group has no sessions rows and no session subdirectories',
      },
    ]);
  });

  it('reports a session directory with no sessions row', () => {
    seedGroup('ag-live', 'Live', 'live');
    seedMessagingGroup('mg-live', 'live');
    seedSession('sess-live', 'ag-live', 'mg-live');
    fs.mkdirSync(path.join(tmp, 'data', 'v2-sessions', 'ag-live', 'sess-gone'), { recursive: true });
    const orphans = findOrphans(db, env);
    expect(orphans.sessionDirs).toEqual([
      { path: path.join(tmp, 'data', 'v2-sessions', 'ag-live', 'sess-gone'), reason: 'no sessions row' },
    ]);
  });

  it('reports a directory with no agent_groups row at all', () => {
    fs.mkdirSync(path.join(tmp, 'data', 'v2-sessions', 'ag-ghost'), { recursive: true });
    const orphans = findOrphans(db, env);
    expect(orphans.sessionDirs[0]).toEqual({
      path: path.join(tmp, 'data', 'v2-sessions', 'ag-ghost'),
      reason: 'no agent_groups row',
    });
  });

  it('separates already-orphaned messaging groups from ones this teardown orphans', () => {
    seedGroup('ag-doomed', 'Doomed', 'doomed');
    seedMessagingGroup('mg-solo', 'solo');
    seedMessagingGroup('mg-dead', 'dead');
    db.prepare(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, session_mode, created_at)
       VALUES ('w1', 'mg-solo', 'ag-doomed', 'shared', ?)`,
    ).run(now());
    const orphans = findOrphans(db, env, { excludeAgentGroupId: 'ag-doomed' });
    const byId = Object.fromEntries(orphans.messagingGroups.map((m) => [m.id, m.reason]));
    expect(byId['mg-dead']).toBe('already has no wiring');
    expect(byId['mg-solo']).toBe('would have no wiring after this teardown');
  });
});

describe('scanProseReferences', () => {
  it('flags the group name and the referring local_name with file:line', () => {
    seedGroup('ag-doomed', 'Aurora', 'doomed');
    seedGroup('ag-keeper', 'Mjollnir', 'keeper');
    fs.writeFileSync(
      path.join(tmp, 'groups', 'keeper', 'CLAUDE.md'),
      'intro\nquerying Aurora is mandatory\nunrelated\n',
    );
    fs.writeFileSync(path.join(tmp, 'groups', 'keeper', 'CLAUDE.local.md'), 'send to oracle every morning\n');
    fs.writeFileSync(path.join(tmp, 'groups', 'doomed', 'CLAUDE.md'), 'I am Aurora\n');

    const { references } = scanProseReferences(
      env,
      {
        deletedFolder: 'doomed',
        deletedName: 'Aurora',
        inboundDestinations: [
          { agent_group_id: 'ag-keeper', local_name: 'oracle', target_type: 'agent', target_id: 'ag-doomed' },
        ],
      },
      (id) => (id === 'ag-keeper' ? 'keeper' : null),
    );

    expect(references).toEqual([
      {
        file: path.join(tmp, 'groups', 'keeper', 'CLAUDE.local.md'),
        line: 1,
        term: 'oracle',
        text: 'send to oracle every morning',
      },
      {
        file: path.join(tmp, 'groups', 'keeper', 'CLAUDE.md'),
        line: 2,
        term: 'Aurora',
        text: 'querying Aurora is mandatory',
      },
    ]);
  });

  it('scans per-group skills, not just top-level CLAUDE files', () => {
    seedGroup('ag-doomed', 'Aurora', 'doomed');
    seedGroup('ag-keeper', 'Mjollnir', 'keeper');
    const skillDir = path.join(tmp, 'groups', 'keeper', 'skills', 'morning-report');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'name: morning\n\nQuerying Aurora is mandatory.\n');
    // Bounded on purpose: only SKILL.md, only one level down.
    fs.writeFileSync(path.join(skillDir, 'notes.md'), 'Aurora again\n');
    fs.mkdirSync(path.join(tmp, 'groups', 'keeper', 'workspace'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'groups', 'keeper', 'workspace', 'CLAUDE.md'), 'Aurora in a workspace\n');

    const { references } = scanProseReferences(
      env,
      { deletedFolder: 'doomed', deletedName: 'Aurora', inboundDestinations: [] },
      () => null,
    );

    expect(references).toEqual([
      { file: path.join(skillDir, 'SKILL.md'), line: 3, term: 'Aurora', text: 'Querying Aurora is mandatory.' },
    ]);
  });

  it('skips the deleted group own folder and refuses dangerously short terms', () => {
    seedGroup('ag-doomed', 'Ai', 'doomed');
    seedGroup('ag-keeper', 'Keeper', 'keeper');
    fs.writeFileSync(path.join(tmp, 'groups', 'keeper', 'CLAUDE.md'), 'Ai everywhere\n');
    const { references, warnings } = scanProseReferences(
      env,
      { deletedFolder: 'doomed', deletedName: 'Ai', inboundDestinations: [] },
      () => null,
    );
    expect(references).toEqual([]);
    expect(warnings.join()).toMatch(/too short/);
  });
});

describe('findStaleMirrors', () => {
  it('reports mirrors in other groups inbound.db and reads nothing of ours', () => {
    const dir = path.join(tmp, 'data', 'v2-sessions', 'ag-keeper', 'sess-keeper');
    fs.mkdirSync(dir, { recursive: true });
    const mirror = new Database(path.join(dir, 'inbound.db'));
    mirror.exec(
      `CREATE TABLE destinations (name TEXT PRIMARY KEY, display_name TEXT, type TEXT NOT NULL,
        channel_type TEXT, platform_id TEXT, agent_group_id TEXT)`,
    );
    mirror
      .prepare(`INSERT INTO destinations (name, type, agent_group_id) VALUES ('oracle', 'agent', 'ag-doomed')`)
      .run();
    mirror.prepare(`INSERT INTO destinations (name, type, agent_group_id) VALUES ('other', 'agent', 'ag-x')`).run();
    mirror.close();

    const { mirrors } = findStaleMirrors(env, 'ag-doomed');
    expect(mirrors).toEqual([
      {
        path: path.join(dir, 'inbound.db'),
        agentGroupId: 'ag-keeper',
        sessionId: 'sess-keeper',
        name: 'oracle',
      },
    ]);

    // Report-only: the row is still there afterwards.
    const check = new Database(path.join(dir, 'inbound.db'), { readonly: true });
    expect(check.prepare(`SELECT COUNT(*) AS n FROM destinations`).get()).toEqual({ n: 2 });
    check.close();
  });
});
