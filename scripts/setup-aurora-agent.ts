/**
 * Set up the Aurora agent group (skylight-morning) in the central DB.
 *
 * Aurora is a morning briefing assistant powered by the Skylight MCP server.
 * Credentials (email + password) come from ~/.config/skylight/credentials.env;
 * the token is never a static env var — Aurora calls `authenticate` on 401.
 *
 * Idempotent — safe to run multiple times for the agent group row, group
 * filesystem, packages_apt, and additional_mounts (all no-op or additive on
 * re-run). `mcp_servers` is the exception: it is a wholesale JSON-column
 * overwrite (see updateContainerConfigJson), so a naive re-run can silently
 * discard hand-tuned live state (TASK-27 — this happened for real with
 * PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH). That write is therefore gated by
 * scripts/mcp-servers-guard.ts: diff-and-confirm by default, --force to
 * skip the prompt, --dry-run to preview without writing. See that file's
 * header comment for the full rationale.
 *
 * Usage:
 *   pnpm exec tsx scripts/setup-aurora-agent.ts [--force] [--dry-run]
 *
 * Flags:
 *   --force     Skip the confirmation prompt; overwrite mcp_servers even if
 *               the stored value diverges from what this run would write.
 *   --dry-run   Print the mcp_servers diff (if any) and exit without
 *               writing it. Other steps (packages_apt, mount, filesystem
 *               scaffold) still run — they carry no hand-tuned state today.
 *
 * Exit codes:
 *   0  completed (including a clean --dry-run)
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
import { confirmOverwrite, getStoredMcpServers, planMcpServersUpdate, writeMcpServers } from './mcp-servers-guard.js';
import { skylightBootstrapLine } from './skylight-mcp-bootstrap.js';
import type { AgentGroup } from '../src/types.js';

function parseArgs(argv: string[]): { force: boolean; dryRun: boolean } {
  let force = false;
  let dryRun = false;
  for (const a of argv) {
    if (a === '--force') force = true;
    else if (a === '--dry-run') dryRun = true;
    else {
      console.error(`Unknown argument: ${a}`);
      console.error('usage: pnpm exec tsx scripts/setup-aurora-agent.ts [--force] [--dry-run]');
      process.exit(1);
    }
  }
  return { force, dryRun };
}

const FOLDER = 'skylight-morning';
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

async function main(): Promise<void> {
  const { force, dryRun } = parseArgs(process.argv.slice(2));
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db); // idempotent

  // Read Skylight credentials from host filesystem before any DB work.
  const { email, password, frameId } = readSkylightEnv();
  console.log(`Skylight credentials loaded (frame: ${frameId})`);

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
  //     No skylight-config mount — credentials come via env vars, token cached in /workspace.
  updateContainerConfigJson(ag.id, 'additional_mounts', [
    {
      hostPath: SKYLIGHT_REPO,
      containerPath: 'skylight', // relative → /workspace/extra/skylight
      readonly: true,
    },
  ]);
  console.log('Skylight repo mount configured (relative path: skylight).');

  // 3c. MCP server: install wheel into a versioned venv, pass credentials as env vars.
  //     Token is never a static env var — Aurora calls `authenticate` on 401.
  //     This write is gated (TASK-27) — see scripts/mcp-servers-guard.ts.
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

  const existingMcpServers = getStoredMcpServers(db, ag.id);
  const plan = planMcpServersUpdate({ existing: existingMcpServers, next: nextMcpServers, force, dryRun });

  switch (plan.kind) {
    case 'write':
      writeMcpServers(db, ag.id, nextMcpServers);
      console.log(`Skylight MCP server configured (python venv + email/password env vars; reason: ${plan.reason}).`);
      break;
    case 'dry-run':
      console.log(`[dry-run] mcp_servers not written (${plan.reason}).`);
      console.log(plan.diff);
      console.log('[dry-run] exiting without writing mcp_servers. Re-run with --force to apply, or without --dry-run to confirm interactively.');
      return;
    case 'needs-confirmation':
      if (process.stdin.isTTY) {
        const confirmed = await confirmOverwrite(plan.diff);
        if (!confirmed) {
          console.error('Aborted: mcp_servers left unchanged. Re-run with --force to overwrite without prompting.');
          process.exitCode = 1;
          return;
        }
        writeMcpServers(db, ag.id, nextMcpServers);
        console.log('Skylight MCP server configured (operator confirmed overwrite).');
      } else {
        console.error(
          'Refusing to overwrite stored mcp_servers: it differs from what this seeder would write, and ' +
            'stdin is not a TTY (non-interactive-safe refusal). Pass --force to overwrite anyway, or ' +
            '--dry-run to inspect the diff without writing.',
        );
        console.error(plan.diff);
        process.exitCode = 1;
        return;
      }
      break;
  }

  console.log('');
  console.log('Aurora agent group setup complete.');
  console.log(`  agent group: ${ag.name} [${ag.id}]`);
  console.log(`  folder:      groups/${FOLDER}/`);
  console.log(`  MCP server:  skylight (python venv, email+password from env, token cached in /workspace)`);
  console.log(`  mount:       ${SKYLIGHT_REPO} → /workspace/extra/skylight (ro, relative)`);
  console.log('');
  console.log('Next steps:');
  console.log('  - Task 2: populate groups/skylight-morning/CLAUDE.local.md');
  console.log('  - Wire a messaging group when ready to test');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
