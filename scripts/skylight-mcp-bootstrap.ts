/**
 * Loader for the canonical Skylight MCP bootstrap command.
 *
 * `scripts/skylight-mcp-bootstrap.sh` is the single source of truth. This
 * module turns it into the one-line `bash -lc` argument that
 * `scripts/setup-aurora-agent.ts` writes to
 * `container_configs.mcp_servers` -> `skylight.args[1]` in `data/v2.db`.
 *
 * The container cannot read this repo (only the read-only Skylight source is
 * mounted, and the venv is per-session under /workspace), so the line has to
 * be inlined in the DB. `skylight-mcp-bootstrap.test.ts` fails if the stored
 * line and the script diverge.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const BOOTSTRAP_SCRIPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'skylight-mcp-bootstrap.sh',
);

/**
 * Read the canonical script and collapse it into a single shell line:
 * comment lines and blank lines are dropped, each remaining line is trimmed,
 * and the rest are joined with a single space.
 *
 * Throws rather than emitting a subtly-wrong line if the script contains
 * something the collapse cannot represent.
 */
export function skylightBootstrapLine(): string {
  const raw = fs.readFileSync(BOOTSTRAP_SCRIPT_PATH, 'utf8');
  const lines: string[] = [];

  for (const [i, rawLine] of raw.split('\n').entries()) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.includes('#')) {
      throw new Error(
        `${BOOTSTRAP_SCRIPT_PATH}:${i + 1}: '#' outside a full-line comment. ` +
          'After the collapse it would comment out the rest of the line.',
      );
    }
    if (/ {2}/.test(line)) {
      throw new Error(
        `${BOOTSTRAP_SCRIPT_PATH}:${i + 1}: consecutive spaces change the collapsed line.`,
      );
    }
    lines.push(line);
  }

  if (lines.length === 0) throw new Error(`${BOOTSTRAP_SCRIPT_PATH}: no shell statements found.`);
  return lines.join(' ');
}
