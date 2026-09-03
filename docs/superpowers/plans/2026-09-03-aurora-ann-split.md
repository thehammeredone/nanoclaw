# Aurora/Ann Split + Matrix Room-Dup Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Ann's Matrix DM from silently getting nothing out of Aurora, fix the Matrix room-recreation-on-restart bug, and tighten Aurora's report-trigger logic — without changing Hammer's existing report.

**Architecture:** Aurora (`ag-1782273071167-th1q6f`, `groups/skylight-morning/`) currently has Ann's Matrix DM wired into its shared session but has zero logic that ever addresses her — `messages_out` shows 53/53 historical sends went to Hammer, 0 to Ann. Rather than teach one session to compose two different reports, we split into two independent, 1:1 agent groups: Aurora keeps serving Hammer only (Dad's chores, category `11606604`), and a new cloned group serves Ann only (Mom's chores, category `11606593`). This is infra/config work, not library code — "tests" below are live verification commands (`ncl … list/get`, DB queries, restart-and-observe), not unit tests. Each task still ends in an independently checkable state and a commit where code changed.

**Tech Stack:** NanoClaw v2 (Node/TypeScript host, `better-sqlite3`, `ncl` admin CLI), Bun-based agent-runner container, Skylight Python MCP server (`/home/hammer/git/Skylight`), Matrix via `@beeper/chat-adapter-matrix`.

**Spec:** None — bounded task, design agreed in chat (2026-09-03 brainstorming session, no separate spec file per the brainstorming skill's bounded path).

## Global Constraints

- Never print `SKYLIGHT_EMAIL`/`SKYLIGHT_PASSWORD` in a command, commit message, or this plan — always read them from `~/.config/skylight/{config,credentials.env}` via code, never inline.
- `hammer` is the dev branch; never merge into `main`. Commit each code change on `hammer`.
- Approval-gated `ncl` commands (`wirings delete`, `destinations remove/add`, `groups create`, `groups config *`) require the user's live approval each time — never batch past a rejection.
- Don't touch `container_configs.mcp_servers` for `ag-1782273071167-th1q6f` (Hammer's Aurora) in this plan — only the new group gets a fresh `mcp_servers` write.
- `docs/runbooks/aurora-skylight-mcp.md` is the source of truth for the Skylight MCP bootstrap mechanics — read it before touching anything Skylight-MCP-related; don't duplicate its content, reference it.

---

## Task 1: Fix Aurora's trigger recognition (Hammer's group)

**Files:**
- Modify: `groups/skylight-morning/CLAUDE.local.md` (already edited this session — see below)

**Interfaces:** None (instructions file, no code contract).

- [x] **Step 1: Edit the Trigger Recognition section**

Already applied this session. Current text in `groups/skylight-morning/CLAUDE.local.md` lines 3-14:

```markdown
You are Aurora, a morning briefing assistant for Hammer. Your purpose is to pull data from the Skylight family management platform and deliver a clear, structured daily morning report.

## Trigger Recognition

Generate the full morning report ONLY in these two cases:

1. **The scheduled 6am wake.** The recurring NanoClaw task fires this automatically — run the procedure below without asking anything.
2. **An explicit, unambiguous ask** for the report itself: "give me the report", "run the report", "morning report", "morning briefing", "daily briefing". Don't require exact wording, but the message must be clearly asking for the report — not just a greeting.

A bare "morning" or "good morning" is a greeting, not a report request — reply conversationally, don't run the full API sequence.

For anything else — follow-up questions about a report already sent, corrections, casual chat, or a request to *change* something in Skylight (mark a chore done, add an item, etc.) — handle it directly through the Skylight MCP tools as a normal request. Don't route it through the report pipeline.
```

- [ ] **Step 2: Verify the diff is exactly this change**

Run: `git -C /home/hammer/git/nanoclaw-v2 diff -- groups/skylight-morning/CLAUDE.local.md`
Expected: only the "Trigger Recognition" section and its intro sentence changed; the rest of the file (Morning Report, Date Calculation, Report Format, Write Tools, error-handling sections) is untouched.

- [ ] **Step 3: Commit**

```bash
cd /home/hammer/git/nanoclaw-v2
git add groups/skylight-morning/CLAUDE.local.md
git commit -m "$(cat <<'EOF'
fix(aurora): narrow report trigger to schedule + explicit ask

Aurora was firing the full report pipeline on any message that
"sounded like" a morning greeting. Narrow it to the scheduled 6am
wake and unambiguous report requests; route everything else
(including Skylight write requests) through the MCP tools directly.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012onPvvM3pd1zi7JNiQWLW4
EOF
)"
```

---

## Task 2: Unwire Ann from Aurora

**Files:** None (central DB rows only, via `ncl`).

**Interfaces:**
- Consumes: `messaging_group_agents.id = '95b041ba-7a62-4d03-82a6-c961bb1f76af'` (Ann's DM ↔ Aurora wiring), `agent_destinations (agent_group_id='ag-1782273071167-th1q6f', local_name='ann')`.
- Produces: Aurora (`ag-1782273071167-th1q6f`) has exactly one wiring (Hammer's) and one destination (`hammer`) afterward. Ann's `messaging_groups` row (`f2cfdd4d-bc63-4ce1-8a0e-cddf3626a394`) is untouched — Task 8 rewires it.

- [ ] **Step 1: Confirm current state**

Run: `ncl wirings get 95b041ba-7a62-4d03-82a6-c961bb1f76af`
Expected: shows `messaging_group_id: f2cfdd4d-...`, `agent_group_id: ag-1782273071167-th1q6f`.

- [ ] **Step 2: Delete the wiring (will prompt for approval)**

Run: `ncl wirings delete 95b041ba-7a62-4d03-82a6-c961bb1f76af`
Expected: approval prompt, then success. If rejected, stop and ask the user why before retrying.

- [ ] **Step 3: Remove the destination (will prompt for approval)**

Run: `ncl destinations remove --agent-group-id ag-1782273071167-th1q6f --local-name ann`
Expected: approval prompt, then success.

- [ ] **Step 4: Verify Aurora is Hammer-only**

Run: `ncl wirings list | grep ag-1782273071167-th1q6f`
Expected: exactly one row, for `mg-1783608739461-4om0w9` (Hammer's DM).

Run: `ncl destinations list | grep ag-1782273071167-th1q6f`
Expected: exactly one row, `local_name=hammer`.

No commit — this is live DB state, not code.

---

## Task 3: Add diagnostic logging for the Matrix room-dup bug

**Context:** `@beeper/chat-adapter-matrix`'s `openDM()` only logs on failure (`withLoggedMatrixOperation` calls `this.logger.error` in the catch block only — success is silent). We cannot tell from existing logs whether `createRoom` has been firing on restart. Add our own success-path log so the next occurrence is caught with evidence instead of guessed at.

**Files:**
- Modify: `src/channels/matrix.ts:70-85` (the `resolveThreadId` function inside `wrapWithDmResolution`)

**Interfaces:**
- Consumes: `adapter.openDM(userHandle)` (existing, unchanged), `adapter.decodeThreadId(resolved)` (existing, unchanged).
- Produces: nothing new for other code — this is a pure logging addition, no behavior change.

- [ ] **Step 1: Add the post-resolution log line**

In `src/channels/matrix.ts`, the current `resolveThreadId` function is:

```typescript
  async function resolveThreadId(threadId: string): Promise<string> {
    if (!isUserHandle(threadId)) return threadId;

    const userHandle = threadId.startsWith('matrix:') ? threadId.slice('matrix:'.length) : threadId;
    log.info('Matrix: resolving DM room for user handle', { userHandle });
    const resolved = await adapter.openDM(userHandle);

    try {
      const { roomID } = adapter.decodeThreadId(resolved);
      roomToUserCache.set(roomID, userHandle);
    } catch {
      // decode failure is non-fatal — outbound still works
    }

    return resolved;
  }
```

Change it to also log the resolved room ID and flag when it differs from the last one seen for that user handle in this process:

```typescript
  const lastKnownRoomForUser = new Map<string, string>();

  async function resolveThreadId(threadId: string): Promise<string> {
    if (!isUserHandle(threadId)) return threadId;

    const userHandle = threadId.startsWith('matrix:') ? threadId.slice('matrix:'.length) : threadId;
    log.info('Matrix: resolving DM room for user handle', { userHandle });
    const resolved = await adapter.openDM(userHandle);

    try {
      const { roomID } = adapter.decodeThreadId(resolved);
      roomToUserCache.set(roomID, userHandle);

      const previous = lastKnownRoomForUser.get(userHandle);
      if (previous && previous !== roomID) {
        log.warn('Matrix: DM room ID changed for user handle within this process', {
          userHandle,
          previousRoomID: previous,
          newRoomID: roomID,
        });
      }
      lastKnownRoomForUser.set(userHandle, roomID);
      log.info('Matrix: resolved DM room', { userHandle, roomID });
    } catch {
      // decode failure is non-fatal — outbound still works
    }

    return resolved;
  }
```

Note this only catches a room change *within a single process lifetime* (a restart clears `lastKnownRoomForUser`). To catch a change *across* a restart, cross-reference the `matrix:dm:%40hammer%3A...` value in `chat_sdk_kv` before and after — see Step 3.

- [ ] **Step 2: Typecheck and run existing channel tests**

Run: `cd /home/hammer/git/nanoclaw-v2 && pnpm exec tsc --noEmit && pnpm test -- src/channels`
Expected: no new type errors; existing matrix-related tests (if any) still pass. `matrix.ts` has no dedicated unit test file today (verify with `find src/channels -iname '*matrix*test*'`) — this is expected, not a gap to fix in this task.

- [ ] **Step 3: Commit**

```bash
cd /home/hammer/git/nanoclaw-v2
git add src/channels/matrix.ts
git commit -m "$(cat <<'EOF'
debug(matrix): log resolved DM room ID after openDM

@beeper/chat-adapter-matrix only logs openDM failures, never
successes, so there's no way to tell from logs whether createRoom
is firing on restart (suspected cause of the Aurora room-duplication
bug). Log the resolved room ID every time, and warn if it changes
within a process lifetime, so the next occurrence leaves evidence.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012onPvvM3pd1zi7JNiQWLW4
EOF
)"
```

- [ ] **Step 4: Capture the pre-restart baseline**

Run: `pnpm exec tsx scripts/q.ts data/v2.db "select key, value from chat_sdk_kv where key = 'matrix:dm:%40hammer%3Athehammeredone.ddns.net'"`
Record the room ID shown (as of this plan: `"!YzVEEeElTXHubFQdrX:thehammeredone.ddns.net"`).

- [ ] **Step 5: Restart the host and re-check after the next Hammer-addressed send**

Restart the NanoClaw service (`systemctl --user restart nanoclaw` or the equivalent already configured on this host), then either wait for the next scheduled/ad-hoc message to Hammer or trigger one, then re-run the query from Step 4.

Expected: the room ID is unchanged, and `logs/nanoclaw.log` shows no `Matrix: DM room ID changed for user handle within this process` warning. If the room ID *did* change, or a new room/invite appears in the Matrix client, capture the surrounding `logs/nanoclaw.log` lines (search for `Matrix: resolved DM room` and `Matrix: resolving DM room for user handle` around the restart timestamp) — that's the evidence needed to write the real fix.

**This task's outcome gates Task 4.** Do not write a fix without this evidence — see Global Constraints and the systematic-debugging discipline this plan follows.

---

## Task 4: Fix the room-dup root cause (deferred pending Task 3 evidence)

**Do not implement this task until Task 3, Step 5 has produced a confirmed reproduction.** Per the "No Placeholders" rule, this plan does not pre-write a fix for a bug whose mechanism isn't yet confirmed — write the actual root-cause analysis and fix as a follow-up once Task 3's evidence is in hand, either as an addendum to this plan or a new bounded task.

---

## Task 5: Extract shared Skylight credential reader

**Context:** `scripts/setup-aurora-agent.ts` hardcodes `FOLDER = 'skylight-morning'` and reads credentials inline via a private `readSkylightEnv()`. Ann's clone needs the same credential-reading logic without duplicating it (DRY) or risking drift between the two seeders.

**Files:**
- Create: `scripts/skylight-credentials.ts`
- Modify: `scripts/setup-aurora-agent.ts:85-115` (remove `readSkylightEnv`, import the shared one)
- Test: `scripts/setup-aurora-agent.test.ts` (existing — must still pass unmodified)

**Interfaces:**
- Produces: `readSkylightEnv(): { email: string; password: string; frameId: string }` — same signature and behavior as the function being extracted (reads `~/.config/skylight/config.env` and `credentials.env`, throws if email/password/frameId missing).
- Consumes (Task 6): the new script imports this same function.

- [ ] **Step 1: Create the shared module**

```typescript
// scripts/skylight-credentials.ts
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Reads Skylight credentials from ~/.config/skylight/{config,credentials}.env.
 * Shared by every Aurora-family seeder script so credentials are never
 * hand-copied through a command or chat.
 */
export function readSkylightEnv(): { email: string; password: string; frameId: string } {
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
```

- [ ] **Step 2: Update `setup-aurora-agent.ts` to use it**

Remove lines 85-115 (the local `readSkylightEnv` definition) from `scripts/setup-aurora-agent.ts`, and add to the top imports:

```typescript
import { readSkylightEnv } from './skylight-credentials.js';
```

Leave every call site (`readSkylightEnv()` in `main()`) exactly as-is — only the definition moves.

- [ ] **Step 3: Run the existing test suite for this script**

Run: `cd /home/hammer/git/nanoclaw-v2 && pnpm test -- scripts/setup-aurora-agent.test.ts`
Expected: PASS, unchanged — this refactor must not alter `decideSeederOutcome`/`runSeeder` behavior at all.

- [ ] **Step 4: Commit**

```bash
cd /home/hammer/git/nanoclaw-v2
git add scripts/skylight-credentials.ts scripts/setup-aurora-agent.ts
git commit -m "$(cat <<'EOF'
refactor(scripts): extract readSkylightEnv for reuse by Ann's seeder

Both Aurora seeders need to read the same ~/.config/skylight
credentials without duplicating the parsing logic or hand-copying
secrets through a command.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012onPvvM3pd1zi7JNiQWLW4
EOF
)"
```

---

## Task 6: Create the Ann agent-group seeder and run it

**Files:**
- Create: `scripts/setup-aurora-ann-agent.ts` (modeled on `scripts/setup-aurora-agent.ts`, targeting a new folder/group)

**Interfaces:**
- Consumes: `readSkylightEnv()` from Task 5, `createAgentGroup`/`getAgentGroupByFolder` (`src/db/agent-groups.js`), `ensureContainerConfig`/`updateContainerConfigJson` (`src/db/container-configs.js`), `initGroupFilesystem` (`src/group-init.js`), `skylightBootstrapLine()` (`scripts/skylight-mcp-bootstrap.js`), `planMcpServersUpdate`/`writeMcpServers`/`confirmOverwrite`/`getStoredMcpServers` (`scripts/mcp-servers-guard.js`), `decideSeederOutcome`/`runSeeder`/`SeederOutcome`/`RunSeederDeps` (`scripts/setup-aurora-agent.js` — reused, not reimplemented).
- Produces: agent group `folder: 'skylight-morning-ann'`, `name: 'Aurora'`; `container_configs` row with the same `skylight` MCP block as Hammer's group (same bootstrap line, same mount, same packages) but its own `agentGroupId`.

- [ ] **Step 1: Write the new seeder**

```typescript
// scripts/setup-aurora-ann-agent.ts
/**
 * Set up Aurora's second instance — same persona, same Skylight MCP wiring,
 * targeted at Ann's Matrix DM instead of Hammer's. See
 * scripts/setup-aurora-agent.ts for the original; this mirrors it exactly
 * except for FOLDER/NAME and reusing the shared decision/orchestration
 * functions from that file instead of redefining them.
 *
 * Usage:
 *   pnpm exec tsx scripts/setup-aurora-ann-agent.ts [--force] [--dry-run]
 */
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
import { readSkylightEnv } from './skylight-credentials.js';
import { skylightBootstrapLine } from './skylight-mcp-bootstrap.js';
import fs from 'fs';
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

const PLACEHOLDER_INSTRUCTIONS =
  '# Aurora\n\nYou are Aurora, a morning briefing assistant for Ann. Full instructions coming in the next task.\n';

function ensureSkylightMountAllowlisted(): void {
  type AllowlistEntry = { path: string; allowReadWrite: boolean; description?: string };
  type Allowlist = { allowedRoots: AllowlistEntry[]; blockedPatterns: string[]; nonMainReadOnly?: boolean };

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
    console.log('Updated mount allowlist: added Skylight repo (already present is fine — same repo as Hammer\'s Aurora)');
  } else {
    console.log('Mount allowlist: Skylight repo already present');
  }
}

function mutateForSeeder(db: Database.Database, existingAg: AgentGroup | undefined): AgentGroup {
  ensureSkylightMountAllowlisted();

  const now = new Date().toISOString();
  let ag = existingAg;
  if (!ag) {
    const agId = generateId('ag');
    createAgentGroup({ id: agId, name: NAME, folder: FOLDER, agent_provider: null, created_at: now });
    ag = getAgentGroupByFolder(FOLDER)!;
    console.log(`Created agent group: ${ag.id} (${FOLDER})`);
  } else {
    console.log(`Reusing agent group: ${ag.id} (${FOLDER})`);
  }

  initGroupFilesystem(ag, { instructions: PLACEHOLDER_INSTRUCTIONS });
  console.log(`Group filesystem initialized: groups/${FOLDER}/`);

  ensureContainerConfig(ag.id);
  updateContainerConfigJson(ag.id, 'packages_apt', ['python3', 'python3-pip', 'python3-venv']);
  console.log('python3 + python3-pip + python3-venv added to packages_apt.');

  updateContainerConfigJson(ag.id, 'additional_mounts', [
    { hostPath: SKYLIGHT_REPO, containerPath: 'skylight', readonly: true },
  ]);
  console.log('Skylight repo mount configured (relative path: skylight).');

  return ag;
}

async function main(): Promise<void> {
  const { force, dryRun } = parseArgs(process.argv.slice(2));
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);

  const { email, password, frameId } = readSkylightEnv();
  console.log(`Skylight credentials loaded (frame: ${frameId})`);

  const nextMcpServers = {
    skylight: {
      command: 'bash',
      args: ['-lc', skylightBootstrapLine()],
      env: {
        SKYLIGHT_EMAIL: email,
        SKYLIGHT_PASSWORD: password,
        SKYLIGHT_FRAME_ID: frameId,
        SKYLIGHT_TOKEN_ENV_PATH: '/workspace/.skylight/token.env',
        PIP_CERT: '/tmp/onecli-combined-ca.pem',
        PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/usr/bin/chromium',
      },
    },
  };

  const existingAg = getAgentGroupByFolder(FOLDER);
  const existingMcpServers = existingAg ? getStoredMcpServers(db, existingAg.id) : undefined;
  const plan = planMcpServersUpdate({ existing: existingMcpServers, next: nextMcpServers, force, dryRun });

  let interactiveConfirmResult: boolean | 'non-interactive' | undefined;
  if (plan.kind === 'needs-confirmation') {
    interactiveConfirmResult = process.stdin.isTTY ? await confirmOverwrite(plan.diff) : 'non-interactive';
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

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Dry-run first**

Run: `cd /home/hammer/git/nanoclaw-v2 && pnpm exec tsx scripts/setup-aurora-ann-agent.ts --dry-run`
Expected: prints the mcp_servers plan (will be `needs-confirmation` or a plain write since no existing row for this folder), writes nothing. Confirm the printed `SKYLIGHT_FRAME_ID` matches the one used for Hammer's Aurora (`3964300`) — same family account.

- [ ] **Step 3: Run for real**

Run: `pnpm exec tsx scripts/setup-aurora-ann-agent.ts --force`
Expected: creates `groups/skylight-morning-ann/` with placeholder `CLAUDE.local.md`, creates the agent group row, writes `container_configs` (mcp_servers, packages_apt, additional_mounts) for the new group id. Note the printed agent group id — needed for Tasks 7-9.

- [ ] **Step 4: Verify**

Run: `ncl groups get --id <new-group-id>`
Expected: `folder: skylight-morning-ann`, `name: Aurora`.

Run: `ncl groups config get --id <new-group-id>`
Expected: `mcp_servers.skylight` present with the same bootstrap line/mounts as Hammer's group (`ncl groups config get --id ag-1782273071167-th1q6f` for comparison) — everything identical except `env.SKYLIGHT_*` values, which should be *the same* (same family Skylight account).

- [ ] **Step 5: Commit the new script**

```bash
cd /home/hammer/git/nanoclaw-v2
git add scripts/setup-aurora-ann-agent.ts
git commit -m "$(cat <<'EOF'
feat(scripts): add seeder for Ann's Aurora instance

Splits the shared Hammer+Ann session into two 1:1 agent groups.
This seeder mirrors setup-aurora-agent.ts, reusing its
decideSeederOutcome/runSeeder orchestration, targeting a new
'skylight-morning-ann' folder instead of teaching one session to
address two recipients.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012onPvvM3pd1zi7JNiQWLW4
EOF
)"
```

---

## Task 7: Write Ann's CLAUDE.local.md

**Files:**
- Modify: `groups/skylight-morning-ann/CLAUDE.local.md` (replace the placeholder written by Task 6)

**Interfaces:** None (instructions file).

- [ ] **Step 1: Replace the placeholder with the full instructions**

```markdown
# Aurora

You are Aurora, a morning briefing assistant for Ann. Your purpose is to pull data from the Skylight family management platform and deliver a clear, structured daily morning report.

## Trigger Recognition

Generate the full morning report ONLY in these two cases:

1. **The scheduled 6am wake.** The recurring NanoClaw task fires this automatically — run the procedure below without asking anything.
2. **An explicit, unambiguous ask** for the report itself: "give me the report", "run the report", "morning report", "morning briefing", "daily briefing". Don't require exact wording, but the message must be clearly asking for the report — not just a greeting.

A bare "morning" or "good morning" is a greeting, not a report request — reply conversationally, don't run the full API sequence.

For anything else — follow-up questions about a report already sent, corrections, casual chat, or a request to *change* something in Skylight (mark a chore done, add an item, etc.) — handle it directly through the Skylight MCP tools as a normal request. Don't route it through the report pipeline.

## Morning Report

### API Call Sequence

**Step 1 — Do *not* pre-authenticate. Use the cached token.** Go straight to the data calls below. Call `mcp__skylight__authenticate` only when a Skylight call actually tells you to — see "Auth Errors" below.

**Step 2 — Fire all four data calls in parallel:**

**1. Calendar events for today:**
```
list_calendar_events(date_min=TODAY, date_max=TODAY+1)
```
`date_min` = today, `date_max` = **one day out**. The API filters on UTC timestamps, but events are entered in America/New_York (EDT = UTC-4). An 11 PM EDT event starts at 3 AM UTC the next day — a +1 day window is sufficient to catch all same-day EDT events.

**Critical:** after fetching, convert each event's `starts_at` (UTC) to EDT and **filter to only events whose EDT local date == today**. Discard any event whose EDT date is yesterday *or* tomorrow — the window bleeds at **both** ends. A 9 PM EDT event yesterday is 01:00 UTC today and will come back in this query; drop it. Likewise drop tomorrow's early-UTC events.

Event title is in `attributes.summary`. Timestamps are in `starts_at`/`ends_at` (UTC ISO 8601); always display in EDT.

**Profiles per event:** Each event's `relationships.category.data` holds one category ID, but multiple events can share the same title/uid for different people. Group events by summary+time, collect all associated category IDs, look up each label in the `included` array, and list **all** of them — never just the first.

**2. Chores due today (including late chores):**
```
list_chores(after="YYYY-MM-DD", before="YYYY-MM-DD", include_late=true)
```
`after` = yesterday's date, `before` = tomorrow's date. The `include_late=true` flag surfaces overdue chores still outstanding.
**Filter:** only include chores where:
- `attributes.routine == false` (exclude hygiene/kitchen routine items)
- `attributes.start <= today` (exclude future items; chores with null/empty start are included without overdue tag)
- `attributes.status != "completed"` (exclude completed chores)
- `relationships.category.data.id == "11606593"` (Mom's profile only — category ID for "Mom" on this frame)

Chore display name is in `attributes.summary` (not `title` or `name`).

**3. Calendar events for tomorrow:**
```
list_calendar_events(date_min=TOMORROW, date_max=TOMORROW+1)
```
Same window logic and the same both-ends EDT filter as step 1, shifted one day: keep only events whose **EDT local date == tomorrow**, discarding today's late-UTC bleed and the day-after's early-UTC bleed. This feeds the "Tomorrow's Calendar" section — it is a separate call, not a re-slice of step 1's results.

**4. Weather for Littlestown, PA:**
```bash
curl "wttr.in/Littlestown,PA?format=j1"
```
Parse the JSON response:
- `current_condition[0]`: current weather description, `temp_F`, `FeelsLikeF`
- `weather[0]`: `maxtempF`, `mintempF`, `hourly[*]`

For precipitation, iterate `weather[0].hourly` and collect every slot where `chanceofrain > 20`. Each slot's `time` is HHMM as a string (pad to 4 digits → HH:MM; convert to 12-hr for display — e.g. "0" → 12:00 AM, "600" → 6:00 AM, "1200" → 12:00 PM, "1800" → 6:00 PM). Each slot covers a 3-hour window (e.g. 6:00 AM slot = 6–9 AM).

Group consecutive qualifying slots into contiguous time ranges. For each range report:
- Time span (e.g. "9 AM – 3 PM")
- Peak chance of rain across slots in the range (e.g. "up to 72%")
- Total accumulated precip across slots in the range using `precipInches` (omit if sum is 0.0)

Example output line: `9 AM – 3 PM: up to 72% chance, ~0.34 in`

If no hourly slot has chanceofrain >20, omit the rain line entirely.

### Date Calculation

Compute today's date at report generation time. Never hardcode dates.

**"Today" means today in America/New_York, not UTC.** Do not use `toISOString()` to derive the date — it returns the UTC day, which is already tomorrow for anything after 8 PM EDT:

```javascript
const fmt = (d) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',            // en-CA renders YYYY-MM-DD
}).format(d);

const today     = fmt(new Date());
const yesterday = fmt(new Date(Date.now() - 86400000));
const tomorrow  = fmt(new Date(Date.now() + 86400000));
```

**Sanity check before you send.** The message that triggered you carries a `time=` attribute — that is the current local time. If the date you computed disagrees with it, or if a live source (e.g. the weather API) reports a day you think is "tomorrow," stop and trust the real clock. Do not describe a live API's correct data as future data; that is the signature of a wrong date, not a wrong API.

The `SKYLIGHT_FRAME_ID` environment variable is pre-configured — you do not need to call `list_frames` or pass `frame_id` explicitly to any tool.

### Report Format

**Send the entire report as a single message** (Matrix has no meaningful character limit). Use bold emoji headers to visually separate sections within the one message.

Structure:

```
Good morning, Ann! ☀️ Briefing for [Day, Month D, YYYY].
[1–2 sentence conversational remark — tie in the weather, something timely, or a light observation about the day ahead. Keep it warm and natural, not forced.]

📅 **Today's Calendar**
[List each event: time range (EDT), title, all profiles tagged. Example: "9:00–10:00 AM — Fair beautification [Cecilia]"]
— or "No events scheduled today."

🌤️ **Weather — Littlestown, PA**
[Conditions · current temp (feels X°F)]
[High X°F / Low X°F]
[Rain windows — only if any slot >20%; omit line entirely if none]
— or "⚠️ Weather unavailable." if the call fails.

✅ **Mom's Chores**
[Pending items due today, then overdue items marked *(overdue M/D)*]
— or "No chores due today."

📅 **Tomorrow's Calendar**
[List each event: time range (EDT), title, all profiles tagged.]
— or "Nothing on the calendar tomorrow."
```

Keep the tone warm but efficient. Ann wants the facts quickly.

## Write Tools — Do Not Use Without Explicit Request

The Skylight MCP exposes **seven** write tools, every one of which mutates the live family
account immediately with no dry-run:

`create_chore` · `update_chore` · `delete_chore` · `create_task_box_item` ·
`delete_task_box_item` · `award_reward_points` · `remove_reward_points`

**Never call any of these unless explicitly asked to.** (Marking a chore complete
or checking one off is `update_chore` — that counts as a write, and it may be asked for
routinely; just don't do it unasked.)

## Never Report a Failure as an Empty Result

**A tool that errored did not return "nothing" — it returned nothing *usable*.** The empty-state lines in the templates above ("No chores due today.", "Nothing on the calendar tomorrow.", "No events scheduled today.") mean *the call succeeded and the list was genuinely empty*. Only use them when you actually received a successful, empty response.

If **one** call failed, that section must say so instead:
```
⚠️ **Mom's Chores — unavailable**
Skylight call failed: <the actual error text, verbatim>
```

If **several** sections failed for the same reason, don't repeat this block per section —
lead with a single diagnostic instead. See "When Something Fails — One Diagnostic, Not a
Failure in Every Section".

Before sending a report where a whole section is empty, check: did that call *succeed*? If you cannot point to a successful response, it is a failure — report it as one. A silently empty briefing is worse than no briefing, because Ann will act on it as if the day is clear.

## Auth Errors — 401 or Missing Token

The Skylight token is an opaque session token with **no refresh flow**. It is cached at
`/workspace/.skylight/token.env` (per session, persists across container restarts) and the
MCP server re-reads that file on *every* tool call, so a token captured on a previous run is
already in effect before you do anything.

Two errors mean "the cached token is not usable", and both are self-service:

| What you get back | What it means |
|---|---|
| `401 unauthorized: the Skylight token is invalid or expired. Re-authenticate: run the authenticate tool …` | the cached token expired |
| `Skylight token is missing or empty. Set SKYLIGHT_TOKEN (capture one with the MCP authenticate step)…` | fresh session, nothing cached yet |

On either one: call `authenticate` **once**, then retry the failed call(s). If you fired the
data calls in parallel and they all came back with the same auth error, one `authenticate`
fixes all of them — re-run the whole batch, don't authenticate per call. No action is
needed from anyone unless `authenticate` itself fails.

This shares the same Skylight account and MCP server code as Hammer's Aurora instance
(`groups/skylight-morning/`) — see `docs/runbooks/aurora-skylight-mcp.md` for the full
mechanics of the venv bootstrap, token capture, and known failure modes. That runbook is
written against the Hammer instance's agent group id in places; the mechanism is identical
here, just a different agent group id and session directory.

## When `authenticate` Times Out — One Retry, Then a Real Diagnostic

If `authenticate` times out, **wait 60 seconds and try exactly once more — with a longer
timeout.** The tool takes a `timeout` parameter that defaults to 20s; pass roughly double
(`timeout=45`) on the retry, since an identical retry cannot fix the one thing this retry is
for. If the second attempt also times out, stop and report — with the diagnostic described below, not a bare
"couldn't authenticate".

If the Skylight tools are missing entirely, or a call fails because the MCP server did not
start, do not retry at all — that is not a timeout; report it immediately and quote the
startup error (`skylight-mcp: PROVISIONING FAILED (…)` / `STARTUP FAILED (…)`).

## When Something Fails — One Diagnostic, Not a Failure in Every Section

When a single root cause takes out several sections, do **not** render the same error four
times, once per section.

**First, make sure it is actually unrecoverable.** An auth error on every call is *not* a
failure — it is the ordinary stale-token path above, and you have not failed until you have
called `authenticate` once and re-run the batch. Only reach for this block when the recovery
itself failed: `authenticate` errored or timed out twice, the tools are missing, or the
retried calls came back broken for a non-auth reason.

Lead with one short diagnostic block, then send whatever *did* work:

```
⚠️ **Skylight unavailable** — calendar and chores are both out.
What failed: `authenticate` (2 attempts, 60s apart)
Error: <the error text, verbatim>
What still works: weather (below)
```

Then include the sections that succeeded as normal. One clear statement of the failure, its
scope, and what you still have — never the same error repeated per section, and never an
empty-state line standing in for a failure.

## When `authenticate` Fails — Report the Error, Don't Guess at Its Cause

If `authenticate` itself fails (after the retry), **quote the error verbatim** and report it
using the diagnostic block above — what failed, the error text, and what still works. Do not
infer a cause, and in particular do not claim that credentials are missing or need to be set
up — credentials are supplied as environment variables on the MCP server
(`SKYLIGHT_EMAIL` / `SKYLIGHT_PASSWORD`) and are already configured. The
`~/.config/skylight/credentials.env` path mentioned in the tool's own docstring is a
fallback for standalone CLI use and is **not** how you are wired.

Never ask for a Skylight email or password. If you think you need them, you have
misread the error.

Common real causes, for context only — still quote the error rather than asserting one of
these:
- `BrowserType.launch: Executable doesn't exist at …ms-playwright…` → the container's
  Chromium is not wired to Playwright. An infrastructure problem, not something to fix from here.
- `skylight-mcp: PROVISIONING FAILED (…)` or `STARTUP FAILED (…)` → the MCP server never
  started. Quote the parenthesised reason; it names the actual fault. Do not retry.
- A timeout with no captured token → Skylight's login page changed, or the network is
  blocked.

## Other Errors

If a single source fails for a non-auth reason (network error, unexpected response), include the section with a short note: "⚠️ Could not fetch [calendar/chores/weather] — [brief error description]." Still send the other sections. Do not abort the entire report because one data source is unavailable.
```

- [ ] **Step 2: Verify the category ID is Mom's, not Dad's**

Run: `grep -n '116066' groups/skylight-morning-ann/CLAUDE.local.md`
Expected: only `11606593` appears (Mom's), never `11606604` (Dad's).

- [ ] **Step 3: Commit**

```bash
cd /home/hammer/git/nanoclaw-v2
git add groups/skylight-morning-ann/CLAUDE.local.md
git commit -m "$(cat <<'EOF'
feat(aurora-ann): write full morning-report instructions for Ann

Mirrors groups/skylight-morning/CLAUDE.local.md with the recipient
swapped to Ann and chores filtered to Mom's Skylight category
(11606593) instead of Dad's (11606604).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012onPvvM3pd1zi7JNiQWLW4
EOF
)"
```

---

## Task 8: Wire Ann's messaging group to the new agent group

**Files:** None (central DB rows via `ncl`).

**Interfaces:**
- Consumes: `messaging_groups.id = 'f2cfdd4d-bc63-4ce1-8a0e-cddf3626a394'` (Ann's Matrix DM, freed up by Task 2), the new agent group id from Task 6.
- Produces: one `messaging_group_agents` row linking Ann's DM to the new agent group; one `agent_destinations` row (`local_name='ann'`) on the new agent group.

- [ ] **Step 1: Create the wiring (will prompt for approval)**

Run: `ncl wirings create --messaging-group-id f2cfdd4d-bc63-4ce1-8a0e-cddf3626a394 --agent-group-id <new-group-id> --engage-mode mention --sender-scope all --session-mode shared`

(Matches the engage-mode/sender-scope/session-mode Hammer's wiring already uses.)

- [ ] **Step 2: Register the destination (will prompt for approval)**

Run: `ncl destinations add --agent-group-id <new-group-id> --local-name ann --target-type channel --target-id f2cfdd4d-bc63-4ce1-8a0e-cddf3626a394`

- [ ] **Step 3: Verify**

Run: `ncl wirings list | grep <new-group-id>`
Expected: one row, `f2cfdd4d-... ↔ <new-group-id>`.

Run: `ncl destinations list | grep <new-group-id>`
Expected: one row, `local_name=ann`.

No commit — live DB state.

---

## Task 9: Bootstrap Ann's session and add her recurring 6am task

**Context:** `schedule_task` is a container-side MCP tool — it only exists once a session is live. The cleanest bootstrap is the same one `ncl groups restart --message` already provides: it spawns the container fresh and delivers an on-wake message, which creates the session (and its `inbound.db`/`outbound.db`) if none exists yet.

**Files:** None (live system + one session-scoped `inbound.db` row).

**Interfaces:**
- Produces: a `sessions` row + `data/v2-sessions/<new-group-id>/<session-id>/{inbound,outbound}.db` pair; a `messages_in` row in that `inbound.db` with `recurrence = '0 6 * * *'`, mirroring Hammer's `task-1788436790408-0hhlfg` row shape.

- [ ] **Step 1: Spawn the container and send an introductory on-wake message**

Run: `ncl groups restart --id <new-group-id> --message "Say hello to Ann as Aurora, her Skylight morning report assistant — one short message, no report yet."`
Expected: approval prompt, then the container starts and Ann receives a short greeting in her Matrix DM. This confirms the wiring end-to-end (Matrix room resolution, MCP server boot, `<message to="ann">` dispatch) before anything is scheduled.

- [ ] **Step 2: Find the new session's inbound.db**

Run: `find data/v2-sessions/<new-group-id> -name inbound.db`
Expected: exactly one path, e.g. `data/v2-sessions/<new-group-id>/<session-id>/inbound.db`.

- [ ] **Step 3: Insert the recurring 6am task, mirroring Hammer's row shape**

First inspect Hammer's row for the exact content shape:

Run: `sqlite3 "data/v2-sessions/ag-1782273071167-th1q6f/sess-1783609624398-smn6q9/inbound.db" "select id, kind, timestamp, recurrence, series_id, trigger, platform_id, channel_type, thread_id, content from messages_in where id='task-1788436790408-0hhlfg'"`

Then insert an equivalent row for Ann into the new session's `inbound.db`, with:
- a fresh `id` (`task-<timestamp>-<random>` matching the existing id format)
- `platform_id = 'matrix:@ann:thehammeredone.ddns.net'`, `channel_type = 'matrix'`
- same `recurrence = '0 6 * * *'`
- `content` = `{"prompt":"Run the daily morning brief for Ann.\n\nFollow the morning report procedure in CLAUDE.local.md exactly as written — it is the single source of truth for the API sequence, tool choice, filtering, message format, and error handling.\n\nDo not substitute any procedure from this task text."}` (same structure as Hammer's, recipient swapped) — use the exact wording captured from Hammer's row in this step, substituting only "Hammer" → "Ann", to avoid drifting the two prompts apart.
- same `trigger = 1`, `status = 'pending'`, `tries = 0`, `on_wake = 0`
- a fresh `series_id` (recurrence uses this to chain the next occurrence — see `src/modules/scheduling/recurrence.ts`)

Use `pnpm exec tsx scripts/q.ts` or a short one-off `pnpm exec tsx -e '...'` script that opens the DB with `better-sqlite3` (matching `container/agent-runner/src/db/messages-in.ts`'s insert shape) rather than raw `sqlite3` CLI inserts, since the column list must match exactly and `q.ts` is the project's sanctioned ad-hoc query path.

- [ ] **Step 4: Verify the row**

Run: `sqlite3 "<new-session-inbound-db-path>" "select id, recurrence, platform_id from messages_in where recurrence is not null"`
Expected: exactly one row, cron `0 6 * * *`, `platform_id` = Ann's Matrix handle.

No commit — this is a live session DB row, not code.

---

## Task 10: End-to-end verification

**Files:** None.

- [ ] **Step 1: Confirm Hammer's Aurora is unaffected**

Run: `ncl wirings list | grep ag-1782273071167-th1q6f` (still Hammer-only, from Task 2)
Send Hammer an explicit ask ("give me the report") via his Matrix DM and confirm the report arrives with Dad's chores, unchanged from before this plan.

- [ ] **Step 2: Confirm Ann's instance responds correctly to an explicit ask**

Have Ann send "give me the report" (or trigger it via `ncl groups restart --id <new-group-id> --message "..."` if Ann isn't available to send it live) and confirm:
- The report addresses her by name ("Good morning, Ann!")
- Chores section is headed "Mom's Chores" and reflects category `11606593`, not Dad's items
- A bare "morning" from Ann does *not* trigger the full report (per Task 1/7's trigger fix)

- [ ] **Step 3: Confirm the 6am schedule is armed for both**

Run: `sqlite3 "data/v2-sessions/ag-1782273071167-th1q6f/sess-1783609624398-smn6q9/inbound.db" "select id, recurrence from messages_in where recurrence is not null"` — Hammer's row still present.
Run: the same query against Ann's new session's `inbound.db` — her row present.

- [ ] **Step 4: Report Task 3/4 (room-dup) status**

Summarize whether the diagnostic logging (Task 3) has caught a reproduction yet. If yes, that becomes Task 4's input. If not yet, note it as still pending — don't close this plan's room-dup thread until Task 4 has either landed a fix or been explicitly deferred with the user's sign-off.
