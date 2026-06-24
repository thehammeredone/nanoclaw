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
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { ensureContainerConfig, updateContainerConfigJson } from '../src/db/container-configs.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { initGroupFilesystem } from '../src/group-init.js';
import type { AgentGroup } from '../src/types.js';

const FOLDER = 'skylight-morning';
const NAME = 'Aurora';

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const SKYLIGHT_MCP_CONFIG = {
  skylight: {
    command: 'bash',
    args: [
      '-lc',
      'cd /home/hammer/git/Skylight && source ~/.config/skylight/config.env 2>/dev/null; source ~/.config/skylight/token.env 2>/dev/null; exec uv run python -m server',
    ],
    env: {},
  },
};

const PLACEHOLDER_INSTRUCTIONS =
  '# Aurora\n\nYou are Aurora, a morning briefing assistant for Hammer. Full instructions coming in Task 2.\n';

function main(): void {
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db); // idempotent

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

  // 3. Ensure container config row exists, then set the Skylight MCP server.
  //    ensureContainerConfig is idempotent (INSERT OR IGNORE).
  ensureContainerConfig(ag.id);
  updateContainerConfigJson(ag.id, 'mcp_servers', SKYLIGHT_MCP_CONFIG);
  console.log('Skylight MCP server configured in container config.');

  console.log('');
  console.log('Aurora agent group setup complete.');
  console.log(`  agent group: ${ag.name} [${ag.id}]`);
  console.log(`  folder:      groups/${FOLDER}/`);
  console.log(`  MCP server:  skylight (bash -lc ...)`);
  console.log('');
  console.log('Next steps:');
  console.log('  - Task 2: populate groups/skylight-morning/CLAUDE.local.md');
  console.log('  - Wire a messaging group when ready to test');
}

main();
