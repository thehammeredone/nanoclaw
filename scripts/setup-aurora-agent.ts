/**
 * Set up the Aurora agent group (skylight-morning) in the central DB.
 *
 * Aurora is a morning briefing assistant powered by the Skylight MCP server.
 * The Skylight MCP token is at ~/.config/skylight/token.env and config.env
 * (SKYLIGHT_FRAME_ID=3964300, SKYLIGHT_AUTH_SCHEME=bearer).
 *
 * Idempotent — safe to run multiple times. Logs "Created" vs "Reusing" for
 * the agent group row.
 *
 * Usage:
 *   pnpm exec tsx scripts/setup-aurora-agent.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR, MOUNT_ALLOWLIST_PATH } from '../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { ensureContainerConfig, updateContainerConfigJson } from '../src/db/container-configs.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { initGroupFilesystem } from '../src/group-init.js';
import type { AgentGroup } from '../src/types.js';

const FOLDER = 'skylight-morning';
const NAME = 'Aurora';

const SKYLIGHT_REPO = '/home/hammer/git/Skylight';

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function readSkylightEnv(): { token: string; authScheme: string; frameId: string } {
  const configPath = path.join(os.homedir(), '.config', 'skylight', 'config.env');
  const tokenPath = path.join(os.homedir(), '.config', 'skylight', 'token.env');

  let frameId = '';
  let token = '';
  let authScheme = 'bearer';

  const parseEnvFile = (filePath: string) => {
    if (!fs.existsSync(filePath)) return;
    for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
      const m = line.match(/^export\s+(\w+)=['"]?([^'"]+)['"]?\s*$/);
      if (!m) continue;
      if (m[1] === 'SKYLIGHT_TOKEN') token = m[2];
      if (m[1] === 'SKYLIGHT_FRAME_ID') frameId = m[2];
      if (m[1] === 'SKYLIGHT_AUTH_SCHEME') authScheme = m[2];
    }
  };

  parseEnvFile(configPath);
  parseEnvFile(tokenPath); // token.env wins (last write wins)

  if (!token)
    throw new Error(
      'SKYLIGHT_TOKEN not found in ~/.config/skylight/token.env. Run the Skylight capture tool first.',
    );
  if (!frameId)
    throw new Error(
      'SKYLIGHT_FRAME_ID not found. Re-run capture with auto-detect or set it manually in ~/.config/skylight/config.env.',
    );

  return { token, authScheme, frameId };
}

function ensureSkylightMountAllowlisted(): void {
  type AllowlistEntry = { path: string; allowReadWrite: boolean; description?: string };
  type Allowlist = {
    allowedRoots: AllowlistEntry[];
    blockedPatterns: string[];
    nonMainReadOnly?: boolean;
  };

  let allowlist: Allowlist;
  try {
    allowlist = JSON.parse(fs.readFileSync(MOUNT_ALLOWLIST_PATH, 'utf8')) as Allowlist;
  } catch {
    allowlist = { allowedRoots: [], blockedPatterns: [] };
  }

  const alreadyAllowed = allowlist.allowedRoots.some((r) => r.path === SKYLIGHT_REPO);
  if (!alreadyAllowed) {
    allowlist.allowedRoots.push({
      path: SKYLIGHT_REPO,
      allowReadWrite: false,
      description: 'Skylight MCP server source (Aurora morning report)',
    });
    fs.mkdirSync(path.dirname(MOUNT_ALLOWLIST_PATH), { recursive: true });
    fs.writeFileSync(MOUNT_ALLOWLIST_PATH, JSON.stringify(allowlist, null, 2) + '\n');
    console.log('Updated mount allowlist: added Skylight repo');
  } else {
    console.log('Mount allowlist: Skylight repo already present');
  }
}

const PLACEHOLDER_INSTRUCTIONS =
  '# Aurora\n\nYou are Aurora, a morning briefing assistant for Hammer. Full instructions coming in Task 2.\n';

function main(): void {
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db); // idempotent

  // Read Skylight credentials from host filesystem before any DB work.
  const { token, authScheme, frameId } = readSkylightEnv();
  console.log(`Skylight token loaded (frame: ${frameId}, scheme: ${authScheme})`);

  // Ensure the Skylight repo is in the mount allowlist.
  ensureSkylightMountAllowlisted();

  const now = new Date().toISOString();

  // 1. Agent group — get or create.
  let ag: AgentGroup | undefined = getAgentGroupByFolder(FOLDER);
  if (!ag) {
    const agId = generateId('ag');
    createAgentGroup({
      id: agId,
      name: NAME,
      folder: FOLDER,
      agent_provider: null,
      created_at: now,
    });
    ag = getAgentGroupByFolder(FOLDER)!;
    console.log(`Created agent group: ${ag.id} (${FOLDER})`);
  } else {
    console.log(`Reusing agent group: ${ag.id} (${FOLDER})`);
  }

  // 2. Initialize group filesystem (groups/skylight-morning/ + CLAUDE.local.md).
  //    initGroupFilesystem is idempotent — it skips files that already exist.
  initGroupFilesystem(ag, { instructions: PLACEHOLDER_INSTRUCTIONS });
  console.log(`Group filesystem initialized: groups/${FOLDER}/`);

  // 3. Ensure container config row exists, then configure everything.
  //    ensureContainerConfig is idempotent (INSERT OR IGNORE).
  ensureContainerConfig(ag.id);

  // 3a. Python packages for running the Skylight MCP server.
  updateContainerConfigJson(ag.id, 'packages_apt', ['python3', 'python3-pip', 'python3-venv']);
  console.log('python3 + python3-pip + python3-venv added to packages_apt.');

  // 3b. Mount the Skylight repo (relative containerPath → /workspace/extra/skylight).
  updateContainerConfigJson(ag.id, 'additional_mounts', [
    {
      hostPath: SKYLIGHT_REPO,
      containerPath: 'skylight', // relative → /workspace/extra/skylight
      readonly: true,
    },
  ]);
  console.log('Skylight repo mount configured (relative path: skylight).');

  // 3c. MCP server: install wheel into a venv cached under /workspace, then run.
  //     Token injected as env vars — no credential file mount.
  updateContainerConfigJson(ag.id, 'mcp_servers', {
    skylight: {
      command: 'bash',
      args: [
        '-lc',
        '[ -d /workspace/.skylight-env ] || (python3 -m venv /workspace/.skylight-env && /workspace/.skylight-env/bin/pip install -q /workspace/extra/skylight/dist/skylight-0.2.0-py3-none-any.whl); cd /workspace/extra/skylight && exec /workspace/.skylight-env/bin/python -m server',
      ],
      env: {
        SKYLIGHT_TOKEN: token,
        SKYLIGHT_AUTH_SCHEME: authScheme,
        SKYLIGHT_FRAME_ID: frameId,
      },
    },
  });
  console.log('Skylight MCP server configured (python venv + env-var token).');

  console.log('');
  console.log('Aurora agent group setup complete.');
  console.log(`  agent group: ${ag.name} [${ag.id}]`);
  console.log(`  folder:      groups/${FOLDER}/`);
  console.log(`  MCP server:  skylight (python venv, token from env)`);
  console.log(`  mount:       ${SKYLIGHT_REPO} → /workspace/extra/skylight (ro, relative)`);
  console.log('');
  console.log('Next steps:');
  console.log('  - Task 2: populate groups/skylight-morning/CLAUDE.local.md');
  console.log('  - Wire a messaging group when ready to test');
}

main();
