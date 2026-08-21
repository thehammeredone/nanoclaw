/**
 * Tear down an agent group — the real, complete teardown.
 *
 * `ncl groups delete` cannot do this: it is a bare DELETE against
 * `agent_groups` with `foreign_keys = ON`, and every group that has ever been
 * wired or run has blocking references. This script kills containers, deletes
 * rows in an FK-safe order, removes the group and session directories, drops
 * the per-group image tag and the OneCLI vault agent, and reports the things
 * that must not be automated (prose references, orphans, stale mirrors).
 *
 * Safe by default: prints a plan and changes nothing unless `--yes` is given.
 * Idempotent: re-run after a partial failure with `--id`.
 *
 * Usage:
 *   pnpm exec tsx scripts/delete-agent-group.ts --id <agent-group-id>          # plan
 *   pnpm exec tsx scripts/delete-agent-group.ts --folder <folder>              # plan
 *   pnpm exec tsx scripts/delete-agent-group.ts --id <agent-group-id> --yes    # execute
 *
 * Flags:
 *   --id <id>        Agent group id. Works even when the row is already gone.
 *   --folder <name>  Resolve by groups/<folder>. Requires the row to still exist.
 *   --yes            Actually execute the plan.
 *   --keep-onecli    Leave the OneCLI vault agent alone.
 *   --keep-images    Leave the per-group docker image tag alone.
 *
 * Deletion order and FK evidence: docs/runbooks/agent-group-teardown.md
 */
import path from 'path';

import { CONTAINER_IMAGE_BASE, CONTAINER_INSTALL_LABEL, DATA_DIR, GROUPS_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import {
  defaultExec,
  executeTeardown,
  planTeardown,
  renderPlan,
  type TeardownEnv,
} from '../src/teardown/agent-group-teardown.js';

const USAGE = `usage: pnpm exec tsx scripts/delete-agent-group.ts (--id <agent-group-id> | --folder <folder>) [--yes] [--keep-onecli] [--keep-images]`;

function parseArgs() {
  const argv = process.argv.slice(2);
  let id = '';
  let folder = '';
  let yes = false;
  let keepOnecli = false;
  let keepImages = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--id' && argv[i + 1]) id = argv[++i];
    else if (a === '--folder' && argv[i + 1]) folder = argv[++i];
    else if (a === '--yes') yes = true;
    else if (a === '--keep-onecli') keepOnecli = true;
    else if (a === '--keep-images') keepImages = true;
    else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}\n${USAGE}`);
      process.exit(1);
    }
  }
  if (!id && !folder) {
    console.error(USAGE);
    process.exit(1);
  }
  return { id, folder, yes, keepOnecli, keepImages };
}

const args = parseArgs();

const db = initDb(path.join(DATA_DIR, 'v2.db'));
runMigrations(db);

const env: TeardownEnv = {
  dataDir: DATA_DIR,
  groupsDir: GROUPS_DIR,
  containerImageBase: CONTAINER_IMAGE_BASE,
  containerInstallLabel: CONTAINER_INSTALL_LABEL,
  exec: defaultExec,
};

let plan;
try {
  plan = planTeardown(db, env, {
    agentGroupId: args.id || undefined,
    folder: args.folder || undefined,
    keepOnecli: args.keepOnecli,
    keepImages: args.keepImages,
  });
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

console.log(renderPlan(plan));

if (!args.yes) {
  console.log('');
  console.log('DRY RUN — nothing was changed. Re-run with --yes to execute.');
  process.exit(0);
}

console.log('');
console.log('EXECUTING');
console.log('─────────');
const result = executeTeardown(db, env, plan);
for (const s of result.steps) console.log(`  ${s.step}: ${s.detail}`);
if (result.warnings.length > 0) {
  console.log('');
  console.log('WARNINGS');
  console.log('────────');
  for (const w of result.warnings) console.log(`  ${w}`);
}
console.log('');
console.log(`Torn down agent group ${plan.agentGroupId}${plan.folder ? ` (${plan.folder})` : ''}.`);
if (plan.proseReferences.length > 0) {
  console.log(`Follow up: ${plan.proseReferences.length} prose reference(s) in surviving groups — see the plan above.`);
}
if (plan.orphans.messagingGroups.length > 0) {
  console.log(`Follow up: ${plan.orphans.messagingGroups.length} messaging group(s) now have no wiring.`);
}
// Exit 0 even with warnings: the DB teardown is transactional, and the
// remaining steps (docker, OneCLI) are best-effort and re-runnable. Callers
// that care read the WARNINGS block. `setup/auto.ts` treats a non-zero exit
// from the delete-cli-agent shim as a setup failure.
process.exit(0);
