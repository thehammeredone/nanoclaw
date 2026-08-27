import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getPendingMessages } from './db/messages-in.js';
import { getContinuation, setContinuation } from './db/session-state.js';
import { MockProvider } from './providers/mock.js';
import type { AgentProvider, AgentQuery } from './providers/types.js';
import { runPollLoop } from './poll-loop.js';

beforeEach(() => {
  initTestSessionDb();
  // Seed a destination so output parsing can resolve "discord-test" → routing
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});

// runPollLoop never returns on its own, so every test used to leave its loop
// running against the module-global test DB. Those orphans kept polling into
// later tests (and later files) and stealing their messages. Track each loop
// plus the queries it opened so teardown can end the streams, close the DB out
// from under the loop, and await its rejection before the next test starts.
const activeLoops: Array<{ raw: Promise<void>; queries: AgentQuery[] }> = [];

afterEach(async () => {
  for (const loop of activeLoops) {
    for (const q of loop.queries) {
      try {
        q.end();
      } catch {
        /* already finished */
      }
    }
  }
  closeSessionDb();
  await Promise.all(activeLoops.map((l) => l.raw.catch(() => {})));
  activeLoops.length = 0;
});

function insertMessage(id: string, content: object, opts?: { platformId?: string; channelType?: string; threadId?: string }) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', datetime('now'), 'pending', ?, ?, ?, ?)`,
    )
    .run(id, opts?.platformId ?? null, opts?.channelType ?? null, opts?.threadId ?? null, JSON.stringify(content));
}

describe('poll loop integration', () => {
  it('should pick up a message, process it, and write a response', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'What is the meaning of life?' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' });

    const provider = new MockProvider({}, () => '<message to="discord-test">42</message>');

    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('42');
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].channel_type).toBe('discord');
    expect(out[0].in_reply_to).toBe('m1');

    // Input message should be acked (not pending)
    const pending = getPendingMessages();
    expect(pending).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('should process multiple messages in a batch', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'Hello' });
    insertMessage('m2', { sender: 'Bob', text: 'World' });

    const provider = new MockProvider({}, () => '<message to="discord-test">Got both messages</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Got both messages');

    await loopPromise.catch(() => {});
  });

  it('should resolve thread_id per-destination, not from global routing', async () => {
    // Seed a second destination
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-test', 'Slack Test', 'channel', 'slack', 'chan-2', NULL)`,
      )
      .run();

    // Insert messages from each destination with distinct thread IDs
    insertMessage('m-discord', { sender: 'Alice', text: 'from discord' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'discord-thread-1' });
    insertMessage('m-slack', { sender: 'Bob', text: 'from slack' }, { platformId: 'chan-2', channelType: 'slack', threadId: 'slack-thread-99' });

    // Agent replies to both destinations
    const provider = new MockProvider({}, () =>
      '<message to="discord-test">reply-d</message><message to="slack-test">reply-s</message>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length >= 2, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    const discordOut = out.find((m) => m.platform_id === 'chan-1');
    const slackOut = out.find((m) => m.platform_id === 'chan-2');

    expect(discordOut).toBeDefined();
    expect(discordOut!.thread_id).toBe('discord-thread-1');
    expect(discordOut!.in_reply_to).toBe('m-discord');

    expect(slackOut).toBeDefined();
    expect(slackOut!.thread_id).toBe('slack-thread-99');
    expect(slackOut!.in_reply_to).toBe('m-slack');

    await loopPromise.catch(() => {});
  });

  it('bare text produces no outbound messages (scratchpad only)', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hello' }, { platformId: 'chan-1', channelType: 'discord' });

    // Agent responds with bare text — no <message to="..."> wrapping
    const provider = new MockProvider({}, () => 'I am thinking about this...');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    // Wait long enough for the poll loop to process
    await sleep(1000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('unknown destination is dropped, valid destination is sent', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hi' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new MockProvider(
      {},
      () => '<message to="nonexistent">dropped</message><message to="discord-test">delivered</message>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    // Only the valid destination should produce output
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('delivered');
    expect(out[0].platform_id).toBe('chan-1');

    await loopPromise.catch(() => {});
  });

  it('multiple <message> blocks each produce an outbound message', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-test', 'Slack Test', 'channel', 'slack', 'chan-2', NULL)`,
      )
      .run();

    insertMessage('m1', { sender: 'Alice', text: 'broadcast' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new MockProvider(
      {},
      () => '<message to="discord-test">for discord</message><message to="slack-test">for slack</message>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length >= 2, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(2);
    const discord = out.find((m) => m.platform_id === 'chan-1');
    const slack = out.find((m) => m.platform_id === 'chan-2');
    expect(discord).toBeDefined();
    expect(JSON.parse(discord!.content).text).toBe('for discord');
    expect(slack).toBeDefined();
    expect(JSON.parse(slack!.content).text).toBe('for slack');

    await loopPromise.catch(() => {});
  });

  it('sends null thread_id when no prior inbound from destination', async () => {
    // Seed a second destination that has NO inbound messages
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-new', 'Slack New', 'channel', 'slack', 'chan-new', NULL)`,
      )
      .run();

    // Only insert a message from discord — slack-new has never sent anything
    insertMessage('m1', { sender: 'Alice', text: 'tell slack' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'discord-thread' });

    const provider = new MockProvider({}, () => '<message to="slack-new">hello slack</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('chan-new');
    expect(out[0].thread_id).toBeNull();

    await loopPromise.catch(() => {});
  });

  it('resolves most recent thread_id when destination has multiple inbound messages', async () => {
    // Two messages from same destination, different threads
    insertMessage('m-old', { sender: 'Alice', text: 'old' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-old' });
    insertMessage('m-new', { sender: 'Alice', text: 'new' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-new' });

    const provider = new MockProvider({}, () => '<message to="discord-test">reply</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].thread_id).toBe('thread-new');
    expect(out[0].in_reply_to).toBe('m-new');

    await loopPromise.catch(() => {});
  });

  it('should process messages arriving after loop starts', async () => {
    const provider = new MockProvider({}, () => '<message to="discord-test">Processed</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 3000);

    // Insert message after loop has started
    await sleep(200);
    insertMessage('m-late', { sender: 'Charlie', text: 'Late arrival' });

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out.length).toBeGreaterThanOrEqual(1);

    await loopPromise.catch(() => {});
  });

  it('internal tags between message blocks are stripped from scratchpad', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hi' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new MockProvider(
      {},
      () => '<internal>thinking about this...</internal><message to="discord-test">answer</message><internal>done thinking</internal>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('answer');

    await loopPromise.catch(() => {});
  });

  it('handles mixed task + chat batch with correct origin metadata', async () => {
    // Seed destination for routing lookup
    insertMessage('m-chat', { sender: 'Alice', text: 'check this' }, { platformId: 'chan-1', channelType: 'discord' });
    // Task with same routing — simulates a scheduled task in a channel session
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('t-task', 'task', datetime('now'), 'pending', 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ prompt: 'daily check' }));

    const provider = new MockProvider({}, () => '<message to="discord-test">done</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('chan-1');

    await loopPromise.catch(() => {});
  });

});

// Helper: run poll loop until aborted or timeout. The loop itself is
// registered in `activeLoops` so afterEach can shut it down for real.
async function runPollLoopWithTimeout(provider: AgentProvider, signal: AbortSignal, timeoutMs: number): Promise<void> {
  const queries: AgentQuery[] = [];
  const tracked: AgentProvider = {
    supportsNativeSlashCommands: provider.supportsNativeSlashCommands,
    isSessionInvalid: (err) => provider.isSessionInvalid(err),
    query: (input) => {
      const q = provider.query(input);
      queries.push(q);
      return q;
    },
    // Forward archiveSession only if the underlying provider implements it —
    // matches the real optional-method contract so tests that don't care
    // about archiving (the vast majority) aren't affected.
    ...(provider.archiveSession
      ? { archiveSession: (continuation: string, cwd: string) => provider.archiveSession!(continuation, cwd) }
      : {}),
  };
  const raw = runPollLoop({
    provider: tracked,
    providerName: 'mock',
    cwd: '/tmp',
  });
  activeLoops.push({ raw, queries });

  return Promise.race([
    raw,
    new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
  ]);
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(50);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('poll loop — provider error recovery', () => {
  it('writes error to outbound and continues loop on provider throw', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'trigger error' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new ThrowingProvider('API rate limit exceeded');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toContain('Error:');
    expect(JSON.parse(out[0].content).text).toContain('API rate limit exceeded');

    // Input message should be marked completed despite the error
    const pending = getPendingMessages();
    expect(pending).toHaveLength(0);

    await loopPromise.catch(() => {});
  });
});

describe('poll loop — stale session recovery', () => {
  it('clears continuation when provider reports session invalid', async () => {
    // Pre-seed a continuation so the local variable in runPollLoop is set.
    // Without this, the `if (continuation && isSessionInvalid)` check skips.
    setContinuation('mock', 'pre-existing-session');

    insertMessage('m1', { sender: 'Alice', text: 'stale session' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new InvalidSessionProvider();
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    // Error was written to outbound
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toContain('Error:');

    // Continuation was cleared (isSessionInvalid returned true)
    expect(getContinuation('mock')).toBeUndefined();

    await loopPromise.catch(() => {});
  });
});

describe('poll loop — /clear command', () => {
  it('clears session, writes confirmation, skips query', async () => {
    // Seed a continuation so we can verify it gets cleared
    setContinuation('mock', 'existing-session-id');
    expect(getContinuation('mock')).toBe('existing-session-id');

    // Insert a /clear command
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('m-clear', 'chat', datetime('now'), 'pending', 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ text: '/clear' }));

    const provider = new MockProvider({}, () => '<message to="discord-test">should not run</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Session cleared.');

    // Continuation was cleared
    expect(getContinuation('mock')).toBeUndefined();

    // Command message was completed
    const pending = getPendingMessages();
    expect(pending).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('TASK-28: archives the outgoing continuation before dropping it', async () => {
    setContinuation('mock', 'S1-old-transcript');

    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('m-clear', 'chat', datetime('now'), 'pending', 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ text: '/clear' }));

    const provider = new RecordingProvider('S2-unused', () => '<message to="discord-test">should not run</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    // /clear must not have started a query at all...
    expect(provider.continuations).toEqual([]);
    // ...but it must have archived the transcript it was about to discard,
    // same as the daily-rollover seam. Losing this on /clear is exactly the
    // transcript loss the archiver exists to prevent.
    expect(provider.archiveCalls).toEqual([{ continuation: 'S1-old-transcript', cwd: '/tmp' }]);
    expect(getContinuation('mock')).toBeUndefined();

    await loopPromise.catch(() => {});
  });
});

describe('poll loop — task-fresh session rollover', () => {
  it('task batch runs without resume; chat-only batch resumes', async () => {
    setContinuation('mock', 'S1-old-transcript');

    insertTask('t-task', { prompt: 'daily report' });

    const provider = new RecordingProvider('S2-fresh', () => '<message to="discord-test">report</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 4000);

    await waitFor(() => getUndeliveredMessages().length >= 1, 2000);

    // The task query must NOT have been handed the pre-rollover id.
    expect(provider.continuations).toEqual([undefined]);
    expect(getContinuation('mock')).toBe('S2-fresh');

    // Same-day chat resumes the FRESH session, not the old one.
    insertMessage('m-chat', { sender: 'Alice', text: 'follow up' }, { platformId: 'chan-1', channelType: 'discord' });
    await waitFor(() => provider.continuations.length >= 2, 3000);
    controller.abort();

    expect(provider.continuations[1]).toBe('S2-fresh');

    await loopPromise.catch(() => {});
  });

  it('C1: fresh task run that fails after init does not resume the pre-rollover id', async () => {
    setContinuation('mock', 'S1-old-transcript');

    insertTask('t-task', { prompt: 'daily report' });

    // First query: emits init 'S2-fresh' then throws (API 529 mid-stream).
    // Second query (the follow-up chat): succeeds.
    const provider = new RecordingProvider('S2-fresh', () => '<message to="discord-test">ok</message>', {
      throwOnFirstQuery: true,
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 4000);

    // Error response is written to outbound when the query throws.
    await waitFor(() => getUndeliveredMessages().some((m) => JSON.parse(m.content).text.startsWith('Error:')), 2000);
    expect(provider.continuations).toEqual([undefined]);

    insertMessage('m-chat', { sender: 'Alice', text: 'follow up' }, { platformId: 'chan-1', channelType: 'discord' });
    await waitFor(() => provider.continuations.length >= 2, 3000);
    controller.abort();

    // The whole point: the post-failure chat must not resume S1.
    expect(provider.continuations[1]).not.toBe('S1-old-transcript');
    expect(provider.continuations[1]).toBe('S2-fresh');

    await loopPromise.catch(() => {});
  });

  it('C1: a genuinely invalid session is still cleared, not resurrected by the re-sync', async () => {
    setContinuation('mock', 'pre-existing-session');
    insertMessage('m1', { sender: 'Alice', text: 'stale session' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new InvalidSessionProvider();
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    // init persisted 'doomed-session'; the catch must clear it, not keep it.
    expect(getContinuation('mock')).toBeUndefined();

    await loopPromise.catch(() => {});
  });

  it('I2: a task arriving mid-stream ends the stream and runs fresh instead of being pushed', async () => {
    setContinuation('mock', 'S1-old-transcript');

    insertMessage('m-chat', { sender: 'Alice', text: 'chatting at 06:19' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new RecordingProvider('S2-fresh', () => '<message to="discord-test">ok</message>', {
      keepOpen: true,
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 5000);

    // Wait for the chat query to be in flight (it resumes the old transcript).
    await waitFor(() => provider.continuations.length >= 1, 2000);
    expect(provider.continuations[0]).toBe('S1-old-transcript');

    // Cron fires at 06:20 while the chat stream is still open.
    insertTask('t-task', { prompt: 'daily digest' });

    // It must arrive as a NEW query with no resume — not as a push().
    await waitFor(() => provider.continuations.length >= 2, 4000);
    controller.abort();

    expect(provider.continuations[1]).toBeUndefined();
    expect(provider.pushes.join('\n')).not.toContain('daily digest');

    await loopPromise.catch(() => {});
  });

  it('TASK-28: archives the pre-rollover continuation before dropping it, ahead of the fresh query', async () => {
    setContinuation('mock', 'S1-old-transcript');

    insertTask('t-task', { prompt: 'daily report' });

    const provider = new RecordingProvider('S2-fresh', () => '<message to="discord-test">report</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 4000);

    await waitFor(() => getUndeliveredMessages().length >= 1, 2000);
    controller.abort();

    // Archived exactly the id that was about to be dropped, into the
    // configured cwd — and did so before the fresh query fired.
    expect(provider.archiveCalls).toEqual([{ continuation: 'S1-old-transcript', cwd: '/tmp' }]);
    expect(provider.callOrder).toEqual(['archive:S1-old-transcript', 'query:fresh']);
    expect(provider.continuations).toEqual([undefined]);

    await loopPromise.catch(() => {});
  });

  it('TASK-28: a throwing archiveSession never blocks the scheduled task from running', async () => {
    setContinuation('mock', 'S1-old-transcript');

    insertTask('t-task', { prompt: 'daily report' });

    const provider = new RecordingProvider('S2-fresh', () => '<message to="discord-test">report</message>', {
      archiveThrows: true,
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 4000);

    await waitFor(() => getUndeliveredMessages().length >= 1, 2000);
    controller.abort();

    // The archive call happened (and threw) but the task still ran fresh
    // and delivered its result normally.
    expect(provider.archiveCalls).toEqual([{ continuation: 'S1-old-transcript', cwd: '/tmp' }]);
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('report');
    expect(getContinuation('mock')).toBe('S2-fresh');

    await loopPromise.catch(() => {});
  });

  it('TASK-28: no archive call when there is no pre-rollover continuation to drop', async () => {
    // No setContinuation() call — first-ever task run for this session.
    insertTask('t-task', { prompt: 'daily report' });

    const provider = new RecordingProvider('S1-first-ever', () => '<message to="discord-test">report</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 4000);

    await waitFor(() => getUndeliveredMessages().length >= 1, 2000);
    controller.abort();

    expect(provider.archiveCalls).toEqual([]);

    await loopPromise.catch(() => {});
  });
});

function insertTask(id: string, content: object) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
       VALUES (?, 'task', datetime('now'), 'pending', 'chan-1', 'discord', ?)`,
    )
    .run(id, JSON.stringify(content));
}

/**
 * Provider that records the continuation it was handed on every query and
 * every push() it received, so tests can assert on resume behaviour.
 * Optionally throws after emitting `init` on the first query only.
 *
 * Also implements archiveSession() so rollover-archiving tests can assert
 * it was called with the pre-rollover id, in order relative to the fresh
 * query, and that a throwing implementation never blocks the turn.
 */
class RecordingProvider {
  readonly supportsNativeSlashCommands = false;
  readonly continuations: Array<string | undefined> = [];
  readonly pushes: string[] = [];
  readonly archiveCalls: Array<{ continuation: string; cwd: string }> = [];
  readonly callOrder: string[] = [];
  private queryCount = 0;

  constructor(
    private sessionId: string,
    private responseFactory: (prompt: string) => string,
    private opts: { throwOnFirstQuery?: boolean; keepOpen?: boolean; archiveThrows?: boolean } = {},
  ) {}

  isSessionInvalid(): boolean {
    return false;
  }

  async archiveSession(continuation: string, cwd: string): Promise<void> {
    this.archiveCalls.push({ continuation, cwd });
    this.callOrder.push(`archive:${continuation}`);
    if (this.opts.archiveThrows) throw new Error('archive boom');
  }

  query(input: { prompt: string; continuation?: string; cwd: string }) {
    this.continuations.push(input.continuation);
    this.callOrder.push(`query:${input.continuation ?? 'fresh'}`);
    const shouldThrow = this.opts.throwOnFirstQuery === true && this.queryCount === 0;
    // Closing the stream after the first result is the default so each batch
    // becomes its own query — that is what lets a test observe the resume
    // argument per batch. keepOpen models the live-stream case (I2).
    const keepOpen = this.opts.keepOpen === true;
    this.queryCount++;

    const sessionId = this.sessionId;
    const responseFactory = this.responseFactory;
    const pushes = this.pushes;
    const queued: string[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;

    return {
      push(message: string) {
        pushes.push(message);
        queued.push(message);
        waiting?.();
      },
      end() {
        ended = true;
        waiting?.();
      },
      abort() {
        ended = true;
        waiting?.();
      },
      events: (async function* () {
        yield { type: 'init' as const, continuation: sessionId };
        if (shouldThrow) throw new Error('Overloaded (529)');
        yield { type: 'result' as const, text: responseFactory(input.prompt) };
        while (keepOpen && !ended) {
          if (queued.length > 0) {
            yield { type: 'result' as const, text: responseFactory(queued.shift()!) };
            continue;
          }
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }
      })(),
    };
  }
}

/**
 * Provider that throws on every query, simulating API failures.
 */
class ThrowingProvider {
  readonly supportsNativeSlashCommands = false;
  private errorMessage: string;

  constructor(errorMessage: string) {
    this.errorMessage = errorMessage;
  }

  isSessionInvalid(): boolean {
    return false;
  }

  query(_input: { prompt: string; cwd: string }) {
    const errorMessage = this.errorMessage;
    return {
      push() {},
      end() {},
      abort() {},
      events: (async function* () {
        throw new Error(errorMessage);
      })(),
    };
  }
}

/**
 * Provider that throws with an error that triggers isSessionInvalid.
 * First emits an init event (setting continuation), then throws.
 */
class InvalidSessionProvider {
  readonly supportsNativeSlashCommands = false;

  isSessionInvalid(): boolean {
    return true;
  }

  query(_input: { prompt: string; cwd: string }) {
    return {
      push() {},
      end() {},
      abort() {},
      events: (async function* () {
        yield { type: 'init' as const, continuation: 'doomed-session' };
        throw new Error('session not found');
      })(),
    };
  }
}
