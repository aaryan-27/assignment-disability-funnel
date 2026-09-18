import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { corsOrigins, isProduction } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { requestContext } from './middleware/requestContext.js';
import { adminRouter } from './routes/admin.js';
import { eventsRouter } from './routes/events.js';
import { healthRouter } from './routes/health.js';
import { leadsRouter } from './routes/leads.js';
import { mockN8nRouter } from './routes/mockN8n.js';
import { logger } from './lib/logger.js';

export function createApp(): express.Express {
  const app = express();

  // Behind a load balancer, req.ip must come from X-Forwarded-For. Trusting
  // exactly one hop is the safe setting: trusting all hops lets a client forge
  // its own IP and defeat rate limiting.
  app.set('trust proxy', isProduction ? 1 : false);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The API serves JSON only; a restrictive CSP costs nothing here.
      contentSecurityPolicy: isProduction ? undefined : false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin / curl / server-to-server requests have no Origin header.
        if (!origin) return callback(null, true);
        if (corsOrigins.includes(origin)) return callback(null, true);
        logger.warn('cors.rejected_origin', { origin });
        return callback(new Error('Origin not allowed by CORS'));
      },
      credentials: false,
      allowedHeaders: ['content-type', 'idempotency-key', 'x-admin-token', 'x-request-id'],
      exposedHeaders: ['x-request-id', 'retry-after', 'x-ratelimit-remaining'],
      maxAge: 86_400,
    }),
  );

  // 64kb is far more than any legitimate funnel submission and small enough
  // that a payload-size attack is not interesting.
  app.use(express.json({ limit: '64kb' }));
  app.use(requestContext);

  // Lightweight access log. One line per request, already redacted.
  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      logger.debug('http.request', {
        request_id: req.requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: Date.now() - startedAt,
      });
    });
    next();
  });

  app.use('/', healthRouter);
  app.use('/api', leadsRouter);
  app.use('/api', eventsRouter);
  app.use('/admin', adminRouter);
  // Local stand-in for n8n. Harmless in production (it requires the signature)
  // but normally unreachable because N8N_WEBHOOK_URL points elsewhere.
  app.use('/mock/n8n', mockN8nRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
