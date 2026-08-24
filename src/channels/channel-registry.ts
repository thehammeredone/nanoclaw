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
 *     (including the `got` library's `Response code 502 (Bad Gateway)`
 *     shape), walking `err.cause` (bounded depth) in case the HTTP-shaped
 *     error is wrapped
 *   - timeout / connection-reset-class errors by Node `code`, or
 *     `AbortError` / `TimeoutError` by name — the `code` lookup also walks
 *     `err.cause` (bounded depth, cycle-guarded) since Node's `fetch` puts
 *     the real code there (e.g. `TypeError: fetch failed` with
 *     `cause: {code: 'ENOTFOUND'}`), not on the top-level error
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

/** Max depth walked when following `err.cause` chains — bounded so a
 * pathological or self-referential `cause` can't spin forever. */
const CAUSE_CHAIN_MAX_DEPTH = 5;

/** True if `value` is a number that could plausibly be an HTTP status code.
 * Guards against shapes like `{status: 'ERR_BAD_RESPONSE', statusCode: 503}`
 * where a non-numeric `status` field would otherwise short-circuit past the
 * real numeric `statusCode` if read with `??`. */
function isPlausibleHttpStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599;
}

/** Best-effort HTTP status extraction across the shapes different adapter
 * SDKs use. Walks `err.cause` (bounded, cycle-guarded) in case the
 * HTTP-shaped error is wrapped by a generic error (e.g. `fetch failed`). */
function extractHttpStatus(err: Error): number | undefined {
  let current: unknown = err;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < CAUSE_CHAIN_MAX_DEPTH && current != null; depth++) {
    if (typeof current !== 'object' || seen.has(current)) break;
    seen.add(current);

    const candidate = current as {
      status?: unknown;
      statusCode?: unknown;
      httpStatus?: unknown;
      response?: { status?: unknown; statusCode?: unknown };
    };
    for (const value of [
      candidate.status,
      candidate.statusCode,
      candidate.httpStatus,
      candidate.response?.status,
      candidate.response?.statusCode,
    ]) {
      if (isPlausibleHttpStatus(value)) return value;
    }

    current = (current as { cause?: unknown }).cause;
  }

  // Last resort: sniff the message for shapes like the Matrix adapter's
  // `HTTPError: Server returned 502 error`, a generic `status code 503`, or
  // the `got` library's `HTTPError: Response code 502 (Bad Gateway)`.
  const match = err.message.match(/(?:returned|status code|response code)\s+(\d{3})\b/i);
  if (match) {
    const parsed = Number(match[1]);
    if (isPlausibleHttpStatus(parsed)) return parsed;
  }

  return undefined;
}

/** Extract a Node-style error `code` from `err`, walking `err.cause`
 * (bounded, cycle-guarded) since Node's `fetch` puts the real code on
 * `cause`, not on the top-level error — e.g. `TypeError: fetch failed` with
 * `cause: {code: 'ENOTFOUND'}`. */
function extractErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < CAUSE_CHAIN_MAX_DEPTH && current != null; depth++) {
    if (typeof current !== 'object' || seen.has(current)) break;
    seen.add(current);

    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;

    current = (current as { cause?: unknown }).cause;
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

  const code = extractErrorCode(err);
  if (code !== undefined && TRANSIENT_ERROR_CODES.has(code)) return true;

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

/**
 * Bumped by `teardownChannelAdapters()` (and `_resetForTests()`) to cancel
 * any setup attempt still parked on `await adapter.setup(...)` — pending
 * timers can be cleared outright, but an in-flight `await` cannot be
 * interrupted, so every retry chain (in-window and background) captures the
 * generation it started with and checks it immediately after each
 * `adapter.setup()` call returns or throws. A mismatch means teardown ran
 * while the attempt was in flight: bail out silently, without touching
 * `activeAdapters` and without scheduling anything further.
 */
let cancellationGeneration = 0;

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
 * *next* attempt to schedule. `generation` is the cancellation generation
 * this retry chain started under (see `cancellationGeneration`) — defaults
 * to the current generation for the initial call; recursive
 * self-reschedules must pass it through explicitly so the whole chain shares
 * one generation, not a fresh snapshot per hop.
 */
function scheduleBackgroundRetry(
  name: string,
  adapter: ChannelAdapter,
  setup: ChannelSetup,
  attempt: number,
  generation: number = cancellationGeneration,
): void {
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
      let err: unknown;
      try {
        await adapter.setup(setup);
      } catch (thrown) {
        err = thrown;
      }

      if (cancellationGeneration !== generation) {
        // teardownChannelAdapters() ran while this attempt was in flight.
        // Bail out silently: don't repopulate activeAdapters (success case)
        // and don't schedule another timer into a map that was just cleared
        // (failure case).
        backgroundRetryTimers.delete(name);
        return;
      }

      if (err === undefined) {
        backgroundRetryTimers.delete(name);
        activeAdapters.set(adapter.channelType, adapter);
        log.info('Channel adapter recovered via background retry', {
          channel: name,
          type: adapter.channelType,
          attempt: attempt + 1,
        });
        return;
      }

      if (isTransientSetupError(err)) {
        const isFinalAttempt = attempt + 1 >= BACKGROUND_RETRY_DELAYS_MS.length;
        // Don't log "scheduling another attempt" when the very next call
        // will immediately hit the ceiling branch above and log "giving up
        // permanently" — operators grep these lines, and logging both back
        // to back on the last attempt is misleading.
        if (!isFinalAttempt) {
          log.warn('Channel adapter background retry failed, scheduling another attempt', {
            channel: name,
            attempt: attempt + 1,
            err: (err as Error).message,
          });
        }
        scheduleBackgroundRetry(name, adapter, setup, attempt + 1, generation);
      } else {
        backgroundRetryTimers.delete(name);
        log.error('Channel adapter background retry hit a non-transient error, giving up permanently', {
          channel: name,
          attempt: attempt + 1,
          err,
        });
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
      const generation = cancellationGeneration;
      let attempt = 0;
      let setupError: unknown;
      let cancelled = false;
      while (true) {
        try {
          await adapter.setup(setup);
          if (cancellationGeneration !== generation) {
            cancelled = true;
            break;
          }
          setupError = undefined;
          break;
        } catch (err) {
          if (cancellationGeneration !== generation) {
            cancelled = true;
            break;
          }
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

      if (cancelled) {
        // teardownChannelAdapters() ran while this attempt was in flight.
        // Bail out silently: don't repopulate activeAdapters and don't
        // schedule a background retry into a map that was just cleared.
        continue;
      }

      if (setupError !== undefined) {
        if (isTransientSetupError(setupError)) {
          log.error('Channel adapter setup exhausted in-window retries, scheduling background retry', {
            channel: name,
            err: setupError.message,
          });
          scheduleBackgroundRetry(name, adapter, setup, 0, generation);
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

/** Tear down all active adapters and cancel any pending background retries.
 * Also cancels any setup attempt currently parked on `await adapter.setup(...)`
 * — see `cancellationGeneration` — so it can't repopulate `activeAdapters` or
 * schedule a fresh retry timer after this function returns. */
export async function teardownChannelAdapters(): Promise<void> {
  cancellationGeneration += 1;

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
  // Also cancels any in-flight setup attempt left over from a previous test
  // (an `await adapter.setup(...)` that hasn't resolved yet) so it can't
  // write into this test's fresh state once it does resolve.
  cancellationGeneration += 1;

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
