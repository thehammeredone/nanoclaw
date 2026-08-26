/**
 * Guard against `scripts/setup-aurora-agent.ts` silently clobbering
 * hand-tuned `container_configs.mcp_servers` state on re-run (TASK-27).
 *
 * `updateContainerConfigJson` (src/db/container-configs.ts) overwrites the
 * whole JSON column with no regard for what's already there. That is fine
 * for a fresh group, but for an already-configured group it is a footgun:
 * TASK-27 was filed after the seeder's `env` object was found to be missing
 * `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`, a key that had been hand-added to
 * the live row and would have been silently dropped by a re-run.
 *
 * Chosen shape: diff-and-confirm by default, `--force` to skip the prompt,
 * `--dry-run` to print the diff without writing anything. Rejected
 * alternatives:
 *   - Silent merge: would have hidden the exact PLAYWRIGHT_* divergence that
 *     motivated this task — a merged env object still silently drops a key
 *     if the *seeder* now omits one the live row deliberately removed, and
 *     an operator would never see it happened.
 *   - Refuse-always without a diff: safe, but forces an operator to go
 *     spelunking in the DB by hand to find out what would have changed
 *     before they can decide whether `--force` is right.
 *   diff-and-confirm surfaces the drift and lets a human decide, which is
 *   the property this task is actually about ("not safe to re-run" means
 *   "the operator can't see what changed", not "it changes something").
 *
 * Non-interactive-safe: `planMcpServersUpdate` never reads stdin. The only
 * stdin read (`confirmOverwrite`) is invoked by the caller (see
 * scripts/setup-aurora-agent.ts) exclusively when `process.stdin.isTTY` is
 * true; a non-interactive run (cron, CI, `--force`-less automation) hits the
 * `needs-confirmation` plan and the caller refuses outright instead of ever
 * constructing a readline interface, so this can never hang waiting on
 * stdin.
 */
import readline from 'node:readline/promises';
import { isDeepStrictEqual } from 'node:util';

import type Database from 'better-sqlite3';

/** True for `undefined`, `null`, or `{}` — i.e. "nothing here to protect yet". */
export function isEmptyMcpServers(value: unknown): boolean {
  return value == null || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length === 0);
}

/** Side-by-side JSON dump — not a line-diff, but enough for an operator to eyeball the drift. */
export function mcpServersDiffText(existing: unknown, next: unknown): string {
  return [
    '--- stored (live) ---',
    JSON.stringify(existing, null, 2),
    '--- seeder would write ---',
    JSON.stringify(next, null, 2),
  ].join('\n');
}

export interface PlanMcpServersUpdateInput {
  /** Parsed `container_configs.mcp_servers` for this group, or undefined/{} if unset. */
  existing: unknown;
  /** The value this run of the seeder would write. */
  next: unknown;
  force: boolean;
  dryRun: boolean;
}

export type McpServersPlan =
  | { kind: 'write'; reason: 'no-existing-config' | 'identical' | 'forced' }
  | { kind: 'needs-confirmation'; reason: 'diverges-from-live'; diff: string }
  | { kind: 'dry-run'; reason: 'no-existing-config' | 'identical' | 'diverges-from-live'; diff: string };

/**
 * Pure decision function — no DB, no stdin. Given what's already stored and
 * what the seeder would write, decide whether it's safe to write directly,
 * whether an operator needs to confirm, or (in --dry-run) neither.
 */
export function planMcpServersUpdate(input: PlanMcpServersUpdateInput): McpServersPlan {
  const { existing, next, force, dryRun } = input;
  const noExisting = isEmptyMcpServers(existing);
  const identical = !noExisting && isDeepStrictEqual(existing, next);
  const reason: 'no-existing-config' | 'identical' | 'diverges-from-live' = noExisting
    ? 'no-existing-config'
    : identical
      ? 'identical'
      : 'diverges-from-live';

  if (dryRun) return { kind: 'dry-run', reason, diff: mcpServersDiffText(existing, next) };
  if (reason !== 'diverges-from-live') return { kind: 'write', reason };
  if (force) return { kind: 'write', reason: 'forced' };
  return { kind: 'needs-confirmation', reason: 'diverges-from-live', diff: mcpServersDiffText(existing, next) };
}

/** Read + parse `container_configs.mcp_servers` for a group. Throws on corrupt JSON — fail loudly, not silently. */
export function getStoredMcpServers(db: Database.Database, agentGroupId: string): unknown {
  const row = db.prepare('SELECT mcp_servers FROM container_configs WHERE agent_group_id = ?').get(agentGroupId) as
    | { mcp_servers: string | null }
    | undefined;
  if (!row || row.mcp_servers == null) return undefined;
  try {
    return JSON.parse(row.mcp_servers);
  } catch (err) {
    throw new Error(
      `container_configs.mcp_servers is not valid JSON for agent group ${agentGroupId}: ${(err as Error).message}`,
    );
  }
}

/** Overwrite `container_configs.mcp_servers` for a group. Only call this after `planMcpServersUpdate` says 'write'. */
export function writeMcpServers(db: Database.Database, agentGroupId: string, value: unknown): void {
  db.prepare('UPDATE container_configs SET mcp_servers = ?, updated_at = ? WHERE agent_group_id = ?').run(
    JSON.stringify(value),
    new Date().toISOString(),
    agentGroupId,
  );
}

/**
 * Interactive y/N prompt. Only ever call this when `process.stdin.isTTY` is
 * true — see the module doc comment for why that keeps this non-interactive-safe.
 */
export async function confirmOverwrite(
  diff: string,
  streams: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = {
    input: process.stdin,
    output: process.stdout,
  },
): Promise<boolean> {
  streams.output.write('Stored mcp_servers differs from what this seeder would write:\n');
  streams.output.write(diff + '\n');
  const rl = readline.createInterface({ input: streams.input, output: streams.output });
  try {
    const answer = await rl.question('Overwrite stored mcp_servers with the seeder value? [y/N] ');
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
