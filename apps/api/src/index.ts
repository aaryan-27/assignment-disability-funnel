import { createApp } from './app.js';
import { describeIntegrations, env } from './config/env.js';
import { logger } from './lib/logger.js';
import { startOutboxWorker, stopOutboxWorker } from './services/outbox/worker.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info('server.started', {
    port: env.PORT,
    env: env.NODE_ENV,
    funnel_version: env.FUNNEL_VERSION,
    integrations: describeIntegrations(),
  });
});

startOutboxWorker();

/**
 * Graceful shutdown.
 *
 * Stop accepting new work, let in-flight requests finish, then exit. Without
 * this, a deploy during a traffic spike drops live lead submissions - the most
 * expensive requests the system handles.
 */
function shutdown(signal: string): void {
  logger.info('server.shutdown_started', { signal });
  stopOutboxWorker();

  server.close((error) => {
    if (error) {
      logger.error('server.shutdown_failed', { error });
      process.exit(1);
    }
    logger.info('server.shutdown_complete');
    process.exit(0);
  });

  // Never hang forever waiting on a stuck connection.
  setTimeout(() => {
    logger.error('server.shutdown_forced');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('process.unhandled_rejection', { error: reason });
});

process.on('uncaughtException', (error) => {
  logger.error('process.uncaught_exception', { error });
  shutdown('uncaughtException');
});
