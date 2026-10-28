import { pool, withTransaction } from './db';
import { config } from './config';
import { runMigrations } from './migrate';

/**
 * Deletes dummy department employees created by seed-dummy.ts.
 * Run manually: npm run delete:dummy -w @trf/server
 */
async function deleteDummyEmployees() {
  await runMigrations();

  const dummyEmployeeCodes = [
    'FORM-001', 'FORM-002', 'FORM-003', 'FORM-004',
    'ARD-001', 'ARD-002', 'ARD-003', 'ARD-004',
    'QC-001', 'QC-002', 'QC-003',
    'ADMIN-002',
  ];

  console.log('Deleting dummy employees...');

  // First, check which ones exist
  const placeholders = dummyEmployeeCodes.map((_, i) => `$${i + 1}`).join(', ');
  const checkResult = await pool.query<{ employee_code: string; id: number }>(
    `SELECT employee_code, id FROM employees WHERE employee_code IN (${placeholders})`,
    dummyEmployeeCodes
  );

  if (checkResult.rows.length === 0) {
    console.log('No dummy employees found to delete.');
    return;
  }

  console.log(`Found ${checkResult.rows.length} dummy employees to delete:`);
  for (const row of checkResult.rows) {
    console.log(`  - ${row.employee_code} (id: ${row.id})`);
  }

  // Get admin ID for reassigning TRFs
  const adminResult = await pool.query<{ id: number }>(
    `SELECT id FROM employees WHERE role = 'Admin' AND is_active = TRUE LIMIT 1`
  );
  const adminId = adminResult.rows[0]?.id ?? 1;

  // Delete them (with transaction to handle foreign keys)
  await withTransaction(async (client) => {
    for (const row of checkResult.rows) {
      // Delete audit logs for this employee
      await client.query(
        `DELETE FROM audit_logs WHERE user_id = $1 OR record_ref = $2`,
        [row.id, row.employee_code]
      );

      // Delete analysis_results where this employee entered results
      await client.query(
        `DELETE FROM analysis_results WHERE entered_by = $1`,
        [row.id]
      );

      // Delete analysis_tests where this employee is assigned
      await client.query(
        `DELETE FROM analysis_tests WHERE assigned_employee_id = $1`,
        [row.id]
      );

      // Delete COA where this employee prepared/reviewed/approved/issued
      await client.query(
        `DELETE FROM coas WHERE prepared_by = $1 OR reviewed_by = $1 OR approved_by = $1 OR issued_by = $1`,
        [row.id]
      );

      // Clear sample_submitted_by_id in TRFs (set to NULL)
      await client.query(
        `UPDATE trfs SET sample_submitted_by_id = NULL WHERE sample_submitted_by_id = $1`,
        [row.id]
      );

      // Clear assigned_employee_id in TRFs (set to NULL)
      await client.query(
        `UPDATE trfs SET assigned_employee_id = NULL WHERE assigned_employee_id = $1`,
        [row.id]
      );

      // Clear ard_analyst_id in TRFs (set to NULL)
      await client.query(
        `UPDATE trfs SET ard_analyst_id = NULL WHERE ard_analyst_id = $1`,
        [row.id]
      );

      // Clear deleted_by in TRFs (set to NULL)
      await client.query(
        `UPDATE trfs SET deleted_by = NULL WHERE deleted_by = $1`,
        [row.id]
      );

      // Clear changed_by in trf_status_history (set to NULL)
      await client.query(
        `UPDATE trf_status_history SET changed_by = NULL WHERE changed_by = $1`,
        [row.id]
      );

      // Reassign TRFs created by this employee to admin
      await client.query(
        `UPDATE trfs SET created_by = $1 WHERE created_by = $2`,
        [adminId, row.id]
      );

      // Finally delete the employee
      await client.query(
        `DELETE FROM employees WHERE id = $1`,
        [row.id]
      );

      console.log(`Deleted employee: ${row.employee_code} (id: ${row.id})`);
    }
  });

  console.log('\nAll dummy employees deleted successfully!');
}

deleteDummyEmployees()
  .catch((err) => {
    console.error(`Could not delete dummy employees: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());