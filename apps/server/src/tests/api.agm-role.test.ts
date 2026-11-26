import { strict as assert } from 'node:assert';
import { after, before, test, TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { TrfDetail } from '@trf/shared';
import { buildApp } from '../app';
import { pool, isDatabaseReachable } from '../db';
import { runMigrations } from '../migrate';
import { hashPassword } from '../lib/password';
const dbReachable = isDatabaseReachable().catch(() => false);
let server: Server;
let baseUrl = '';

function maybe(name: string, fn: (t: TestContext) => Promise<void>) {
  test(name, async (t) => {
    if (!(await dbReachable)) return t.skip('no PostgreSQL database available');
    await fn(t);
  });
}

before(async () => {
  if (!(await dbReachable)) return;
  await runMigrations();
  server = buildApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Admin with GM designation -> role Admin
  await pool.query(
    `INSERT INTO employees (employee_code, full_name, email, username, password_hash, role, designation)
     VALUES ('AR-ADMIN', 'AGM Role Admin', 'ar-admin@test.local', 'aradmin', $1, 'Admin', 'GM')
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = TRUE, role = 'Admin', designation = 'GM'`,
    [await hashPassword(ADMIN_PASSWORD)],
  );
  const adminRes = await api<{ accessToken: string }>('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'aradmin', password: ADMIN_PASSWORD }),
  });
  adminToken = adminRes.body.accessToken;

  // AGM with AGM designation -> role AGM
  await pool.query(
    `INSERT INTO employees (employee_code, full_name, email, username, password_hash, role, designation)
     VALUES ('AR-AGM', 'AGM Role AGM', 'ar-agm@test.local', 'aragm', $1, 'AGM', 'AGM')
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = TRUE, role = 'AGM', designation = 'AGM'`,
    [await hashPassword(AGM_PASSWORD)],
  );
  const agmRes = await api<{ accessToken: string }>('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'aragm', password: AGM_PASSWORD }),
  });
  agmToken = agmRes.body.accessToken;

  // Analyst
  await pool.query(
    `INSERT INTO employees (employee_code, full_name, email, username, password_hash, role, designation)
     VALUES ('AR-ANA', 'AGM Role Analyst', 'ar-ana@test.local', 'arana', $1, 'Analyst', 'Junior Analyst')
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = TRUE, role = 'Analyst'`,
    [await hashPassword(ANALYST_PASSWORD)],
  );
  const analystRes = await api<{ accessToken: string }>('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'arana', password: ANALYST_PASSWORD }),
  });
  analystToken = analystRes.body.accessToken;

  const analystEmp = await pool.query<{ id: number }>(`SELECT id FROM employees WHERE username = 'arana'`);
  analystEmpId = analystEmp.rows[0].id;

  const c = await pool.query<{ id: number }>(`INSERT INTO customers (name, code) VALUES ('AGM Role Customer', 'ARC-FIXTURE') ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`);
  const p = await pool.query<{ id: number }>(`INSERT INTO products (name, code) VALUES ('AGM Role Product', 'ARP-FIXTURE') ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`);
  customerId = c.rows[0].id;
  productId = p.rows[0].id;
  const tOpt = await pool.query<{ id: number }>('SELECT id FROM test_requested_options ORDER BY id LIMIT 1');
  if (!tOpt.rowCount) {
    await pool.query("INSERT INTO test_requested_options (name, display_order) VALUES ('Test Option 1', 1)");
  }
  testOptionId = (await pool.query<{ id: number }>('SELECT id FROM test_requested_options ORDER BY id LIMIT 1')).rows[0].id;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

async function api<T = any>(path: string, init: RequestInit = {}, token?: string) {
  const res = await fetch(baseUrl + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

const post = (path: string, body: unknown, token?: string) => api(path, { method: 'POST', body: JSON.stringify(body) }, token);

const ADMIN_PASSWORD = 'AgmRole-Admin-42';
const AGM_PASSWORD = 'AgmRole-AGM-42';
const ANALYST_PASSWORD = 'AgmRole-Analyst-42';

let adminToken = '';
let agmToken = '';
let analystToken = '';
let customerId = 0;
let productId = 0;
let testOptionId = 0;
let analystEmpId = 0;

const trfIds: number[] = [];

async function createApprovedTrf(): Promise<{ id: number; version: number }> {
  const today = new Date().toISOString().slice(0, 10);
  const createRes = await api<TrfDetail>('/api/trfs', {
    method: 'POST',
    body: JSON.stringify({
      trfDate: today,
      customerId,
      productId,
      testRequestedOptionIds: [testOptionId],
      dosageFormOptionIds: [1],
    }),
  }, adminToken);
  assert.equal(createRes.status, 201, JSON.stringify(createRes.body));
  const trf = createRes.body;
  const decisionRes = await api<TrfDetail>(`/api/trfs/${trf.id}/decision`, {
    method: 'POST',
    body: JSON.stringify({ track: 'FORMULATION', decision: 'Approved', version: trf.version }),
  }, adminToken);
  assert.equal(decisionRes.status, 200, JSON.stringify(decisionRes.body));
  trfIds.push(trf.id);
  return { id: trf.id, version: decisionRes.body.version };
}

async function createCompletedAssignmentWithResult(trfId: number): Promise<void> {
  await pool.query(
    `INSERT INTO ard_test_assignments (trf_id, test_requested_option_id, test_name, status)
     VALUES ($1, $2, 'Assay', 'Assigned')
     ON CONFLICT (trf_id, test_requested_option_id) DO UPDATE SET status = 'Assigned'
     RETURNING id`,
    [trfId, testOptionId],
  );
  const assignment = await pool.query<{ id: number }>(
    `SELECT id FROM ard_test_assignments WHERE trf_id = $1 AND test_requested_option_id = $2`,
    [trfId, testOptionId]);
  await pool.query(
    `INSERT INTO ard_assignment_results (assignment_id, entered_by, result_value, unit, outcome, review_status)
     VALUES ($1, $2, '99.5', 'mg/L', 'Pass', 'Submitted')`,
    [assignment.rows[0].id, analystEmpId]);
  // Mark assignment Completed and result Approved, so ard-submit can proceed
  await pool.query(`UPDATE ard_test_assignments SET status = 'Completed' WHERE id = $1`, [assignment.rows[0].id]);
  await pool.query(`UPDATE ard_assignment_results SET review_status = 'Approved' WHERE assignment_id = $1`, [assignment.rows[0].id]);
}

maybe('AGM gets 403 on agm-complete (approve)', async () => {
  const { id, version } = await createApprovedTrf();
  await createCompletedAssignmentWithResult(id);
  const trfRes = await api<TrfDetail>(`/api/trfs/${id}`, {}, adminToken);
  await api(`/api/trfs/${id}/ard-submit`, {
    method: 'POST',
    body: JSON.stringify({ version: trfRes.body.version }),
  }, adminToken);
  const completeRes = await api(`/api/trfs/${id}/agm-complete`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'Approved', version: trfRes.body.version }),
  }, agmToken);
  assert.equal(completeRes.status, 403, JSON.stringify(completeRes.body));
  await pool.query('DELETE FROM trfs WHERE id = $1', [id]);
});

maybe('AGM gets 403 on agm-complete (reject)', async () => {
  const { id, version } = await createApprovedTrf();
  await createCompletedAssignmentWithResult(id);
  const trfRes = await api<TrfDetail>(`/api/trfs/${id}`, {}, adminToken);
  await api(`/api/trfs/${id}/ard-submit`, {
    method: 'POST',
    body: JSON.stringify({ version: trfRes.body.version }),
  }, adminToken);
  const rejectRes = await api(`/api/trfs/${id}/agm-complete`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'Rejected', version: trfRes.body.version, reason: 'Needs more work' }),
  }, agmToken);
  assert.equal(rejectRes.status, 403, JSON.stringify(rejectRes.body));
  await pool.query('DELETE FROM trfs WHERE id = $1', [id]);
});

maybe('AGM gets 403 on unlock', async () => {
  const { id } = await createApprovedTrf();
  await createCompletedAssignmentWithResult(id);
  const trfRes = await api<TrfDetail>(`/api/trfs/${id}`, {}, adminToken);
  await api(`/api/trfs/${id}/ard-submit`, {
    method: 'POST',
    body: JSON.stringify({ version: trfRes.body.version }),
  }, adminToken);
  // Admin locks first
  const afterSubmit = await api<TrfDetail>(`/api/trfs/${id}`, {}, adminToken);
  const lockRes = await api(`/api/trfs/${id}/agm-complete`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'Approved', version: afterSubmit.body.version }),
  }, adminToken);
  assert.equal(lockRes.status, 200);
  // AGM tries to unlock
  const unlockRes = await api(`/api/trfs/${id}/unlock`, {
    method: 'POST',
    body: JSON.stringify({ version: lockRes.body.version, reason: 'Test unlock reason' }),
  }, agmToken);
  assert.equal(unlockRes.status, 403, JSON.stringify(unlockRes.body));
  await pool.query('DELETE FROM trfs WHERE id = $1', [id]);
});

maybe('AGM gets 403 on reopen', async () => {
  const { id } = await createApprovedTrf();
  const reopenRes = await api(`/api/trfs/${id}/reopen`, {
    method: 'POST',
    body: JSON.stringify({ version: 1, reason: 'Test reopen reason' }),
  }, agmToken);
  assert.equal(reopenRes.status, 403, JSON.stringify(reopenRes.body));
  await pool.query('DELETE FROM trfs WHERE id = $1', [id]);
});

maybe('Admin with GM designation can lock (agm-complete approve)', async () => {
  const { id } = await createApprovedTrf();
  await createCompletedAssignmentWithResult(id);
  const trfRes = await api<TrfDetail>(`/api/trfs/${id}`, {}, adminToken);
  await api(`/api/trfs/${id}/ard-submit`, {
    method: 'POST',
    body: JSON.stringify({ version: trfRes.body.version }),
  }, adminToken);
  const afterSubmit = await api<TrfDetail>(`/api/trfs/${id}`, {}, adminToken);
  const completeRes = await api(`/api/trfs/${id}/agm-complete`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'Approved', version: afterSubmit.body.version }),
  }, adminToken);
  assert.equal(completeRes.status, 200, JSON.stringify(completeRes.body));
  assert.equal(completeRes.body.finalApprovalStatus, 'Approved');
  assert.ok(completeRes.body.lockedAt);
  await pool.query('DELETE FROM trfs WHERE id = $1', [id]);
});

maybe('AGM can review test results', async () => {
  const { id } = await createApprovedTrf();
  await createCompletedAssignmentWithResult(id);
  // Submit to AGM so the TRF is in front of reviewers
  const trfRes = await api<TrfDetail>(`/api/trfs/${id}`, {}, adminToken);
  await api(`/api/trfs/${id}/ard-submit`, {
    method: 'POST',
    body: JSON.stringify({ version: trfRes.body.version }),
  }, adminToken);
  // AGM can access the result-review queue
  const queueRes = await api<{ items: unknown[] }>('/api/ard-assignments/result-reviews', {}, agmToken);
  assert.equal(queueRes.status, 200, JSON.stringify(queueRes.body));
  await pool.query('DELETE FROM trfs WHERE id = $1', [id]);
});

maybe('AGM can edit ARD details and save while final approval is Pending', async () => {
  const { id } = await createApprovedTrf();
  await createCompletedAssignmentWithResult(id);
  const trfRes = await api<TrfDetail>(`/api/trfs/${id}`, {}, adminToken);
  await api(`/api/trfs/${id}/ard-submit`, {
    method: 'POST',
    body: JSON.stringify({ version: trfRes.body.version }),
  }, adminToken);
  // Now final_approval_status is Pending, locked_at is NULL
  const detailRes = await api<TrfDetail>(`/api/trfs/${id}`, {}, agmToken);
  assert.equal(detailRes.status, 200);
  assert.equal(detailRes.body.finalApprovalStatus, 'Pending');
  assert.equal(detailRes.body.lockedAt, null);

  // AGM edits ARD remarks (an ARD approval field)
  const patchRes = await api<TrfDetail>(`/api/trfs/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      version: detailRes.body.version,
      ardRemarks: 'AGM reviewed and updated remarks',
    }),
  }, agmToken);
  assert.equal(patchRes.status, 200, JSON.stringify(patchRes.body));
  // Saving keeps final_approval_status 'Pending' and locked_at NULL
  assert.equal(patchRes.body.finalApprovalStatus, 'Pending');
  assert.equal(patchRes.body.lockedAt, null);
  await pool.query('DELETE FROM trfs WHERE id = $1', [id]);
});

maybe('migration 038 is idempotent', async () => {
  const applied = await runMigrations();
  // Second run should apply nothing (all already applied)
  assert.equal(applied.length, 0);
  // Role constraint includes AGM
  const constraint = await pool.query<{ conname: string; consrc: string }>(
    `SELECT conname, pg_get_constraintdef(oid) AS consrc FROM pg_constraint
     WHERE conrelid = 'employees'::regclass AND conname = 'employees_role_check'`);
  assert.ok(constraint.rowCount > 0, 'employees_role_check constraint exists');
  assert.ok(constraint.rows[0].consrc.includes('AGM'), 'constraint includes AGM');
});

maybe('AGM and Admin get the same company-wide dashboard totals', async () => {
  await createApprovedTrf();
  const adminDash = await api('/api/dashboard', {}, adminToken);
  const agmDash = await api('/api/dashboard', {}, agmToken);
  assert.equal(adminDash.status, 200, JSON.stringify(adminDash.body));
  assert.equal(agmDash.status, 200, JSON.stringify(agmDash.body));
  assert.equal(adminDash.body.scope, 'all');
  assert.equal(agmDash.body.scope, 'all');
  assert.deepEqual(adminDash.body.totals, agmDash.body.totals);
  await pool.query('DELETE FROM trfs WHERE id IN (SELECT id FROM trfs)');
});

maybe('reactivating an inactive AGM with role Admin derives role AGM from designation', async () => {
  const hashed = await hashPassword('Reactivation-Pass-42');
  const inserted = await pool.query<{ id: number }>(
    `INSERT INTO employees (employee_code, full_name, email, username, password_hash, role, designation, is_active, account_type)
     VALUES ('RE-AGM', 'Reactivation AGM', 're-activation@test.local', 'reagm', $1, 'Admin', 'AGM', FALSE, 'INDIVIDUAL')
     RETURNING id`,
    [hashed],
  );
  const empId = inserted.rows[0].id;
  try {
    const activateRes = await api<{ role: string; isActive: boolean; designation: string }>(`/api/employees/${empId}/activate`, {
      method: 'POST',
    }, adminToken);
    assert.equal(activateRes.status, 200, JSON.stringify(activateRes.body));
    assert.equal(activateRes.body.role, 'AGM', 'reactivated AGM should derive role AGM from designation');
    assert.equal(activateRes.body.isActive, true);
    assert.equal(activateRes.body.designation, 'AGM');

    const getRes = await api<{ role: string; isActive: boolean }>(`/api/employees/${empId}`, {}, adminToken);
    assert.equal(getRes.status, 200, JSON.stringify(getRes.body));
    assert.equal(getRes.body.role, 'AGM');
    assert.equal(getRes.body.isActive, true);
  } finally {
    await pool.query('DELETE FROM employees WHERE id = $1', [empId]);
  }
});
