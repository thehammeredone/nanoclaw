/**
 * The shared webhook server binds a fixed port (3000 by default). Nothing
 * guarantees that port is free — a second host instance, a stale process, or
 * an unrelated dev server can hold it. `net.Server` emits `'error'` on
 * EADDRINUSE, and an unhandled `'error'` event is rethrown as an uncaught
 * exception, which took down the entire host (and, in the test suite, whole
 * vitest workers along with ~20 unrelated tests).
 */
import http from 'http';
import type { AddressInfo } from 'net';

import { describe, it, expect, vi } from 'vitest';

describe('webhook server port conflict', () => {
  it('does not raise an uncaught exception when the port is already in use', async () => {
    const blocker = http.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '0.0.0.0', () => resolve()));
    const port = (blocker.address() as AddressInfo).port;

    process.env.WEBHOOK_PORT = String(port);
    vi.resetModules();
    const mod = await import('./webhook-server.js');

    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);

    try {
      mod.registerWebhookAdapter({ webhooks: {} } as never, 'test-adapter');
      // Give the failed bind a chance to emit.
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      process.off('uncaughtException', onUncaught);
      await mod.stopWebhookServer();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      delete process.env.WEBHOOK_PORT;
    }

    expect(uncaught).toEqual([]);
  });
});
