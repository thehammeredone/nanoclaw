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

/**
 * Redaction rule (TASK-27 review, F1 — the diff used to print
 * SKYLIGHT_PASSWORD/SKYLIGHT_EMAIL to stdout/stderr in cleartext): any object
 * key whose name contains PASSWORD, SECRET, TOKEN, CREDENTIAL, API_KEY, or
 * EMAIL (case-insensitive) is treated as secret-like, anywhere in the tree —
 * not just under an `env` object, so a future MCP server config with secrets
 * nested elsewhere is still covered. This deliberately over-redacts (e.g. it
 * would also redact a key literally named `email` for a non-secret purpose)
 * — better to hide a harmless value than leak a real credential.
 *
 * The redacted value still tells the operator whether it CHANGED, by
 * comparing to the same key path in the other side of the diff — an operator
 * must be able to tell "password rotated" from "password unchanged" without
 * ever seeing either value.
 */
const SECRET_KEY_PATTERN = /(PASSWORD|SECRET|TOKEN|CREDENTIAL|API[_-]?KEY|EMAIL)/i;

/** Recursively redact secret-looking keys in `value`, marking each as changed/unchanged relative to `other`. */
function redactForDiff(value: unknown, other: unknown): unknown {
  if (Array.isArray(value)) {
    const otherArr = Array.isArray(other) ? other : [];
    return value.map((v, i) => redactForDiff(v, otherArr[i]));
  }
  if (value !== null && typeof value === 'object') {
    const otherObj = other !== null && typeof other === 'object' ? (other as Record<string, unknown>) : {};
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(k)) {
        const changed = !isDeepStrictEqual(v, otherObj[k]);
        result[k] = changed ? '<redacted: value differs>' : '<redacted: unchanged>';
      } else {
        result[k] = redactForDiff(v, otherObj[k]);
      }
    }
    return result;
  }
  return value;
}

/**
 * `JSON.stringify` silently drops object properties whose value is
 * `undefined` (TASK-27 review, F3) — a replacer that materializes them as an
 * explicit marker keeps a genuinely divergent plan from rendering two
 * identical-looking blobs. `undefined` for the whole value (no config row at
 * all) renders as a plain label instead of the literal string "undefined"
 * (TASK-27 review, N3).
 */
function stringifyForDiff(value: unknown): string {
  if (value === undefined) return '(no existing config)';
  return JSON.stringify(value, (_key, v) => (v === undefined ? '<undefined>' : v), 2);
}

/** Side-by-side JSON dump — not a line-diff, but enough for an operator to eyeball the drift. Secret-looking values are redacted (see SECRET_KEY_PATTERN above). */
export function mcpServersDiffText(existing: unknown, next: unknown): string {
  return [
    '--- stored (live) ---',
    stringifyForDiff(redactForDiff(existing, next)),
    '--- seeder would write ---',
    stringifyForDiff(redactForDiff(next, existing)),
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

/**
 * Overwrite `container_configs.mcp_servers` for a group. Only call this after
 * `planMcpServersUpdate` says 'write'.
 *
 * This duplicates the UPDATE in `updateContainerConfigJson`
 * (src/db/container-configs.ts) rather than reusing it (TASK-27 review, F5)
 * because that helper reads the connection singleton via `getDb()`, and this
 * module's tests use a throwaway fixture `Database` handle that is never
 * registered as the singleton — an explicit `db` parameter is what makes the
 * hermetic tests possible. Two copies of the same SQL can drift; if a future
 * migration changes what a JSON-column write must touch, update both.
 *
 * Throws (TASK-27 review, F6) instead of silently no-op'ing when no row
 * matches `agentGroupId` — `ensureContainerConfig` is expected to have run
 * first, and a caller that skips it deserves a loud failure, not a write
 * that looks like it happened but didn't.
 */
export function writeMcpServers(db: Database.Database, agentGroupId: string, value: unknown): void {
  const result = db
    .prepare('UPDATE container_configs SET mcp_servers = ?, updated_at = ? WHERE agent_group_id = ?')
    .run(JSON.stringify(value), new Date().toISOString(), agentGroupId);
  if (result.changes !== 1) {
    throw new Error(
      `writeMcpServers: no container_configs row for agent group ${agentGroupId} (expected ensureContainerConfig to have run first)`,
    );
  }
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
