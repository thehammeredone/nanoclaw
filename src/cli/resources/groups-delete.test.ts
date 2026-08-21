import { describe, it, expect } from 'vitest';

import type { CallerContext } from '../frame.js';
import { lookup } from '../registry.js';
import '../resources/index.js';

/**
 * `ncl groups delete` must not reach `genericDelete`. A bare
 * `DELETE FROM agent_groups` can only ever produce a raw SQLite FK error for
 * any group that has ever been wired or run, and it cannot touch containers,
 * images, directories, other groups' destination edges or the OneCLI agent.
 */
describe('ncl groups delete', () => {
  const ctx = { caller: 'host' } as unknown as CallerContext;

  it('is registered but refuses, pointing at the teardown tool', async () => {
    const cmd = lookup('groups-delete');
    expect(cmd).toBeDefined();
    await expect(cmd!.handler({ id: 'ag-example' }, ctx)).rejects.toThrow(/scripts\/delete-agent-group\.ts/);
    await expect(cmd!.handler({ id: 'ag-example' }, ctx)).rejects.toThrow(/--id ag-example --yes/);
    await expect(cmd!.handler({ id: 'ag-example' }, ctx)).rejects.toThrow(/foreign keys/);
  });

  it('still refuses for an agent caller, without touching approvals', async () => {
    const agentCtx = {
      caller: 'agent',
      agentGroupId: 'ag-example',
      sessionId: 'sess-1',
    } as unknown as CallerContext;
    await expect(lookup('groups-delete')!.handler({ id: 'ag-example' }, agentCtx)).rejects.toThrow(
      /scripts\/delete-agent-group\.ts/,
    );
  });

  it('refuses without an approval round-trip', () => {
    // `dispatch()` requests approval BEFORE invoking the handler, so an
    // `approval` access level here would DM a human admin what reads as an
    // agent-self-destruct request (`cli_scope: group` auto-fills --id to the
    // caller's own group) and then throw anyway once approved. There is
    // nothing to approve.
    expect(lookup('groups-delete')!.access).toBe('open');
  });

  it('does not disturb genericDelete for other resources', async () => {
    // wirings still uses the generic path — proven by its id-required error,
    // which genericDelete raises before touching the DB.
    const cmd = lookup('wirings-delete');
    expect(cmd).toBeDefined();
    await expect(cmd!.handler({}, ctx)).rejects.toThrow(/id is required/);
  });
});
