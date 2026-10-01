import { pool, withTransaction } from './db';
import { config } from './config';
import { runMigrations } from './migrate';
import { hashPassword } from './lib/password';
import { writeAudit } from './lib/audit';

/**
 * Creates the first administrator. Run manually by the administrator
 * (npm run seed:admin -w @trf/server), never automatically on server start,
 * and never with a password committed to the repository.
 */
async function seedAdmin() {
  const missing = (['ADMIN_USERNAME', 'ADMIN_PASSWORD'] as const).filter((key) => !config[key]);
  if (missing.length) {
    console.error(`Set these variables in apps/server/.env first: ${missing.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  await runMigrations();

  const existing = await pool.query(`SELECT count(*)::int AS count FROM employees WHERE role = 'Admin' AND is_active = TRUE`);
  if (existing.rows[0].count > 0) {
    console.log('An active administrator already exists. Nothing to do.');
    return;
  }

  const username = config.ADMIN_USERNAME!;
  const email = (config.ADMIN_EMAIL ?? `${username}@company.local`).toLowerCase();
  const employeeCode = config.ADMIN_EMPLOYEE_CODE ?? 'ADMIN-001';
  const fullName = config.ADMIN_FULL_NAME ?? 'System Administrator';

  const passwordHash = await hashPassword(config.ADMIN_PASSWORD!);
  await withTransaction(async (client) => {
    const result = await client.query<{ id: number }>(
      `INSERT INTO employees (employee_code, full_name, email, username, password_hash, role, must_change_password)
       VALUES ($1, $2, $3, $4, $5, 'Admin', TRUE)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [employeeCode, fullName, email, username, passwordHash],
    );
    const row = result.rows[0];
    if (!row) {
      console.log('That username, email or employee code is already in use. Nothing was created.');
      return;
    }
    await writeAudit(client, {
      userName: fullName, action: 'employee.created', module: 'employees',
      recordType: 'Employee', recordRef: employeeCode,
      newValue: { fullName, role: 'Admin', source: 'seed' },
    });
    console.log(`Administrator created: ${username}. The password must be changed at first sign-in.`);
  });
}

seedAdmin()
  .catch((err) => {
    console.error(`Could not create the administrator: ${(err as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
