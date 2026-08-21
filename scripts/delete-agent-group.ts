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
 * Re-runnable: a second run re-plans against whatever is left ("residual
 * mode"). Residual mode cannot recover the folder from the DB, so pass
 * `--folder <name>` alongside `--id` to finish removing `groups/<folder>/`.
 *
 * Usage:
 *   pnpm exec tsx scripts/delete-agent-group.ts --id <agent-group-id>          # plan
 *   pnpm exec tsx scripts/delete-agent-group.ts --folder <folder>              # plan
 *   pnpm exec tsx scripts/delete-agent-group.ts --id <agent-group-id> --yes    # execute
 *   pnpm exec tsx scripts/delete-agent-group.ts --id <id> --folder <name> --yes  # resume
 *
 * Flags:
 *   --id <id>        Agent group id. Works even when the row is already gone.
 *   --folder <name>  Resolve by groups/<folder>. Also supplements --id in
 *                    residual mode, where the folder is otherwise unknown.
 *   --yes            Actually execute the plan.
 *   --keep-onecli    Leave the OneCLI vault agent alone.
 *   --keep-images    Leave the per-group docker image tag alone.
 *
 * Exit codes:
 *   0  plan printed (dry run), or executed with every step complete
 *   1  usage error, or the target could not be resolved (nothing ran)
 *   2  executed but INCOMPLETE — the DB half committed, but at least one of
 *      the group directory, session directory, image tag, container stop or
 *      OneCLI vault agent was not dealt with — including when discovery of an
 *      image tag or the vault agent itself failed (docker/onecli unreachable).
 *      Read the INCOMPLETE block and re-run. Never treat 2 as success: a
 *      surviving OneCLI agent still holds injectable credentials for a group
 *      that no longer exists.
 *
 * Deletion order and FK evidence: docs/runbooks/agent-group-teardown.md
 */
import path from 'path';

import { CONTAINER_IMAGE_BASE, CONTAINER_INSTALL_LABEL, DATA_DIR, GROUPS_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import {
  collectIncomplete,
  defaultExec,
  executeTeardown,
  planTeardown,
  renderPlan,
  type TeardownEnv,
} from '../src/teardown/agent-group-teardown.js';

const USAGE =
  `usage: pnpm exec tsx scripts/delete-agent-group.ts (--id <agent-group-id> | --folder <folder>) [--yes] [--keep-onecli] [--keep-images]\n` +
  `       pass BOTH --id and --folder to resume a partial teardown (the folder is unrecoverable once the row is gone)\n` +
  `exit:  0 = plan printed / fully torn down · 1 = usage or resolution error · 2 = executed but incomplete`;

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
// Not a success claim — the DB transaction is committed by this point, but
// steps 1 and 8-10 (containers, filesystem, images, OneCLI) are not
// transactional and may still have failed. The INCOMPLETE block below (and
// the exit code) is the actual verdict.
console.log(`DB teardown committed for ${plan.agentGroupId}${plan.folder ? ` (${plan.folder})` : ''}.`);
if (plan.proseReferences.length > 0) {
  console.log(`Follow up: ${plan.proseReferences.length} prose reference(s) in surviving groups — see the plan above.`);
}
if (plan.orphans.messagingGroups.length > 0) {
  console.log(`Follow up: ${plan.orphans.messagingGroups.length} messaging group(s) now have no wiring.`);
}

// Exit code must reflect whether the job actually finished — see
// `collectIncomplete`.
const incomplete = collectIncomplete(plan, result);

if (incomplete.length > 0) {
  console.log('');
  console.log('INCOMPLETE — teardown did not finish');
  console.log('────────────────────────────────────');
  for (const line of incomplete) console.log(`  ${line}`);
  console.log('');
  console.log('Fix the cause and re-run. Exiting 2.');
  process.exit(2);
}

process.exit(0);
