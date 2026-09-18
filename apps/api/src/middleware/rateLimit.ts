import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { tooManyRequests } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/**
 * Fixed-window rate limiter, in memory.
 *
 * Deliberately not express-rate-limit: this is ~40 lines, has no dependency
 * surface, and the semantics are obvious. TRADE-OFF: per-instance state means
 * the effective limit multiplies by the instance count. Behind more than one
 * replica this moves to Redis (or to the edge / WAF, which is the better place
 * for it anyway).
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Bound memory: sweep expired buckets rather than growing without limit.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 60_000);
sweeper.unref?.();

export function rateLimit(options: { max: number; windowMs?: number; name: string }) {
  const windowMs = options.windowMs ?? env.RATE_LIMIT_WINDOW_MS;

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = `${options.name}:${req.clientIp}`;
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      res.setHeader('x-ratelimit-remaining', String(options.max - 1));
      next();
      return;
    }

    bucket.count += 1;

    if (bucket.count > options.max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('retry-after', String(retryAfter));
      res.setHeader('x-ratelimit-remaining', '0');
      logger.warn('rate_limit.exceeded', {
        limiter: options.name,
        request_id: req.requestId,
        count: bucket.count,
      });
      next(tooManyRequests(`Too many requests. Try again in ${retryAfter}s.`));
      return;
    }

    res.setHeader('x-ratelimit-remaining', String(Math.max(0, options.max - bucket.count)));
    next();
  };
}

export function resetRateLimits(): void {
  buckets.clear();
}
