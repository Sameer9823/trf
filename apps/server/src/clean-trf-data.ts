import { pool } from './db';
import { config } from './config';

/**
 * Cleans TRF and ARD related tables while preserving lookup tables and users.
 * Run manually: npx tsx apps/server/src/clean-trf-data.ts
 */
async function cleanTrfData() {
  console.log('Starting TRF data cleanup...');
  console.log(`Database: ${config.DATABASE_NAME} on ${config.DATABASE_HOST}:${config.DATABASE_PORT}`);

  const tables = [
    // ARD assignment tables (must be deleted first due to FK constraints)
    'ard_test_assignment_history',
    'ard_test_assignment_analysts',
    'ard_test_assignments',
    
    // TRF junction tables
    'trf_dosage_forms',
    'trf_test_requested',
    
    // TRF status/history tables
    'trf_status_history',
    'trf_lock_history',
    
    // TRF approvals
    'trf_approvals',
    
    // TRF main table
    'trfs',
  ];

  try {
    await pool.query('BEGIN');

    // Disable triggers temporarily for faster cleanup
    for (const table of tables) {
      await pool.query(`ALTER TABLE ${table} DISABLE TRIGGER ALL`);
    }

    // Truncate all tables in order
    for (const table of tables) {
      try {
        const result = await pool.query(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`);
        console.log(`  Truncated ${table}`);
      } catch (err) {
        // Table might not exist yet
        console.log(`  Skipped ${table} (${(err as Error).message})`);
      }
    }

    // Re-enable triggers
    for (const table of tables) {
      await pool.query(`ALTER TABLE ${table} ENABLE TRIGGER ALL`);
    }

    // Reset sequences for TRF tables
    await pool.query(`ALTER SEQUENCE trfs_id_seq RESTART WITH 1`);
    await pool.query(`ALTER SEQUENCE ard_test_assignments_id_seq RESTART WITH 1`);
    await pool.query(`ALTER SEQUENCE ard_test_assignment_analysts_id_seq RESTART WITH 1`);
    await pool.query(`ALTER SEQUENCE ard_test_assignment_history_id_seq RESTART WITH 1`);
    await pool.query(`ALTER SEQUENCE trf_status_history_id_seq RESTART WITH 1`);
    await pool.query(`ALTER SEQUENCE trf_lock_history_id_seq RESTART WITH 1`);
    await pool.query(`ALTER SEQUENCE trf_approvals_id_seq RESTART WITH 1`);
    await pool.query(`ALTER SEQUENCE trf_test_requested_id_seq RESTART WITH 1`);
    await pool.query(`ALTER SEQUENCE trf_dosage_forms_id_seq RESTART WITH 1`);

    await pool.query('COMMIT');
    console.log('\nTRF data cleanup completed successfully!');
    console.log('Lookup tables (customers, products, employees, test_requested_options, dosage_form_options) preserved.');

  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('Cleanup failed:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

cleanTrfData();