import type { NextFunction, Request, Response } from 'express';
import { env, isAdminTokenInsecure, isProduction } from '../config/env.js';
import { unauthorized } from '../lib/errors.js';
import { safeCompare } from '../lib/hash.js';
import { logger } from '../lib/logger.js';

/**
 * Shared-secret guard for /admin.
 *
 * A static token is the right weight for an internal ops view in a take-home;
 * in production this sits behind the company SSO / identity proxy instead, and
 * the README says so. What matters is that the observability endpoints are not
 * simply open - they expose lead counts and error detail.
 */
export function adminAuth(req: Request, _res: Response, next: NextFunction): void {
  const provided = req.header('x-admin-token') ?? '';

  if (isProduction && isAdminTokenInsecure()) {
    // Refuse to serve lead data behind a missing or guessable placeholder token.
    next(unauthorized('Admin API is not configured'));
    return;
  }

  if (!env.ADMIN_API_TOKEN) {
    if (isProduction) {
      next(unauthorized('Admin API is not configured'));
      return;
    }
    next();
    return;
  }

  if (!provided || !safeCompare(provided, env.ADMIN_API_TOKEN)) {
    logger.warn('admin.unauthorized', { request_id: req.requestId, path: req.path });
    next(unauthorized('Invalid admin token'));
    return;
  }

  next();
}
