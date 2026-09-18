import type { NextFunction, Request, Response } from 'express';
import { randomId } from '@funnel/shared';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      clientIp: string;
    }
  }
}

/**
 * Attach a request id and a trustworthy client IP.
 *
 * The IP matters twice: it is a Meta match key, and it is the rate-limit
 * bucket. We only honour X-Forwarded-For when Express is configured to trust a
 * proxy, otherwise a client could spoof the header and bypass rate limiting.
 */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  req.requestId = incoming && incoming.length <= 80 ? incoming : `req_${randomId(14)}`;
  req.clientIp = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  res.setHeader('x-request-id', req.requestId);
  next();
}
