import { buildApp, logger } from './app';
import { config } from './config';
import { pool, isDatabaseReachable } from './db';
import { runMigrations } from './migrate';

/**
 * How long to let an in-flight request finish before giving up on it. A request
 * that is still running after this is almost certainly stuck on a database lock,
 * and holding the process open for it would stop the deployment from completing.
 */
const SHUTDOWN_GRACE_MS = 20_000;

async function main() {
  const app = buildApp();
  if (await isDatabaseReachable()) {
    await runMigrations();
  } else {
    // Starting anyway is deliberate: the desktop app needs a server to ask, so it
    // can show "company server is unavailable" rather than a connection refused.
    logger.error('PostgreSQL is not reachable. The API will report "degraded" until it is.');
  }

  const server = app.listen(config.API_PORT, config.API_HOST, () =>
    logger.info({ host: config.API_HOST, port: config.API_PORT }, 'TRF API listening'));

  let stopping = false;

  /**
   * Order matters on the way down. Stop accepting new connections first, so
   * nothing new starts while the database is closing; then drain what is running;
   * only then end the pool. Closing the pool first would fail the requests that
   * were still being served.
   */
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'Shutting down');

    const forced = setTimeout(() => {
      logger.warn('Some requests did not finish in time. Closing anyway.');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    // The timer must not hold the process open on its own.
    forced.unref();

    server.close(async () => {
      clearTimeout(forced);
      try {
        await pool.end();
        logger.info('Shutdown complete');
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'The database pool did not close cleanly');
        process.exit(1);
      }
    });
  };

  // On Windows a service stop arrives as SIGTERM too, so both are handled the same way.
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // A crash leaves a stack trace nobody will read in a log file. Log it, then let
  // the process end the way a supervisor expects.
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
    shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    shutdown('uncaughtException');
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'The API could not start');
  process.exit(1);
});
