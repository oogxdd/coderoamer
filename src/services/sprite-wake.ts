import { Sprite } from '@/models/sprite';
import * as api from './api';

/**
 * Waking a cold Sprite.
 *
 * A wake is just the cheapest possible exec (`true`) — the platform boots the
 * machine to run it. Normally that takes a couple of seconds, but the request
 * can also hang: the exec socket connects and then nothing happens, and the
 * screen sits on "Waking…" indefinitely with every control useless because
 * nothing can run until the Sprite is up.
 *
 * So a wake attempt is bounded. When one overruns `WAKE_ATTEMPT_TIMEOUT_MS` the
 * stalled exec session is killed and a fresh attempt is started — restarting
 * the wake rather than waiting on a request that has already lost.
 */

export const WAKE_ATTEMPT_TIMEOUT_MS = 10_000;
export const MAX_WAKE_ATTEMPTS = 3;

export interface WakeProgress {
  /** 1-based attempt currently running. */
  attempt: number;
  /** How many attempts will be made in total before giving up. */
  attempts: number;
  /** True from the second attempt on — the previous one had to be restarted. */
  restarting: boolean;
}

export interface WakeResult {
  /** The Sprite as it looks after waking, when the wake succeeded. */
  sprite: Sprite | null;
  /** How many attempts were made. */
  attempts: number;
  /** True when every attempt overran its deadline. */
  timedOut: boolean;
  /** True when the caller aborted (left the screen) before finishing. */
  aborted: boolean;
}

export interface WakeOptions {
  signal?: AbortSignal;
  onProgress?: (progress: WakeProgress) => void;
  maxAttempts?: number;
  attemptTimeoutMs?: number;
}

/**
 * One bounded wake attempt. Resolves `true` when the exec ran to a clean exit.
 * A timed-out attempt kills its exec session so a stuck wake can't linger on
 * the Sprite while the next attempt runs.
 */
async function runWakeAttempt(
  spriteName: string,
  timeoutMs: number,
  outerSignal?: AbortSignal
): Promise<boolean> {
  const controller = new AbortController();
  const abortInner = () => controller.abort();
  outerSignal?.addEventListener('abort', abortInner);

  let execSessionId: string | undefined;
  let exitCode: number | undefined;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    await api.streamExec(
      spriteName,
      ['bash', '-c', 'true'],
      (event) => {
        if (event.type === 'exit') exitCode = event.exit_code ?? 0;
      },
      controller.signal,
      {
        path: '/bin/bash',
        maxRunAfterDisconnect: '1s',
        onSessionId: (sessionId) => {
          execSessionId = sessionId;
        },
      }
    );
  } catch {
    // Aborted (deadline or caller) or a transport error — both mean "retry".
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener('abort', abortInner);
  }

  if (exitCode !== 0 && execSessionId) {
    api.killExecSession(spriteName, execSessionId).catch(() => {});
  }
  return exitCode === 0;
}

/**
 * Wake a Sprite, restarting the attempt whenever one overruns its deadline.
 * Returns the refreshed Sprite on success; callers keep the UI blocked until
 * then, because nothing else on the screen can work against a cold Sprite.
 */
export async function wakeSprite(
  spriteName: string,
  options: WakeOptions = {}
): Promise<WakeResult> {
  const attempts = Math.max(1, options.maxAttempts ?? MAX_WAKE_ATTEMPTS);
  const timeoutMs = Math.max(1_000, options.attemptTimeoutMs ?? WAKE_ATTEMPT_TIMEOUT_MS);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (options.signal?.aborted) {
      return { sprite: null, attempts: attempt - 1, timedOut: false, aborted: true };
    }
    options.onProgress?.({ attempt, attempts, restarting: attempt > 1 });

    const awake = await runWakeAttempt(spriteName, timeoutMs, options.signal);
    if (options.signal?.aborted) {
      return { sprite: null, attempts: attempt, timedOut: false, aborted: true };
    }
    if (awake) {
      const sprite = await api.getSprite(spriteName).catch(() => null);
      return { sprite, attempts: attempt, timedOut: false, aborted: false };
    }
  }

  return { sprite: null, attempts, timedOut: true, aborted: false };
}
