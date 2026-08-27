import { describe, expect, it, vi } from 'vitest';

import { decideSeederOutcome, runSeeder, type RunSeederDeps, type SeederOutcome } from './setup-aurora-agent.js';
import type { McpServersPlan } from './mcp-servers-guard.js';
import type { AgentGroup } from '../src/types.js';

/**
 * Hermetic coverage for the caller's decision handling (TASK-27 review:
 * "no test file imports scripts/setup-aurora-agent.ts, so the entire caller
 * is uncovered ... deleting the `return` at line 256 lets the refusal branch
 * fall through to the success banner with all 15 tests still green").
 *
 * These import ONLY `decideSeederOutcome` (pure) and `runSeeder` (takes every
 * side effect — DB, filesystem, stdin — as an injected dependency). Neither
 * touches data/v2.db, the real filesystem, or stdin: importing this module
 * does not execute `main()` (see the `import.meta.url` entry-point guard at
 * the bottom of setup-aurora-agent.ts).
 */

const FAKE_AG: AgentGroup = {
  id: 'ag-fixture',
  name: 'Aurora',
  folder: 'skylight-morning',
  agent_provider: null,
  created_at: '2026-01-01T00:00:00.000Z',
};

function makeDeps(overrides: Partial<RunSeederDeps>): RunSeederDeps {
  const logs: string[] = [];
  const errors: string[] = [];
  const defaultPlan: McpServersPlan = { kind: 'write', reason: 'no-existing-config' };
  const defaultOutcome: SeederOutcome = { kind: 'proceed', writeMcp: true, mcpReason: 'no-existing-config' };
  return {
    plan: defaultPlan,
    outcome: defaultOutcome,
    mutate: vi.fn(() => FAKE_AG),
    writeMcp: vi.fn(),
    log: (line: string) => logs.push(line),
    logError: (line: string) => errors.push(line),
    ...overrides,
  };
}

describe('decideSeederOutcome', () => {
  it('dry-run plan always produces a dry-run outcome, regardless of confirm result', () => {
    const plan: McpServersPlan = { kind: 'dry-run', reason: 'diverges-from-live', diff: 'x' };
    expect(decideSeederOutcome(plan)).toEqual({ kind: 'dry-run' });
    expect(decideSeederOutcome(plan, true)).toEqual({ kind: 'dry-run' });
  });

  it('needs-confirmation + non-interactive stdin refuses without writing', () => {
    const plan: McpServersPlan = { kind: 'needs-confirmation', reason: 'diverges-from-live', diff: 'x' };
    expect(decideSeederOutcome(plan, 'non-interactive')).toEqual({ kind: 'refused-non-interactive' });
  });

  it('needs-confirmation + operator declines refuses without writing', () => {
    const plan: McpServersPlan = { kind: 'needs-confirmation', reason: 'diverges-from-live', diff: 'x' };
    expect(decideSeederOutcome(plan, false)).toEqual({ kind: 'refused-declined' });
  });

  it('needs-confirmation + operator confirms proceeds and writes mcp_servers', () => {
    const plan: McpServersPlan = { kind: 'needs-confirmation', reason: 'diverges-from-live', diff: 'x' };
    expect(decideSeederOutcome(plan, true)).toEqual({ kind: 'proceed', writeMcp: true, mcpReason: 'confirmed-overwrite' });
  });

  it('write plan with reason identical proceeds but does NOT write mcp_servers (skip no-op writes)', () => {
    const plan: McpServersPlan = { kind: 'write', reason: 'identical' };
    expect(decideSeederOutcome(plan)).toEqual({ kind: 'proceed', writeMcp: false, mcpReason: 'identical' });
  });

  it('write plan with reason no-existing-config or forced proceeds and writes', () => {
    expect(decideSeederOutcome({ kind: 'write', reason: 'no-existing-config' })).toEqual({
      kind: 'proceed',
      writeMcp: true,
      mcpReason: 'no-existing-config',
    });
    expect(decideSeederOutcome({ kind: 'write', reason: 'forced' })).toEqual({
      kind: 'proceed',
      writeMcp: true,
      mcpReason: 'forced',
    });
  });
});

describe('runSeeder', () => {
  it('dry-run: does not call mutate or writeMcp, does not print the success banner, exits 0', () => {
    const plan: McpServersPlan = { kind: 'dry-run', reason: 'diverges-from-live', diff: 'the diff' };
    const deps = makeDeps({ plan, outcome: { kind: 'dry-run' } });
    const logs: string[] = [];
    deps.log = (l) => logs.push(l);

    const { exitCode } = runSeeder(deps);

    expect(exitCode).toBe(0);
    expect(deps.mutate).not.toHaveBeenCalled();
    expect(deps.writeMcp).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('the diff');
    expect(logs.join('\n')).not.toContain('setup complete');
  });

  it('non-interactive refusal: does not call mutate or writeMcp, does not print success, exits 1', () => {
    const plan: McpServersPlan = { kind: 'needs-confirmation', reason: 'diverges-from-live', diff: 'the diff' };
    const deps = makeDeps({ plan, outcome: { kind: 'refused-non-interactive' } });
    const errors: string[] = [];
    deps.logError = (l) => errors.push(l);

    const { exitCode } = runSeeder(deps);

    expect(exitCode).toBe(1);
    expect(deps.mutate).not.toHaveBeenCalled();
    expect(deps.writeMcp).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('Refusing');
    expect(errors.join('\n')).toContain('the diff');
  });

  it('declined confirmation: does not call mutate or writeMcp, does not print success, exits 1', () => {
    const plan: McpServersPlan = { kind: 'needs-confirmation', reason: 'diverges-from-live', diff: 'the diff' };
    const deps = makeDeps({ plan, outcome: { kind: 'refused-declined' } });

    const { exitCode } = runSeeder(deps);

    expect(exitCode).toBe(1);
    expect(deps.mutate).not.toHaveBeenCalled();
    expect(deps.writeMcp).not.toHaveBeenCalled();
  });

  it('proceed with writeMcp=true calls mutate and writeMcp, prints success, exits 0', () => {
    const plan: McpServersPlan = { kind: 'write', reason: 'no-existing-config' };
    const deps = makeDeps({ plan, outcome: { kind: 'proceed', writeMcp: true, mcpReason: 'no-existing-config' } });
    const logs: string[] = [];
    deps.log = (l) => logs.push(l);

    const { exitCode } = runSeeder(deps);

    expect(exitCode).toBe(0);
    expect(deps.mutate).toHaveBeenCalledTimes(1);
    expect(deps.writeMcp).toHaveBeenCalledTimes(1);
    expect(deps.writeMcp).toHaveBeenCalledWith(FAKE_AG);
    expect(logs.join('\n')).toContain('setup complete');
  });

  it('proceed with writeMcp=false (identical) calls mutate but NOT writeMcp, still prints success, exits 0', () => {
    const plan: McpServersPlan = { kind: 'write', reason: 'identical' };
    const deps = makeDeps({ plan, outcome: { kind: 'proceed', writeMcp: false, mcpReason: 'identical' } });
    const logs: string[] = [];
    deps.log = (l) => logs.push(l);

    const { exitCode } = runSeeder(deps);

    expect(exitCode).toBe(0);
    expect(deps.mutate).toHaveBeenCalledTimes(1);
    expect(deps.writeMcp).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('nothing to write');
    expect(logs.join('\n')).toContain('setup complete');
  });
});
