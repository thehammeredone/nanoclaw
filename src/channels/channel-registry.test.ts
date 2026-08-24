/**
 * Tests for the v2 channel adapter registry and integration with host.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';

import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';

// Mock container runner
vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

// Override DATA_DIR for tests
vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-channels' };
});

const TEST_DIR = '/tmp/nanoclaw-test-channels';

function now() {
  return new Date().toISOString();
}

/** Create a mock ChannelAdapter for testing. */
function createMockAdapter(
  channelType: string,
): ChannelAdapter & { delivered: OutboundMessage[]; inbound: InboundMessage[] } {
  const delivered: OutboundMessage[] = [];
  const inbound: InboundMessage[] = [];
  let setupConfig: ChannelSetup | null = null;

  return {
    name: channelType,
    channelType,
    supportsThreads: false,
    delivered,
    inbound,

    async setup(config: ChannelSetup) {
      setupConfig = config;
    },

    async teardown() {
      setupConfig = null;
    },

    isConnected() {
      return setupConfig !== null;
    },

    async deliver(
      _platformId: string,
      _threadId: string | null,
      message: OutboundMessage,
    ): Promise<string | undefined> {
      delivered.push(message);
      return undefined;
    },

    async setTyping() {},
  };
}

describe('channel registry', () => {
  // Import fresh modules for each test to avoid registry pollution
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('should register and retrieve channel adapters', async () => {
    const { registerChannelAdapter, getRegisteredChannelNames, getChannelContainerConfig } =
      await import('./channel-registry.js');

    registerChannelAdapter('test-channel', {
      factory: () => createMockAdapter('test'),
      containerConfig: {
        env: { TEST_KEY: 'value' },
      },
    });

    expect(getRegisteredChannelNames()).toContain('test-channel');
    expect(getChannelContainerConfig('test-channel')).toEqual({
      env: { TEST_KEY: 'value' },
    });
  });

  it('should skip adapters that return null (missing credentials)', async () => {
    const { registerChannelAdapter, initChannelAdapters, getActiveAdapters } = await import('./channel-registry.js');

    registerChannelAdapter('no-creds', {
      factory: () => null,
    });

    await initChannelAdapters(() => ({
      conversations: [],
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    }));

    // Should not have any active adapters for channels with null factory returns
    const active = getActiveAdapters();
    const noCreds = active.find((a) => a.name === 'no-creds');
    expect(noCreds).toBeUndefined();
  });
});

describe('channel + router integration', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const { initTestDb, runMigrations, createAgentGroup, createMessagingGroup, createMessagingGroupAgent } =
      await import('../db/index.js');
    const db = initTestDb();
    runMigrations(db);

    createAgentGroup({
      id: 'ag-1',
      name: 'Test Agent',
      folder: 'test-agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'mock',
      platform_id: 'chan-100',
      name: 'Test Channel',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
  });

  afterEach(async () => {
    const { closeDb } = await import('../db/index.js');
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('should route inbound message from adapter to session DB', async () => {
    const { routeInbound } = await import('../router.js');
    const { findSession } = await import('../db/sessions.js');
    const { inboundDbPath } = await import('../session-manager.js');

    // Simulate what the adapter bridge does: stringify content, call routeInbound
    const inboundContent = { sender: 'TestUser', senderId: 'u1', text: 'Hello from adapter', isFromMe: false };

    await routeInbound({
      channelType: 'mock',
      platformId: 'chan-100',
      threadId: null,
      message: {
        id: 'msg-adapter-1',
        kind: 'chat',
        content: JSON.stringify(inboundContent),
        timestamp: now(),
      },
    });

    // Verify session was created and message written
    const session = findSession('mg-1', null);
    expect(session).toBeDefined();

    const dbPath = inboundDbPath('ag-1', session!.id);
    const db = new Database(dbPath);
    const rows = db.prepare('SELECT * FROM messages_in').all() as Array<{ id: string; content: string }>;
    db.close();

    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content).text).toBe('Hello from adapter');
  });

  it('should deliver outbound message through delivery adapter bridge', async () => {
    const { setDeliveryAdapter } = await import('../delivery.js');
    const { getChannelAdapter, registerChannelAdapter, initChannelAdapters } = await import('./channel-registry.js');

    // Register and init a mock adapter
    const mockAdapter = createMockAdapter('mock');
    registerChannelAdapter('mock-delivery', {
      factory: () => mockAdapter,
    });

    await initChannelAdapters(() => ({
      conversations: [],
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    }));

    // Set up delivery adapter bridge (same pattern as index.ts)
    setDeliveryAdapter({
      async deliver(channelType, platformId, threadId, kind, content) {
        const adapter = getChannelAdapter(channelType);
        if (!adapter) return undefined;
        return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content) });
      },
    });

    // Simulate delivery
    const adapter = getChannelAdapter('mock');
    if (adapter) {
      await adapter.deliver('chan-100', null, { kind: 'chat', content: { text: 'Agent response' } });
    }

    expect(mockAdapter.delivered).toHaveLength(1);
    expect((mockAdapter.delivered[0].content as { text: string }).text).toBe('Agent response');
  });
});

describe('channel registry — transient setup retry (TASK-21)', () => {
  const setupFn = () => ({
    conversations: [],
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  });

  afterEach(async () => {
    const { _resetForTests } = await import('./channel-registry.js');
    _resetForTests();
    vi.useRealTimers();
  });

  it('retries an HTTPError-shaped 502 during the in-window ladder and eventually succeeds', async () => {
    const { registerChannelAdapter, initChannelAdapters, getActiveAdapters, _resetForTests } =
      await import('./channel-registry.js');
    _resetForTests();
    vi.useFakeTimers();

    let calls = 0;
    const adapter = createMockAdapter('matrix-502');
    adapter.setup = vi.fn(async () => {
      calls += 1;
      if (calls < 3) {
        const err = new Error('Server returned 502 error');
        err.name = 'HTTPError';
        throw err;
      }
    });

    registerChannelAdapter('matrix', { factory: () => adapter });

    const initPromise = initChannelAdapters(setupFn);
    // Covers the 2s + 5s in-window retry delays with headroom.
    await vi.advanceTimersByTimeAsync(20_000);
    await initPromise;

    expect(calls).toBe(3);
    expect(getActiveAdapters().some((a) => a.channelType === 'matrix-502')).toBe(true);
  });

  it('fails fast on a 401-shaped error with no retry at all', async () => {
    const { registerChannelAdapter, initChannelAdapters, getActiveAdapters, _pendingBackgroundRetryCount } =
      await import('./channel-registry.js');

    let calls = 0;
    const adapter = createMockAdapter('bad-creds');
    adapter.setup = vi.fn(async () => {
      calls += 1;
      const err = new Error('Unauthorized') as Error & { status: number };
      err.status = 401;
      throw err;
    });

    registerChannelAdapter('bad', { factory: () => adapter });

    await initChannelAdapters(setupFn);

    expect(calls).toBe(1);
    expect(getActiveAdapters().some((a) => a.channelType === 'bad-creds')).toBe(false);
    expect(_pendingBackgroundRetryCount()).toBe(0);
  });

  it('retries a fetch-shaped TypeError whose real code lives on err.cause (ENOTFOUND)', async () => {
    const { registerChannelAdapter, initChannelAdapters, getActiveAdapters, _resetForTests } =
      await import('./channel-registry.js');
    _resetForTests();
    vi.useFakeTimers();

    let calls = 0;
    const adapter = createMockAdapter('dns-cold-boot');
    adapter.setup = vi.fn(async () => {
      calls += 1;
      if (calls < 2) {
        // Node's fetch rejects with a TypeError whose top-level `code` is
        // undefined — the real DNS error code is nested under `cause`.
        const err = new TypeError('fetch failed') as TypeError & { cause?: unknown };
        err.cause = { code: 'ENOTFOUND' };
        throw err;
      }
    });

    registerChannelAdapter('dns', { factory: () => adapter });

    const initPromise = initChannelAdapters(setupFn);
    await vi.advanceTimersByTimeAsync(5_000);
    await initPromise;

    expect(calls).toBe(2);
    expect(getActiveAdapters().some((a) => a.channelType === 'dns-cold-boot')).toBe(true);
  });

  it('retries a {status, statusCode} shaped error even when `status` is non-numeric', async () => {
    const { registerChannelAdapter, initChannelAdapters, getActiveAdapters, _resetForTests } =
      await import('./channel-registry.js');
    _resetForTests();
    vi.useFakeTimers();

    let calls = 0;
    const adapter = createMockAdapter('axios-503');
    adapter.setup = vi.fn(async () => {
      calls += 1;
      if (calls < 2) {
        // `??` would short-circuit on the non-nullish, non-numeric `status`
        // and never reach the real numeric `statusCode`.
        const err = new Error('Request failed') as Error & { status: string; statusCode: number };
        err.status = 'ERR_BAD_RESPONSE';
        err.statusCode = 503;
        throw err;
      }
    });

    registerChannelAdapter('axios', { factory: () => adapter });

    const initPromise = initChannelAdapters(setupFn);
    await vi.advanceTimersByTimeAsync(5_000);
    await initPromise;

    expect(calls).toBe(2);
    expect(getActiveAdapters().some((a) => a.channelType === 'axios-503')).toBe(true);
  });

  it('retries a got-shaped "Response code 502 (Bad Gateway)" HTTPError', async () => {
    const { registerChannelAdapter, initChannelAdapters, getActiveAdapters, _resetForTests } =
      await import('./channel-registry.js');
    _resetForTests();
    vi.useFakeTimers();

    let calls = 0;
    const adapter = createMockAdapter('got-502');
    adapter.setup = vi.fn(async () => {
      calls += 1;
      if (calls < 2) {
        const err = new Error('Response code 502 (Bad Gateway)');
        err.name = 'HTTPError';
        throw err;
      }
    });

    registerChannelAdapter('got', { factory: () => adapter });

    const initPromise = initChannelAdapters(setupFn);
    await vi.advanceTimersByTimeAsync(5_000);
    await initPromise;

    expect(calls).toBe(2);
    expect(getActiveAdapters().some((a) => a.channelType === 'got-502')).toBe(true);
  });

  it('does not repopulate activeAdapters or schedule anything when teardown races an in-flight setup', async () => {
    const {
      registerChannelAdapter,
      initChannelAdapters,
      teardownChannelAdapters,
      getActiveAdapters,
      _pendingBackgroundRetryCount,
      _resetForTests,
    } = await import('./channel-registry.js');
    _resetForTests();
    vi.useFakeTimers();

    let resolveSetup: (() => void) | undefined;
    const adapter = createMockAdapter('teardown-race');
    adapter.setup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSetup = resolve;
        }),
    );

    registerChannelAdapter('race', { factory: () => adapter });

    const initPromise = initChannelAdapters(setupFn);
    // Flush microtasks so registration.factory() → setupFn() → adapter.setup()
    // has run and is now parked awaiting resolveSetup() — nothing here
    // touches fake-timer macrotasks, so plain microtask flushes suffice.
    for (let i = 0; i < 5 && !resolveSetup; i++) {
      await Promise.resolve();
    }
    expect(adapter.setup).toHaveBeenCalledTimes(1);

    // Teardown runs while the setup() attempt is still in flight — it can
    // clear activeAdapters/timers but cannot interrupt the pending await.
    await teardownChannelAdapters();

    // Now let the stale attempt resolve, after teardown already ran.
    resolveSetup?.();
    await initPromise;

    expect(getActiveAdapters().some((a) => a.channelType === 'teardown-race')).toBe(false);
    expect(_pendingBackgroundRetryCount()).toBe(0);
  });

  it('recovers a channel via background retry after the in-window ladder is exhausted', async () => {
    const {
      registerChannelAdapter,
      initChannelAdapters,
      getActiveAdapters,
      _pendingBackgroundRetryCount,
      _resetForTests,
    } = await import('./channel-registry.js');
    _resetForTests();
    vi.useFakeTimers();

    let calls = 0;
    const adapter = createMockAdapter('matrix-recovers-late');
    adapter.setup = vi.fn(async () => {
      calls += 1;
      // The in-window ladder makes 4 calls total (1 initial + 3 retries, at
      // 0s/2s/5s/10s) and all fail; the 5th call (1st background attempt,
      // 15s later) succeeds.
      if (calls < 5) {
        const err = new Error('Server returned 502 error');
        err.name = 'HTTPError';
        throw err;
      }
    });

    registerChannelAdapter('matrix', { factory: () => adapter });

    const initPromise = initChannelAdapters(setupFn);
    // Exhaust the in-window ladder (2s + 5s + 10s).
    await vi.advanceTimersByTimeAsync(20_000);
    await initPromise;

    // In-window ladder exhausted; not yet recovered, background retry scheduled.
    expect(getActiveAdapters().some((a) => a.channelType === 'matrix-recovers-late')).toBe(false);
    expect(_pendingBackgroundRetryCount()).toBe(1);

    // First background attempt (15s delay) succeeds.
    await vi.advanceTimersByTimeAsync(16_000);

    expect(calls).toBe(5);
    expect(getActiveAdapters().some((a) => a.channelType === 'matrix-recovers-late')).toBe(true);
    expect(_pendingBackgroundRetryCount()).toBe(0);
  });

  it('respects the background retry ceiling and gives up permanently for a channel stuck failing', async () => {
    const {
      registerChannelAdapter,
      initChannelAdapters,
      getActiveAdapters,
      _pendingBackgroundRetryCount,
      _resetForTests,
    } = await import('./channel-registry.js');
    _resetForTests();
    vi.useFakeTimers();

    let calls = 0;
    const adapter = createMockAdapter('matrix-always-502');
    adapter.setup = vi.fn(async () => {
      calls += 1;
      const err = new Error('Server returned 502 error');
      err.name = 'HTTPError';
      throw err;
    });

    registerChannelAdapter('matrix', { factory: () => adapter });

    const initPromise = initChannelAdapters(setupFn);
    // In-window ladder (2s+5s+10s) + full background ladder
    // (15s+30s+60s+120s+240s+300s) = 782s total; advance well past it.
    await vi.advanceTimersByTimeAsync(800_000);
    await initPromise;

    // In-window ladder: 4 calls (1 initial + 3 retries), all fail.
    // Background ladder: 6 more calls (one per BACKGROUND_RETRY_DELAYS_MS
    // entry), all fail, then the ceiling is reached and it gives up.
    expect(calls).toBe(10);
    expect(getActiveAdapters().some((a) => a.channelType === 'matrix-always-502')).toBe(false);
    expect(_pendingBackgroundRetryCount()).toBe(0);
  });
});
