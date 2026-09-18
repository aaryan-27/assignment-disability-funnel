import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError, IntegrationError } from '../lib/errors.js';
import { isProduction } from '../config/env.js';
import { logger } from '../lib/logger.js';

/** Turn a ZodError into field-level messages the form can render inline. */
function formatZodError(error: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || '_';
    if (!fields[path]) fields[path] = issue.message;
  }
  return fields;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (error instanceof ZodError) {
    const fields = formatZodError(error);
    logger.warn('request.validation_failed', {
      request_id: req.requestId,
      path: req.path,
      // Field names only. Never the rejected values - they are user PII.
      fields: Object.keys(fields),
    });
    res.status(400).json({
      ok: false,
      error: { code: 'validation_error', message: 'Some answers need attention', fields },
      request_id: req.requestId,
    });
    return;
  }

  if (error instanceof AppError) {
    if (error.statusCode >= 500) {
      logger.error('request.app_error', { request_id: req.requestId, error });
    } else {
      logger.warn('request.app_error', {
        request_id: req.requestId,
        code: error.code,
        message: error.message,
      });
    }
    res.status(error.statusCode).json({
      ok: false,
      error: { code: error.code, message: error.message, details: error.details },
      request_id: req.requestId,
    });
    return;
  }

  if (error instanceof IntegrationError) {
    logger.error('request.integration_error', {
      request_id: req.requestId,
      integration: error.integration,
      retryable: error.retryable,
      error,
    });
    res.status(502).json({
      ok: false,
      error: { code: 'integration_error', message: 'A downstream service failed' },
      request_id: req.requestId,
    });
    return;
  }

  logger.error('request.unhandled_error', { request_id: req.requestId, path: req.path, error });
  res.status(500).json({
    ok: false,
    error: {
      code: 'internal_error',
      // Never leak internals to the browser in production.
      message: isProduction ? 'Something went wrong' : String(error),
    },
    request_id: req.requestId,
  });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    ok: false,
    error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` },
    request_id: req.requestId,
  });
}
