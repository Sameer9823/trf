import { buildApp, logger } from './app';
import { config } from './config';
import { pool, isDatabaseReachable } from './db';
import { runMigrations } from './migrate';

/**
 * Checks that required columns exist on the `trfs` table. Returns the list of
 * missing columns so the server can log exactly what needs a migration.
 */
async function checkRequiredColumns(): Promise<string[]> {
  const result = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'trfs'`,
  );
  const existing = new Set(result.rows.map((row) => row.column_name));
  const required = [
    'trf_number', 'trf_date', 'customer_id', 'product_id', 'batch_number',
    'sample_quantity', 'sample_received_date', 'required_completion_date',
    'priority', 'requested_analysis', 'special_instructions', 'department_id',
    'remarks', 'created_by', 'created_at', 'updated_at', 'version', 'status',
    'assigned_employee_id', 'deleted_at', 'deleted_by',
    'batch_size', 'dosage_form', 'manufacturing_location', 'label_claim',
    'pack_size', 'pack_type', 'storage_condition', 'storage_period',
    'manufacturing_date', 'expiry_date', 'analysis_purpose',
     'sample_given_by', 'signature_date',
     'sample_submitted_by_id',
     'ard_number', 'ard_stage', 'ard_analyst_id', 'analysis_start_date',
    'reporting_status', 'coa_status', 'workflow_status', 'ard_remarks',
    'finalized_at', 'remarks_status', 'sample_received_by',
  ];
  return required.filter((col) => !existing.has(col));
}

/** Essential tables the server needs to function. */
const REQUIRED_TABLES = ['trfs', 'employees', 'departments', 'customers', 'products', 'analysis_tests', 'coas'];

/**
 * Checks that required tables and columns exist after migration. If essential
 * schema is missing, the server refuses to start so operators see the failure
 * immediately rather than getting 500s on every request.
 */
async function checkSchema(): Promise<void> {
  const missingTables: string[] = [];
  for (const table of REQUIRED_TABLES) {
    const result = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = $1`,
      [table],
    );
    if (result.rowCount === 0) missingTables.push(table);
  }
  if (missingTables.length) {
    throw new Error(`Missing required tables: ${missingTables.join(', ')}`);
  }
  const missingColumns = await checkRequiredColumns();
  if (missingColumns.length) {
    throw new Error(`Missing required TRF columns: ${missingColumns.join(', ')}`);
  }
}

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
    try {
      await checkSchema();
      logger.info('Database schema verified');
    } catch (err) {
      logger.error({ err }, 'Database schema check failed');
      throw err;
    }
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
