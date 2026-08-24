/**
 * Channel adapter registry.
 *
 * Channels self-register on import. The host calls initChannelAdapters() at startup
 * to instantiate and set up all registered adapters.
 */
import type { ChannelAdapter, ChannelRegistration, ChannelSetup } from './adapter.js';
import { log } from '../log.js';

/*
 * ---------------------------------------------------------------------------
 * Retry policy for adapter setup (TASK-21)
 * ---------------------------------------------------------------------------
 * Adapter `setup()` calls hit external services (homeserver `whoami`,
 * webhook registration, etc.) and can fail on a transient blip — a 502 from
 * a reverse proxy, a DNS hiccup, a connection reset. Before this policy, only
 * the Chat SDK's own `NetworkError` type was retried; anything else (e.g. an
 * `HTTPError: Server returned 502 error` from a homeserver behind Caddy) fell
 * straight through to "failed to start channel adapter" and the channel was
 * never added to `activeAdapters` — permanently unroutable until a manual
 * process restart, no matter how quickly the upstream recovered.
 *
 * What's transient (retried) — see `isTransientSetupError`:
 *   - `NetworkError`-named errors (Chat SDK's own type)
 *   - HTTP-shaped errors with status 429 or 5xx, read defensively from
 *     several common shapes since adapters come from different SDKs
 *   - timeout / connection-reset-class errors by Node `code`, or
 *     `AbortError` / `TimeoutError` by name
 * What's NOT transient (fails fast, no retry at all):
 *   - any other 4xx (401/400/403/404/...) — a bad token or misconfigured
 *     channel will not fix itself on a retry; retrying it just delays the
 *     operator noticing a real config problem
 *   - anything that doesn't match the above (unknown shape) — fail fast
 *     rather than silently retry an error we can't classify
 *
 * Two-stage retry ladder, both stages transient-only:
 *   1. In-window: up to 3 retries during `initChannelAdapters()` itself, at
 *      2s / 5s / 10s (SETUP_RETRY_DELAYS_MS) — ~17s wall clock. Covers a
 *      blip that clears within the startup window.
 *   2. Background: if the in-window ladder is exhausted and the last error
 *      was still transient, `scheduleBackgroundRetry()` keeps trying in the
 *      background — up to 6 attempts at 15s / 30s / 60s / 120s / 240s / 300s
 *      (BACKGROUND_RETRY_DELAYS_MS), topping out at 5 minutes between tries,
 *      ~12.75 minutes additional wall clock. On success the adapter is added
 *      to `activeAdapters` and logged at info. On a non-transient error, or
 *      once the background ceiling is reached, nanoclaw logs at error and
 *      gives up on that channel *permanently* for the rest of the process
 *      lifetime — a manual restart is required at that point (see
 *      docs/runbooks/matrix-homeserver-resume.md).
 *
 * Background timers are `setTimeout(...).unref()`'d so a pending retry can
 * never hold the process open at shutdown, and are cancelled by
 * `teardownChannelAdapters()`.
 * ---------------------------------------------------------------------------
 */

const SETUP_RETRY_DELAYS_MS = [2000, 5000, 10000];
const BACKGROUND_RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 240_000, 300_000];

const TRANSIENT_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/** Best-effort HTTP status extraction across the shapes different adapter SDKs use. */
function extractHttpStatus(err: Error): number | undefined {
  const candidate = err as {
    status?: unknown;
    statusCode?: unknown;
    httpStatus?: unknown;
    response?: { status?: unknown };
  };
  const direct = candidate.status ?? candidate.statusCode ?? candidate.httpStatus ?? candidate.response?.status;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;

  // Last resort: sniff the message for shapes like the Matrix adapter's
  // `HTTPError: Server returned 502 error` or a generic `status code 503`.
  const match = err.message.match(/(?:returned|status code)\s+(\d{3})\b/i);
  if (match) {
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed)) return parsed;
  }

  return undefined;
}

/** Duck-type check — see the policy comment block above for what counts as
 * transient. Avoids depending on `@chat-adapter/shared` (or any other
 * adapter SDK's error classes) at trunk level. */
function isTransientSetupError(err: unknown): err is Error {
  if (!(err instanceof Error)) return false;

  if (err.name === 'NetworkError') return true;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;

  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && TRANSIENT_ERROR_CODES.has(code)) return true;

  const status = extractHttpStatus(err);
  if (status !== undefined) {
    return status === 429 || (status >= 500 && status < 600);
  }

  return false;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const registry = new Map<string, ChannelRegistration>();
const activeAdapters = new Map<string, ChannelAdapter>();
const backgroundRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Register a channel adapter factory. Called by channel modules on import. */
export function registerChannelAdapter(name: string, registration: ChannelRegistration): void {
  registry.set(name, registration);
}

/** Get a live adapter by channel type. */
export function getChannelAdapter(channelType: string): ChannelAdapter | undefined {
  return activeAdapters.get(channelType);
}

/** Get all active adapters. */
export function getActiveAdapters(): ChannelAdapter[] {
  return [...activeAdapters.values()];
}

/** Get all registered channel names. */
export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}

/** Get container config for a channel (used by container-runner for additional mounts/env). */
export function getChannelContainerConfig(name: string): ChannelRegistration['containerConfig'] {
  return registry.get(name)?.containerConfig;
}

/**
 * Schedule a background retry of `adapter.setup(setup)` after the in-window
 * ladder is exhausted. Self-reschedules on further transient failures up to
 * BACKGROUND_RETRY_DELAYS_MS.length attempts; gives up permanently (logged
 * at error) on a non-transient error or once the ceiling is reached. See the
 * policy comment block near the top of this file for the full ladder.
 *
 * `attempt` is the 0-based index into BACKGROUND_RETRY_DELAYS_MS for the
 * *next* attempt to schedule.
 */
function scheduleBackgroundRetry(name: string, adapter: ChannelAdapter, setup: ChannelSetup, attempt: number): void {
  if (attempt >= BACKGROUND_RETRY_DELAYS_MS.length) {
    backgroundRetryTimers.delete(name);
    log.error('Channel adapter background retry ceiling reached, giving up permanently', {
      channel: name,
      attempts: attempt,
    });
    return;
  }

  const delay = BACKGROUND_RETRY_DELAYS_MS[attempt]!;
  const timer = setTimeout(() => {
    void (async () => {
      try {
        await adapter.setup(setup);
        backgroundRetryTimers.delete(name);
        activeAdapters.set(adapter.channelType, adapter);
        log.info('Channel adapter recovered via background retry', {
          channel: name,
          type: adapter.channelType,
          attempt: attempt + 1,
        });
      } catch (err) {
        if (isTransientSetupError(err)) {
          log.warn('Channel adapter background retry failed, scheduling another attempt', {
            channel: name,
            attempt: attempt + 1,
            err: err.message,
          });
          scheduleBackgroundRetry(name, adapter, setup, attempt + 1);
        } else {
          backgroundRetryTimers.delete(name);
          log.error('Channel adapter background retry hit a non-transient error, giving up permanently', {
            channel: name,
            attempt: attempt + 1,
            err,
          });
        }
      }
    })();
  }, delay);
  timer.unref?.();
  backgroundRetryTimers.set(name, timer);
}

/**
 * Instantiate and set up all registered channel adapters.
 * Skips adapters that return null (missing credentials).
 */
export async function initChannelAdapters(setupFn: (adapter: ChannelAdapter) => ChannelSetup): Promise<void> {
  for (const [name, registration] of registry) {
    try {
      const adapter = await registration.factory();
      if (!adapter) {
        log.warn('Channel credentials missing, skipping', { channel: name });
        continue;
      }

      const setup = setupFn(adapter);
      // Transient failures during adapter init (e.g. a homeserver 502, a
      // DNS hiccup) would otherwise leave the channel permanently dead
      // until manual restart. Retry only on transient-shaped errors so
      // misconfigs (bad tokens, etc.) still fail fast. See the policy
      // comment block near the top of this file.
      let attempt = 0;
      let setupError: unknown;
      while (true) {
        try {
          await adapter.setup(setup);
          setupError = undefined;
          break;
        } catch (err) {
          if (isTransientSetupError(err) && attempt < SETUP_RETRY_DELAYS_MS.length) {
            const delay = SETUP_RETRY_DELAYS_MS[attempt]!;
            log.warn('Channel adapter setup failed with transient error, retrying', {
              channel: name,
              attempt: attempt + 1,
              delayMs: delay,
              err: err.message,
            });
            await sleep(delay);
            attempt += 1;
            continue;
          }
          setupError = err;
          break;
        }
      }

      if (setupError !== undefined) {
        if (isTransientSetupError(setupError)) {
          log.error('Channel adapter setup exhausted in-window retries, scheduling background retry', {
            channel: name,
            err: setupError.message,
          });
          scheduleBackgroundRetry(name, adapter, setup, 0);
        } else {
          log.error('Failed to start channel adapter', { channel: name, err: setupError });
        }
        continue;
      }

      activeAdapters.set(adapter.channelType, adapter);
      log.info('Channel adapter started', { channel: name, type: adapter.channelType });
    } catch (err) {
      log.error('Failed to start channel adapter', { channel: name, err });
    }
  }
}

/** Tear down all active adapters and cancel any pending background retries. */
export async function teardownChannelAdapters(): Promise<void> {
  for (const timer of backgroundRetryTimers.values()) {
    clearTimeout(timer);
  }
  backgroundRetryTimers.clear();

  for (const [name, adapter] of activeAdapters) {
    try {
      await adapter.teardown();
      log.info('Channel adapter stopped', { channel: name });
    } catch (err) {
      log.error('Failed to stop channel adapter', { channel: name, err });
    }
  }
  activeAdapters.clear();
}

/**
 * Test-only: reset all module state (registry, active adapters, pending
 * background retry timers). Not used by production code — `index.ts` never
 * needs to re-register adapters within a process lifetime.
 */
export function _resetForTests(): void {
  for (const timer of backgroundRetryTimers.values()) {
    clearTimeout(timer);
  }
  backgroundRetryTimers.clear();
  registry.clear();
  activeAdapters.clear();
}

/** Test-only: number of channels currently awaiting a background retry. */
export function _pendingBackgroundRetryCount(): number {
  return backgroundRetryTimers.size;
}
