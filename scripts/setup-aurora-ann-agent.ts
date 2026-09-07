/**
 * Set up Aurora's second instance (skylight-morning-ann) in the central DB —
 * same persona and Skylight MCP wiring as scripts/setup-aurora-agent.ts,
 * targeted at Ann's Matrix DM instead of Hammer's, filtered to Mom's Skylight
 * category instead of Dad's.
 *
 * Duplicated from setup-aurora-agent.ts rather than sharing a module (decided
 * 2026-09-06 — see Task 5 in docs/superpowers/plans/2026-09-03-aurora-ann-split.md).
 * decideSeederOutcome/runSeeder ARE reused via import below — those were
 * already exported from the original script for its own test suite, not
 * newly extracted for this split.
 *
 * Credentials (email + password) come from ~/.config/skylight/credentials.env;
 * the token is never a static env var — Aurora calls `authenticate` on 401.
 *
 * Idempotent — safe to re-run. The `mcp_servers` decision (write directly,
 * refuse, or preview) is made BEFORE any mutating step runs (TASK-27 review,
 * N1/F2): a refusal or `--dry-run` genuinely writes nothing anywhere — no
 * agent group, no group filesystem, no mount-allowlist edit, no
 * `packages_apt`/`additional_mounts` write. That write used to be an
 * unconditional JSON-column overwrite (see `updateContainerConfigJson`), so a
 * naive re-run could silently discard hand-tuned live state (TASK-27 — this
 * happened for real with PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH). It is now
 * gated by scripts/mcp-servers-guard.ts: diff-and-confirm by default,
 * --force to skip the prompt, --dry-run to preview without writing anything.
 * See that file's header comment for the full rationale.
 *
 * Usage:
 *   pnpm exec tsx scripts/setup-aurora-ann-agent.ts [--force] [--dry-run]
 *
 * Flags:
 *   --force     Skip the confirmation prompt; overwrite mcp_servers even if
 *               the stored value diverges from what this run would write.
 *   --dry-run   Print the mcp_servers diff (if any) and exit. Writes nothing
 *               — not mcp_servers, not the agent group, not the group
 *               filesystem, not packages_apt/additional_mounts, not the
 *               mount allowlist file.
 *
 * Exit codes:
 *   0  completed, INCLUDING a --dry-run that found divergence. --dry-run's
 *      exit code deliberately does not encode "divergence found vs none" —
 *      it is a preview tool, not a CI check; parse stdout (or grep for
 *      "diverges-from-live") if automation needs that signal. This is a
 *      deliberate choice (TASK-27 review, F7), not an oversight.
 *   1  refused to overwrite a divergent mcp_servers without --force
 *      (non-interactive), or the operator declined the confirmation prompt
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
import {
  confirmOverwrite,
  getStoredMcpServers,
  planMcpServersUpdate,
  writeMcpServers,
} from './mcp-servers-guard.js';
import { decideSeederOutcome, runSeeder } from './setup-aurora-agent.js';
import { skylightBootstrapLine } from './skylight-mcp-bootstrap.js';
import type { AgentGroup } from '../src/types.js';
import type Database from 'better-sqlite3';

function parseArgs(argv: string[]): { force: boolean; dryRun: boolean } {
  let force = false;
  let dryRun = false;
  for (const a of argv) {
    if (a === '--force') force = true;
    else if (a === '--dry-run') dryRun = true;
    else {
      console.error(`Unknown argument: ${a}`);
      console.error('usage: pnpm exec tsx scripts/setup-aurora-ann-agent.ts [--force] [--dry-run]');
      process.exit(1);
    }
  }
  return { force, dryRun };
}

const FOLDER = 'skylight-morning-ann';
const NAME = 'Aurora';

const SKYLIGHT_REPO = '/home/hammer/git/Skylight';

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function readSkylightEnv(): { email: string; password: string; frameId: string } {
  const configPath = path.join(os.homedir(), '.config', 'skylight', 'config.env');
  const credsPath = path.join(os.homedir(), '.config', 'skylight', 'credentials.env');

  let email = '';
  let password = '';
  let frameId = '';

  function parseEnvFile(filePath: string) {
    try {
      for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
        const m = line.match(/^export\s+(\w+)=(.*)$/);
        if (!m) continue;
        const val = m[2].replace(/^['"]|['"]$/g, '').trim();
        if (m[1] === 'SKYLIGHT_EMAIL') email = val;
        if (m[1] === 'SKYLIGHT_PASSWORD') password = val;
        if (m[1] === 'SKYLIGHT_FRAME_ID') frameId = val;
      }
    } catch { /* ignore missing */ }
  }

  parseEnvFile(configPath);
  parseEnvFile(credsPath);

  if (!email || !password)
    throw new Error('SKYLIGHT_EMAIL/SKYLIGHT_PASSWORD not found in ~/.config/skylight/credentials.env');
  if (!frameId)
    throw new Error('SKYLIGHT_FRAME_ID not found in ~/.config/skylight/config.env');

  return { email, password, frameId };
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
      description: 'Skylight MCP server source (Aurora morning report, Ann instance)',
    });
    fs.mkdirSync(path.dirname(MOUNT_ALLOWLIST_PATH), { recursive: true });
    fs.writeFileSync(MOUNT_ALLOWLIST_PATH, JSON.stringify(allowlist, null, 2) + '\n');
    console.log('Updated mount allowlist: added Skylight repo');
  } else {
    console.log('Mount allowlist: Skylight repo already present');
  }
}

const PLACEHOLDER_INSTRUCTIONS =
  '# Aurora\n\nYou are Aurora, a morning briefing assistant for Ann. Full instructions coming in the next task.\n';

async function main(): Promise<void> {
  const { force, dryRun } = parseArgs(process.argv.slice(2));
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db); // idempotent

  // Read Skylight credentials from host filesystem before any DB work.
  const { email, password, frameId } = readSkylightEnv();
  console.log(`Skylight credentials loaded (frame: ${frameId})`);

  const nextMcpServers = {
    skylight: {
      command: 'bash',
      args: [
        '-lc',
        // Canonical definition: scripts/skylight-mcp-bootstrap.sh (single source of
        // truth, with the full rationale). This column is only a materialized copy —
        // the container cannot read this repo, so the line has to be inlined here.
        // scripts/skylight-mcp-bootstrap.test.ts checks this against the .sh, but only
        // with SKYLIGHT_LIVE_DB_CHECK=1 (see docs/runbooks/aurora-skylight-mcp.md).
        skylightBootstrapLine(),
      ],
      env: {
        SKYLIGHT_EMAIL: email,
        SKYLIGHT_PASSWORD: password,
        SKYLIGHT_FRAME_ID: frameId,
        SKYLIGHT_TOKEN_ENV_PATH: '/workspace/.skylight/token.env',
        // pip doesn't honor NODE_EXTRA_CA_CERTS/SSL_CERT_FILE (those are JS/Deno-only) —
        // without this, any dependency not already in the wheel fails cert verification
        // against the OneCLI proxy's self-signed intercepting cert.
        PIP_CERT: '/tmp/onecli-combined-ca.pem',
        // Playwright Python ignores the image-level env var of the same name (it is a
        // Playwright-JS convention), so server/token_capture.py reads it itself. Without
        // it `authenticate` fails with "Executable doesn't exist at .../ms-playwright/…".
        // Present in the live DB row since TASK-5; re-stated here so re-running the
        // seeder does not silently drop it.
        PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/usr/bin/chromium',
      },
    },
  };

  // Decide the mcp_servers plan BEFORE any mutating step (TASK-27 review,
  // N1/F2): a refusal or --dry-run must leave the DB and filesystem
  // untouched. If the agent group doesn't exist yet, there is by definition
  // no stored mcp_servers to protect — no need to create it first to find
  // that out.
  const existingAg = getAgentGroupByFolder(FOLDER);
  const existingMcpServers = existingAg ? getStoredMcpServers(db, existingAg.id) : undefined;
  const plan = planMcpServersUpdate({ existing: existingMcpServers, next: nextMcpServers, force, dryRun });

  let interactiveConfirmResult: boolean | 'non-interactive' | undefined;
  if (plan.kind === 'needs-confirmation') {
    if (process.stdin.isTTY) {
      interactiveConfirmResult = await confirmOverwrite(plan.diff);
    } else {
      interactiveConfirmResult = 'non-interactive';
    }
  }
  const outcome = decideSeederOutcome(plan, interactiveConfirmResult);

  const { exitCode } = runSeeder({
    plan,
    outcome,
    mutate: () => mutateForSeeder(db, existingAg),
    writeMcp: (ag) => writeMcpServers(db, ag.id, nextMcpServers),
    log: (line) => console.log(line),
    logError: (line) => console.error(line),
  });
  process.exitCode = exitCode;
}

/** Every mutating step other than the mcp_servers write. Only called when the outcome is 'proceed'. */
function mutateForSeeder(db: Database.Database, existingAg: AgentGroup | undefined): AgentGroup {
  ensureSkylightMountAllowlisted();

  const now = new Date().toISOString();
  let ag = existingAg;
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

  // Initialize group filesystem (groups/skylight-morning-ann/ + CLAUDE.local.md).
  // initGroupFilesystem is idempotent — it skips files that already exist.
  initGroupFilesystem(ag, { instructions: PLACEHOLDER_INSTRUCTIONS });
  console.log(`Group filesystem initialized: groups/${FOLDER}/`);

  // Ensure container config row exists, then configure everything.
  // ensureContainerConfig is idempotent (INSERT OR IGNORE).
  ensureContainerConfig(ag.id);

  // Python packages for running the Skylight MCP server.
  updateContainerConfigJson(ag.id, 'packages_apt', ['python3', 'python3-pip', 'python3-venv']);
  console.log('python3 + python3-pip + python3-venv added to packages_apt.');

  // Mount the Skylight repo (relative containerPath → /workspace/extra/skylight).
  // No skylight-config mount — credentials come via env vars, token cached in /workspace.
  updateContainerConfigJson(ag.id, 'additional_mounts', [
    {
      hostPath: SKYLIGHT_REPO,
      containerPath: 'skylight', // relative → /workspace/extra/skylight
      readonly: true,
    },
  ]);
  console.log('Skylight repo mount configured (relative path: skylight).');

  return ag;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
