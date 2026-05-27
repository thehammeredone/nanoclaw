import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import type { Adapter, AdapterPostableMessage, RawMessage } from 'chat';

import { createChatSdkBridge, splitForLimit } from './chat-sdk-bridge.js';
import type { ChannelSetup, InboundMessage } from './adapter.js';

// Mock Chat to prevent gateway / WebSocket initialization in unit tests.
vi.mock('chat', async () => {
  const actual = await vi.importActual<typeof import('chat')>('chat');
  return {
    ...actual,
    Chat: class {
      onSubscribedMessage() {}
      onNewMention() {}
      onDirectMessage() {}
      onNewMessage() {}
      onAction() {}
      async initialize() {}
      async shutdown() {}
    },
  };
});

function stubAdapter(partial: Partial<Adapter>): Adapter {
  return { name: 'stub', ...partial } as unknown as Adapter;
}

interface PostCall {
  threadId: string;
  message: AdapterPostableMessage;
}

function makePostCapture() {
  const calls: PostCall[] = [];
  const postMessage = async (threadId: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>> => {
    calls.push({ threadId, message });
    return { id: 'msg-stub', threadId, raw: {} };
  };
  return { calls, postMessage };
}

describe('splitForLimit', () => {
  it('returns a single chunk when text fits', () => {
    expect(splitForLimit('short text', 100)).toEqual(['short text']);
  });

  it('splits on paragraph boundaries when available', () => {
    const text = 'para one line one\npara one line two\n\npara two line one\npara two line two';
    const chunks = splitForLimit(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
  });

  it('falls back to line boundaries when no paragraph fits', () => {
    const text = 'alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot';
    const chunks = splitForLimit(text, 15);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(15);
  });

  it('hard-cuts when no whitespace is available', () => {
    const text = 'a'.repeat(100);
    const chunks = splitForLimit(text, 30);
    expect(chunks.length).toBe(Math.ceil(100 / 30));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30);
    expect(chunks.join('')).toBe(text);
  });
});

describe('createChatSdkBridge', () => {
  // The bridge is now transport-only: forward inbound events, relay outbound
  // ops. All per-wiring engage / accumulate / drop / subscribe decisions live
  // in the router (src/router.ts routeInbound / evaluateEngage) and are
  // exercised by host-core.test.ts end-to-end. These tests only cover the
  // bridge's narrow, platform-adjacent surface.

  it('omits openDM when the underlying Chat SDK adapter has none', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeUndefined();
  });

  it('exposes openDM when the underlying adapter has one, and delegates directly', async () => {
    const openDMCalls: string[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        openDM: async (userId: string) => {
          openDMCalls.push(userId);
          return `thread::${userId}`;
        },
        channelIdFromThreadId: (threadId: string) => `stub:${threadId.replace(/^thread::/, '')}`,
      }),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeDefined();
    const platformId = await bridge.openDM!('user-42');
    // Delegation: adapter.openDM → adapter.channelIdFromThreadId, no chat.openDM in between.
    expect(openDMCalls).toEqual(['user-42']);
    expect(platformId).toBe('stub:user-42');
  });

  it('exposes subscribe (lets the router initiate thread subscription on mention-sticky engage)', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: true,
    });
    expect(typeof bridge.subscribe).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// fetchHistory
// ---------------------------------------------------------------------------

/** Minimal fake of a Chat SDK Message for catch-up tests. */
function fakeMessage(id: string, threadId = 'thread-001', isMention = false) {
  return {
    id,
    threadId,
    isMention,
    toJSON: () => ({
      id,
      text: `message ${id}`,
      author: { userId: 'u1', fullName: 'User One' },
    }),
    attachments: [],
    metadata: { dateSent: new Date('2025-01-01T00:00:00.000Z') },
    raw: undefined,
  };
}

/** Build a stub adapter that implements fetchChannelMessages returning `msgs`. */
function fetchableAdapter(msgs: ReturnType<typeof fakeMessage>[]) {
  return {
    name: 'discord',
    userName: 'bot',
    channelIdFromThreadId: (tid: string) => `discord:guild:${tid.replace('thread-', '')}`,
    fetchChannelMessages: async (_channelId: string, _opts?: unknown) => ({
      messages: msgs,
      nextCursor: undefined,
    }),
    // Minimal stubs so Chat SDK initializes without error
    initialize: async () => {},
    postMessage: async () => ({ id: 'sent', threadId: 'thread-001', raw: {} }),
    startTyping: async () => {},
  } as unknown as Adapter;
}

describe('createChatSdkBridge.fetchHistory', () => {
  beforeEach(async () => {
    // initTestDb so SqliteStateAdapter's getDb() doesn't throw
    const { initTestDb, runMigrations } = await import('../db/index.js');
    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(async () => {
    const { closeDb } = await import('../db/index.js');
    closeDb();
  });

  async function makeBridgeWithSetup(adapter: Adapter, onInbound: ChannelSetup['onInbound']) {
    const bridge = createChatSdkBridge({ adapter, supportsThreads: false });
    const setup: ChannelSetup = {
      onInbound,
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    };
    await bridge.setup(setup);
    return bridge;
  }

  it('is undefined when the adapter has no fetchChannelMessages', async () => {
    const adapter = { name: 'no-fetch', initialize: async () => {} } as unknown as Adapter;
    const bridge = await makeBridgeWithSetup(adapter, async () => {});
    expect(bridge.fetchHistory).toBeUndefined();
  });

  it('is defined when the adapter has fetchChannelMessages', async () => {
    const adapter = fetchableAdapter([]);
    const bridge = await makeBridgeWithSetup(adapter, async () => {});
    expect(bridge.fetchHistory).toBeDefined();
  });

  it('(d) bootstrap: null sinceMessageId returns latest id without replaying', async () => {
    const msgs = [fakeMessage('msg-001'), fakeMessage('msg-002'), fakeMessage('msg-003')];
    const inboundCalls: string[] = [];
    const bridge = await makeBridgeWithSetup(fetchableAdapter(msgs), async (_cid, _tid, msg: InboundMessage) => {
      inboundCalls.push(msg.id);
    });

    const result = await bridge.fetchHistory!('discord:guild:chan', null, 10, false);
    expect(result.latestMessageId).toBe('msg-003');
    expect(inboundCalls).toHaveLength(0); // no replay during bootstrap
  });

  it('(a) replays only messages after the cursor id', async () => {
    const msgs = [fakeMessage('msg-001'), fakeMessage('msg-002'), fakeMessage('msg-003'), fakeMessage('msg-004')];
    const inboundCalls: string[] = [];
    const bridge = await makeBridgeWithSetup(fetchableAdapter(msgs), async (_cid, _tid, msg: InboundMessage) => {
      inboundCalls.push(msg.id);
    });

    const result = await bridge.fetchHistory!('discord:guild:chan', 'msg-002', 10, false);
    // Only msg-003 and msg-004 are after the cursor
    expect(inboundCalls).toEqual(['msg-003', 'msg-004']);
    expect(result.latestMessageId).toBe('msg-004');
  });

  it('(c) replays in chronological order', async () => {
    const msgs = [fakeMessage('msg-a'), fakeMessage('msg-b'), fakeMessage('msg-c')];
    const order: string[] = [];
    const bridge = await makeBridgeWithSetup(fetchableAdapter(msgs), async (_cid, _tid, msg: InboundMessage) => {
      order.push(msg.id);
    });

    await bridge.fetchHistory!('discord:guild:chan', 'msg-a', 10, false);
    expect(order).toEqual(['msg-b', 'msg-c']);
  });

  it('(b) replays full page and warns when cursor is not in the page', async () => {
    const msgs = [fakeMessage('msg-new-1'), fakeMessage('msg-new-2')];
    const inboundCalls: string[] = [];
    const bridge = await makeBridgeWithSetup(fetchableAdapter(msgs), async (_cid, _tid, msg: InboundMessage) => {
      inboundCalls.push(msg.id);
    });

    // 'msg-old' is not in the page (represents a deleted or too-old message)
    const result = await bridge.fetchHistory!('discord:guild:chan', 'msg-old', 10, false);
    expect(inboundCalls).toEqual(['msg-new-1', 'msg-new-2']);
    expect(result.latestMessageId).toBe('msg-new-2');
  });

  it('returns null latestMessageId when the channel has no messages', async () => {
    const bridge = await makeBridgeWithSetup(fetchableAdapter([]), async () => {});
    const result = await bridge.fetchHistory!('discord:guild:chan', null, 10, false);
    expect(result.latestMessageId).toBeNull();
  });

  it('forwards isGroup flag through messageToInbound so the router gets it', async () => {
    const msgs = [fakeMessage('msg-001')];
    let capturedMsg: InboundMessage | null = null;
    const bridge = await makeBridgeWithSetup(fetchableAdapter(msgs), async (_cid, _tid, msg: InboundMessage) => {
      capturedMsg = msg;
    });

    await bridge.fetchHistory!('discord:guild:chan', null, 10, true); // bootstrap, no replay
    expect(capturedMsg).toBeNull(); // bootstrap never replays

    await bridge.fetchHistory!('discord:guild:chan', 'cursor-before', 10, true);
    // cursor not in page → replays all
    expect(capturedMsg).not.toBeNull();
    expect(capturedMsg!.isGroup).toBe(true);
  });
});

describe('createChatSdkBridge.deliver — display cards (send_card)', () => {
  // The send_card MCP tool writes outbound rows with `{ type: 'card', card, fallbackText }`.
  // Before this branch existed the bridge silently dropped them: cards have no
  // `text` / `markdown`, so the trailing fallback `if (text)` was false and the
  // function returned without calling the adapter. These tests pin the contract
  // for the dedicated card branch.

  it('renders title, description, and string children, then posts via the adapter', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Daily',
          description: 'Your plate today',
          children: ['• item one', '• item two'],
        },
        fallbackText: 'Daily: your plate',
      },
    });
    expect(id).toBe('msg-stub');
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { card?: unknown; fallbackText?: string };
    expect(msg.fallbackText).toBe('Daily: your plate');
    expect(msg.card).toBeDefined();
  });

  it('drops actions without url (send_card is fire-and-forget; non-URL buttons would have nowhere to land)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Card',
          description: 'has only label-only actions',
          actions: [{ label: 'Add' }, { label: 'Skip' }],
        },
      },
    });
    expect(calls).toHaveLength(1);
    // Cast through the public Card shape to read the children we set
    const msg = calls[0].message as { card?: { children?: Array<{ type?: string }> } };
    const childTypes = (msg.card?.children ?? []).map((c) => c.type);
    expect(childTypes).not.toContain('actions');
  });

  it('renders url actions as link buttons inside an Actions row', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Docs',
          actions: [{ label: 'Open', url: 'https://example.com' }, { label: 'No-link' }],
        },
      },
    });
    const msg = calls[0].message as {
      card?: { children?: Array<{ type?: string; children?: Array<{ type?: string; url?: string }> }> };
    };
    const actionsRow = msg.card?.children?.find((c) => c.type === 'actions');
    expect(actionsRow).toBeDefined();
    const buttons = actionsRow?.children ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0].type).toBe('link-button');
    expect(buttons[0].url).toBe('https://example.com');
  });

  it('skips delivery when the card has neither title nor body content', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { type: 'card', card: {} },
    });
    expect(id).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('falls through to the text branch for non-card chat-sdk payloads (no regression)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { text: 'plain hello' },
    });
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { markdown?: string };
    expect(msg.markdown).toBe('plain hello');
  });
});
