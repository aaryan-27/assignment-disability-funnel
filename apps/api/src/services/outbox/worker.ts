import { env } from '../../config/env.js';
import { IntegrationError, toErrorMessage } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import {
  claimNextJob,
  incrementCounter,
  updateAutomationRun,
  updateJob,
} from '../../store/repository.js';
import type { OutboxJob } from '../../store/types.js';
import { JOB_HANDLERS } from './handlers.js';

/**
 * The transactional outbox worker.
 *
 * This is the piece that makes the system honest about failure. The request
 * path commits the lead and enqueues jobs; this loop is the only thing that
 * talks to Meta and n8n. Consequences:
 *
 *   - A downstream outage cannot lose a lead. It becomes a `failed` job with a
 *     retry schedule and a row in the admin view.
 *   - The user's success screen is not held hostage to a third party's latency.
 *   - Every attempt is recorded on an AutomationRun, so "what happened to lead
 *     ld_x?" is answerable without reading logs.
 *
 * In production this loop would run as a separate process (or a queue consumer)
 * so that API instances stay stateless. It runs in-process here because a
 * single deployable is the right call for a take-home; the boundary is clean
 * enough that extracting it is a config change.
 */

/**
 * Exponential backoff with EQUAL jitter.
 *
 * Jitter prevents a thundering herd of retries all firing the instant a
 * downstream recovers. But *full* jitter (`random() * exponential`) can return
 * a delay of nearly zero, which defeats the point: the job becomes due again
 * immediately and a single drain pass can burn the entire retry budget in
 * milliseconds, before the downstream has any chance to recover.
 *
 * Equal jitter keeps half the delay as a guaranteed floor and randomises the
 * other half, so retries are both spread out AND genuinely delayed.
 */
export function computeBackoffMs(
  attempt: number,
  baseMs = env.OUTBOX_BASE_BACKOFF_MS,
  maxMs = env.OUTBOX_MAX_BACKOFF_MS,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const half = exponential / 2;
  return Math.floor(half + random() * half);
}

export interface ProcessResult {
  job_id: string;
  status: OutboxJob['status'];
  attempts: number;
}

/** Process exactly one job. Exported so tests can drive the worker directly. */
export async function processJob(job: OutboxJob): Promise<ProcessResult> {
  const log = logger.child({ job_id: job.job_id, type: job.type, lead_id: job.lead_id });
  const startedAt = Date.now();

  await updateAutomationRun(job.run_id, {
    status: 'in_progress',
    retry_count: job.attempts - 1,
    last_attempt: new Date().toISOString(),
  });

  try {
    const handler = JOB_HANDLERS[job.type];
    if (!handler) {
      throw new IntegrationError('outbox', `No handler for job type ${job.type}`, {
        retryable: false,
      });
    }

    const { result } = await handler(job);
    const durationMs = Date.now() - startedAt;

    await updateJob(job.job_id, { status: 'succeeded', last_error: undefined });
    await updateAutomationRun(job.run_id, {
      status: 'succeeded',
      retry_count: job.attempts - 1,
      duration_ms: durationMs,
      error: undefined,
      result,
    });
    await incrementCounter(`outbox_succeeded_${job.type}`);

    log.info('outbox.job_succeeded', { attempts: job.attempts, duration_ms: durationMs, result });
    return { job_id: job.job_id, status: 'succeeded', attempts: job.attempts };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = toErrorMessage(error);
    const retryable = error instanceof IntegrationError ? error.retryable : true;
    const exhausted = job.attempts >= job.max_attempts;

    // Dead-letter when the error can never succeed, or when we have spent the
    // retry budget. Either way the job stays in the store and stays visible.
    const deadLetter = !retryable || exhausted;

    if (deadLetter) {
      await updateJob(job.job_id, { status: 'dead_letter', last_error: message });
      await updateAutomationRun(job.run_id, {
        status: 'dead_letter',
        retry_count: job.attempts - 1,
        duration_ms: durationMs,
        error: message,
      });
      await incrementCounter(`outbox_dead_letter_${job.type}`);

      log.error('outbox.job_dead_lettered', {
        attempts: job.attempts,
        max_attempts: job.max_attempts,
        retryable,
        error: message,
      });
      return { job_id: job.job_id, status: 'dead_letter', attempts: job.attempts };
    }

    const backoff = computeBackoffMs(job.attempts);
    const nextAttemptAt = new Date(Date.now() + backoff).toISOString();

    await updateJob(job.job_id, {
      status: 'failed',
      last_error: message,
      next_attempt_at: nextAttemptAt,
    });
    await updateAutomationRun(job.run_id, {
      status: 'failed',
      retry_count: job.attempts - 1,
      duration_ms: durationMs,
      error: message,
    });
    await incrementCounter(`outbox_failed_${job.type}`);

    log.warn('outbox.job_failed_will_retry', {
      attempts: job.attempts,
      next_attempt_at: nextAttemptAt,
      backoff_ms: backoff,
      error: message,
    });
    return { job_id: job.job_id, status: 'failed', attempts: job.attempts };
  }
}

/**
 * Drain every job that is currently due.
 *
 * A job is attempted at most once per pass. Without this guard a job that fails
 * early in the drain could have its (short) backoff elapse before the loop
 * finishes, be re-claimed in the same pass, and exhaust its retry budget
 * instantly - turning a transient blip into a dead letter.
 */
export async function drainOutbox(maxJobs = 25): Promise<ProcessResult[]> {
  const processed: ProcessResult[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < maxJobs; i += 1) {
    const job = await claimNextJob(seen);
    if (!job) break;
    seen.add(job.job_id);
    processed.push(await processJob(job));
  }

  return processed;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startOutboxWorker(): void {
  if (!env.OUTBOX_ENABLED) {
    logger.warn('outbox.worker_disabled');
    return;
  }
  if (timer) return;

  const tick = async (): Promise<void> => {
    // Guard against overlapping ticks when a drain outlasts the interval.
    if (running) return;
    running = true;
    try {
      const processed = await drainOutbox();
      if (processed.length > 0) {
        logger.debug('outbox.tick', { processed: processed.length });
      }
    } catch (error) {
      logger.error('outbox.tick_failed', { error });
    } finally {
      running = false;
    }
  };

  timer = setInterval(() => void tick(), env.OUTBOX_POLL_INTERVAL_MS);
  // Do not hold the event loop open on shutdown.
  timer.unref?.();
  logger.info('outbox.worker_started', { interval_ms: env.OUTBOX_POLL_INTERVAL_MS });
}

export function stopOutboxWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
