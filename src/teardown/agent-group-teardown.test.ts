import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { closeDb, initTestDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import {
  agentGroupIdTables,
  assertSafePath,
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
    expect(result.warnings).toEqual([]);
    expect(db.prepare(`SELECT id FROM agent_groups`).all()).toEqual([{ id: 'ag-keeper' }]);
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
