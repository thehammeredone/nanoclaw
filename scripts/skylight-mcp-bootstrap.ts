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
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const BOOTSTRAP_SCRIPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'skylight-mcp-bootstrap.sh',
);

/**
 * Collapse canonical-script source text into a single shell line: comment
 * lines and blank lines are dropped, each remaining line is trimmed, and the
 * rest are joined with a single space.
 *
 * Throws rather than emitting a subtly-wrong line if the script contains
 * something the collapse cannot represent. `sourceLabel` is used only for
 * error messages (defaults to the real canonical script path); tests pass a
 * synthetic label so failures don't look like they came from the real file.
 *
 * Exported (in addition to `skylightBootstrapLine`) so tests can exercise
 * the collapse logic against fabricated source text without touching the
 * filesystem.
 */
export function collapseBootstrapScript(
  raw: string,
  sourceLabel: string = BOOTSTRAP_SCRIPT_PATH,
): string {
  const lines: string[] = [];

  for (const [i, rawLine] of raw.split('\n').entries()) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.includes('#')) {
      throw new Error(
        `${sourceLabel}:${i + 1}: '#' outside a full-line comment. ` +
          'After the collapse it would comment out the rest of the line.',
      );
    }
    if (/ {2}/.test(line)) {
      throw new Error(`${sourceLabel}:${i + 1}: consecutive spaces change the collapsed line.`);
    }
    if (line.endsWith('\\')) {
      throw new Error(
        `${sourceLabel}:${i + 1}: line ends in a trailing backslash line-continuation. ` +
          'Collapsing joins it to the next line with a space, so the backslash becomes an ' +
          'escaped-space argv element that was never in the source (measured downstream ' +
          `symptoms: a stray 'mkdir " "', 'cd: too many arguments', 'pip: Invalid ` +
          `requirement'). Rewrite the statement on one line instead of wrapping it.`,
      );
    }
    lines.push(line);
  }

  if (lines.length === 0) throw new Error(`${sourceLabel}: no shell statements found.`);
  const collapsed = lines.join(' ');
  assertValidShellSyntax(collapsed, sourceLabel);
  return collapsed;
}

/**
 * Run `bash -n -c <collapsed>` to catch anything the line-by-line collapse
 * can't represent as a syntax error — unbalanced quotes, heredocs, etc.
 * `bash -n` performs a syntax check without executing the script.
 */
function assertValidShellSyntax(collapsed: string, sourceLabel: string): void {
  const result = spawnSync('bash', ['-n', '-c', collapsed], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `${sourceLabel}: collapsed line failed 'bash -n -c' syntax check ` +
        `(exit ${result.status}): ${result.stderr.trim()}`,
    );
  }
}

/** Read the canonical script and collapse it — see `collapseBootstrapScript`. */
export function skylightBootstrapLine(): string {
  const raw = fs.readFileSync(BOOTSTRAP_SCRIPT_PATH, 'utf8');
  return collapseBootstrapScript(raw);
}
