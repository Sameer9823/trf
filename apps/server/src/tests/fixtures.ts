import { pool } from '../db';
import { hashPassword } from '../lib/password';
import { buildApp } from '../app';
import { runMigrations } from '../migrate';

/**
 * A customer, product, and test/dosage option IDs every test file can build TRFs on.
 * A TRF cannot be created without both a customer and a product, and now also needs
 * at least one test requested option and one dosage form option.
 */
export interface BaseLookups { customerId: number; productId: number; testRequestedOptionIds: number[]; dosageFormOptionIds: number[] }

let cached: BaseLookups | null = null;

export async function baseLookups(): Promise<BaseLookups> {
  if (cached) return cached;
  const customer = await pool.query<{ id: number }>(
    `INSERT INTO customers (name, code) VALUES ('Test Base Customer', 'TBC-FIXTURE')
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
  );
  const product = await pool.query<{ id: number }>(
    `INSERT INTO products (name, code) VALUES ('Test Base Product', 'TBP-FIXTURE')
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
  );
  const testOpt = await pool.query<{ id: number }>('SELECT id FROM test_requested_options ORDER BY id LIMIT 1');
  if (!testOpt.rowCount) {
    await pool.query("INSERT INTO test_requested_options (name, display_order) VALUES ('Test Option 1', 1)");
  }
  const dosageOpt = await pool.query<{ id: number }>('SELECT id FROM dosage_form_options ORDER BY id LIMIT 1');
  if (!dosageOpt.rowCount) {
    await pool.query("INSERT INTO dosage_form_options (name, display_order) VALUES ('Tablet', 1)");
  }
  cached = {
    customerId: customer.rows[0].id,
    productId: product.rows[0].id,
    testRequestedOptionIds: [(await pool.query<{ id: number }>('SELECT id FROM test_requested_options ORDER BY id LIMIT 1')).rows[0].id],
    dosageFormOptionIds: [(await pool.query<{ id: number }>('SELECT id FROM dosage_form_options ORDER BY id LIMIT 1')).rows[0].id],
  };
  return cached;
}

/**
 * Ensures the phase2admin user exists and returns its access token.
 * Used by test files that need an admin session without running the full auth test suite.
 */
export async function ensureAdmin(): Promise<string> {
  const password = 'Admin-Test-Password-42';
  const email = 'phase2-admin@test.local';
  await pool.query(
    `INSERT INTO employees (employee_code, full_name, email, username, password_hash, role)
     VALUES ('PHASE2-ADMIN', 'Phase2 Test Admin', $1, 'phase2admin', $2, 'Admin')
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = TRUE, role = 'Admin'`,
    [email, await hashPassword(password)],
  );
  const app = buildApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'phase2admin', password }),
  });
  await new Promise((resolve) => server.close(resolve));
  const body = await res.json();
  return body.accessToken as string;
}

/**
 * Assigns an analyst to one ARD test assignment on a TRF. The completion rule
 * (routes/trfs.ts) requires at least one non-cancelled test with an analyst
 * before the workflow can be completed, so tests that drive a TRF to Completed
 * need this. Idempotent: the unique (trf_id, test_requested_option_id) and
 * (assignment_id, analyst_id) pairs make a repeat a no-op.
 */
export async function assignAnalystToATest(trfId: number, analystId: number): Promise<void> {
  const option = await pool.query<{ id: number }>(
    'SELECT id FROM test_requested_options ORDER BY id LIMIT 1',
  );
  if (!option.rowCount) throw new Error('No test_requested_options row is available for the fixture');
  const assignment = await pool.query<{ id: number }>(
    `INSERT INTO ard_test_assignments (trf_id, test_requested_option_id, test_name, status)
     VALUES ($1, $2, 'Fixture test', 'Assigned')
     ON CONFLICT (trf_id, test_requested_option_id)
     DO UPDATE SET status = 'Assigned'
     RETURNING id`,
    [trfId, option.rows[0].id],
  );
  await pool.query(
    `INSERT INTO ard_test_assignment_analysts (assignment_id, analyst_id)
     VALUES ($1, $2)
     ON CONFLICT (assignment_id, analyst_id) DO NOTHING`,
    [assignment.rows[0].id, analystId],
  );
}

/**
 * Assigns an analyst to an ARD test assignment whose due date is in the past,
 * so the overdue counts (team list and employee detail) have something to find.
 * Idempotent on (trf_id, test_requested_option_id) and (assignment_id, analyst_id).
 */
export async function assignOverdueTest(trfId: number, analystId: number, dueDate: string): Promise<void> {
  const option = await pool.query<{ id: number }>(
    'SELECT id FROM test_requested_options ORDER BY id LIMIT 1',
  );
  if (!option.rowCount) throw new Error('No test_requested_options row is available for the fixture');
  const assignment = await pool.query<{ id: number }>(
    `INSERT INTO ard_test_assignments (trf_id, test_requested_option_id, test_name, status, due_date)
     VALUES ($1, $2, 'Overdue Test', 'Assigned', $3)
     ON CONFLICT (trf_id, test_requested_option_id)
     DO UPDATE SET status = 'Assigned', due_date = EXCLUDED.due_date
     RETURNING id`,
    [trfId, option.rows[0].id, dueDate],
  );
  await pool.query(
    `INSERT INTO ard_test_assignment_analysts (assignment_id, analyst_id)
     VALUES ($1, $2)
     ON CONFLICT (assignment_id, analyst_id) DO NOTHING`,
    [assignment.rows[0].id, analystId],
  );
}
