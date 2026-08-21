/**
 * DEPRECATED — use `scripts/delete-agent-group.ts`.
 *
 * This script was named for setup's ping-pong scratch agent but was always a
 * generic agent-group teardown. The real implementation now lives in
 * `scripts/delete-agent-group.ts` (plan-by-default, covers containers, inbound
 * destination edges, images and the OneCLI vault agent). This file remains as
 * a thin shim because `setup/auto.ts` invokes it by name.
 *
 * Usage (unchanged):
 *   pnpm exec tsx scripts/delete-cli-agent.ts --folder <folder-name>
 */
import path from 'path';

import { CONTAINER_IMAGE_BASE, CONTAINER_INSTALL_LABEL, DATA_DIR, GROUPS_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { defaultExec, executeTeardown, planTeardown, type TeardownEnv } from '../src/teardown/agent-group-teardown.js';

function parseArgs(): { folder: string } {
  const argv = process.argv.slice(2);
  let folder = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--folder' && argv[i + 1]) folder = argv[++i];
  }
  if (!folder) {
    console.error('usage: pnpm exec tsx scripts/delete-cli-agent.ts --folder <folder-name>');
    process.exit(1);
  }
  return { folder };
}

console.error(
  'scripts/delete-cli-agent.ts is deprecated — use scripts/delete-agent-group.ts --folder <folder> [--yes].',
);

const args = parseArgs();

const db = initDb(path.join(DATA_DIR, 'v2.db'));
runMigrations(db);

const ag = db.prepare('SELECT id FROM agent_groups WHERE folder = ?').get(args.folder) as { id: string } | undefined;
if (!ag) {
  console.log(`No agent group with folder "${args.folder}" — nothing to delete.`);
  process.exit(0);
}

const env: TeardownEnv = {
  dataDir: DATA_DIR,
  groupsDir: GROUPS_DIR,
  containerImageBase: CONTAINER_IMAGE_BASE,
  containerInstallLabel: CONTAINER_INSTALL_LABEL,
  exec: defaultExec,
};

// Folder resolution happens before the row is deleted — preserved from the
// original script, and the reason the plan captures the folder up front.
const plan = planTeardown(db, env, { folder: args.folder });
const result = executeTeardown(db, env, plan);
for (const w of result.warnings) console.error(`warning: ${w}`);

console.log(`Deleted agent group ${plan.agentGroupId} (${args.folder}).`);
