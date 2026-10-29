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
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

async function api<T = unknown>(path: string, init: RequestInit = {}, token?: string) {
  const res = await fetch(baseUrl + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T & { error?: { code: string; message: string; fields?: Record<string, string> }; requestId?: string } };
}

const ADMIN_PASSWORD = 'Trf-EndOfWork-Admin-42';
const AGM_PASSWORD = 'Trf-EndOfWork-AGM-42';
const ANALYST_PASSWORD = 'Trf-EndOfWork-Analyst-42';

let adminToken = '';
let agmToken = '';
let analystToken = '';

let baseCustomerId = 0;
let baseProductId = 0;
let testOptionId = 0;
let analystEmpId = 0;

before(async () => {
  if (!(await dbReachable)) return;

  await pool.query(
    `INSERT INTO employees (employee_code, full_name, email, username, password_hash, role, designation)
     VALUES ('EOW-ADMIN', 'EndOfWork Admin', 'eow-admin@test.local', 'eowadmin', $1, 'Admin', 'AGM')
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = TRUE, role = 'Admin', designation = 'AGM'`,
    [await hashPassword(ADMIN_PASSWORD)],
  );
  const adminRes = await api<{ accessToken: string }>('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'eowadmin', password: ADMIN_PASSWORD }),
  });
  adminToken = adminRes.body.accessToken;

  await pool.query(
    `INSERT INTO employees (employee_code, full_name, email, username, password_hash, role, designation)
     VALUES ('EOW-AGM', 'EndOfWork AGM', 'eow-agm@test.local', 'eowagm', $1, 'Admin', 'AGM')
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = TRUE, role = 'Admin', designation = 'AGM'`,
    [await hashPassword(AGM_PASSWORD)],
  );
  const agmRes = await api<{ accessToken: string }>('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'eowagm', password: AGM_PASSWORD }),
  });
  agmToken = agmRes.body.accessToken;

  await pool.query(
    `INSERT INTO employees (employee_code, full_name, email, username, password_hash, role, designation)
     VALUES ('EOW-ANA', 'EndOfWork Analyst', 'eow-ana@test.local', 'eowana', $1, 'Analyst', 'Junior Analyst')
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = TRUE, role = 'Analyst'`,
    [await hashPassword(ANALYST_PASSWORD)],
  );
  const analystRes = await api<{ accessToken: string }>('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'eowana', password: ANALYST_PASSWORD }),
  });
  analystToken = analystRes.body.accessToken;

  const suffix = Date.now().toString(36);
  const customer = await api<{ id: number }>('/api/lookups/customers', {
    method: 'POST', body: JSON.stringify({ name: `EOW Customer ${suffix}`, code: `EOWC-${suffix}` }),
  }, adminToken);
  baseCustomerId = customer.body.id;

  const product = await api<{ id: number }>('/api/lookups/products', {
    method: 'POST', body: JSON.stringify({ name: `EOW Product ${suffix}`, code: `EOWP-${suffix}` }),
  }, adminToken);
  baseProductId = product.body.id;

  const testOpts = await pool.query<{ id: number }>('SELECT id FROM test_requested_options ORDER BY id LIMIT 1');
  if (!testOpts.rowCount) {
    await pool.query("INSERT INTO test_requested_options (name, display_order) VALUES ('Test Option 1', 1)");
  }
  testOptionId = (await pool.query<{ id: number }>('SELECT id FROM test_requested_options ORDER BY id LIMIT 1')).rows[0].id;

  const dosageOpts = await pool.query<{ id: number }>('SELECT id FROM dosage_form_options ORDER BY id LIMIT 1');
  if (!dosageOpts.rowCount) {
    await pool.query("INSERT INTO dosage_form_options (name, display_order) VALUES ('Tablet', 1)");
  }

  // Get the analyst employee ID for assignment tests
  const analystEmpRes = await pool.query<{ id: number }>(`SELECT id FROM employees WHERE username = 'eowana'`);
  analystEmpId = analystEmpRes.rows[0].id;
});

async function createApprovedTrf(): Promise<{ trf: TrfDetail; id: number; version: number }> {
  const today = new Date().toISOString().slice(0, 10);
  const dosageOpt = (await pool.query<{ id: number }>('SELECT id FROM dosage_form_options ORDER BY id LIMIT 1')).rows[0].id;

  const createRes = await api<TrfDetail>('/api/trfs', {
    method: 'POST',
    body: JSON.stringify({
      trfDate: today,
      customerId: baseCustomerId,
      productId: baseProductId,
      testRequestedOptionIds: [testOptionId],
      dosageFormOptionIds: [dosageOpt],
    }),
  }, adminToken);
  assert.equal(createRes.status, 201, JSON.stringify(createRes.body));

  const trf = createRes.body;
  const decisionRes = await api<TrfDetail>(`/api/trfs/${trf.id}/decision`, {
    method: 'POST',
    body: JSON.stringify({ track: 'FORMULATION', decision: 'Approved', version: trf.version }),
  }, adminToken);
  assert.equal(decisionRes.status, 200, JSON.stringify(decisionRes.body));
  return { trf: decisionRes.body, id: trf.id, version: decisionRes.body.version };
}

async function createCompletedAssignmentWithResult(trfId: number): Promise<{ assignmentId: number; version: number }> {
  // Create assignment with the analyst assigned
  const assignRes = await api<{ assignmentId: number; version: number }>(`/api/ard-assignments`, {
    method: 'POST',
    body: JSON.stringify({
      trfId, testRequestedOptionId: testOptionId, testName: 'Test Option 1', analystIds: [analystEmpId],
    }),
  }, adminToken);
  const assignmentId = assignRes.body.assignmentId;
  const version = assignRes.body.version;

  // Insert result directly into the database
  await pool.query(
    `INSERT INTO ard_assignment_results (assignment_id, result_value, unit, method_used, specification, lower_limit, upper_limit, outcome, remarks, entered_by)
     VALUES ($1, '99.5', '%', 'HPLC', '98-102', '98', '102', 'Pass', 'Within specification', $2)`,
    [assignmentId, analystEmpId]
  );

  // Mark assignment as Completed
  await api(`/api/ard-assignments/${assignmentId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'Completed', version, note: null }),
  }, adminToken);

  return { assignmentId, version };
}

maybe('ard-submit: fails when Formulation is not approved', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const dosageOpt = (await pool.query<{ id: number }>('SELECT id FROM dosage_form_options ORDER BY id LIMIT 1')).rows[0].id;

  const createRes = await api<TrfDetail>('/api/trfs', {
    method: 'POST',
    body: JSON.stringify({
      trfDate: today,
      customerId: baseCustomerId,
      productId: baseProductId,
      testRequestedOptionIds: [testOptionId],
      dosageFormOptionIds: [dosageOpt],
    }),
  }, adminToken);
  const trf = createRes.body;

  const submitRes = await api(`/api/trfs/${trf.id}/ard-submit`, {
    method: 'POST',
    body: JSON.stringify({ version: trf.version }),
  }, adminToken);
  assert.equal(submitRes.status, 409);
  assert.equal(submitRes.body.error?.code, 'FORMULATION_NOT_APPROVED');
  await pool.query('DELETE FROM trfs WHERE id = $1', [trf.id]);
});

maybe('ard-submit: fails when no test assignments exist', async () => {
  const { id, version } = await createApprovedTrf();
  const submitRes = await api(`/api/trfs/${id}/ard-submit`, {
    method: 'POST',
    body: JSON.stringify({ version }),
  }, adminToken);
  assert.equal(submitRes.status, 409);
  assert.equal(submitRes.body.error?.code, 'NO_ASSIGNMENTS');
  await pool.query('DELETE FROM trfs WHERE id = $1', [id]);
});

maybe('ard-submit: fails when assignments are not completed', async () => {
  const { id, version } = await createApprovedTrf();

  // Create an assignment in "In Progress" status
  const assignRes = await api(`/api/ard-assignments`, {
    method: 'POST',
    body: JSON.stringify({
      trfId: id, testRequestedOptionId: testOptionId, testName: 'Test Option 1', analystIds: [analystEmpId],
    }),
  }, adminToken);
  const assignmentId = assignRes.body.assignmentId;

  // Set status to In Progress (not Completed)
  await api(`/api/ard-assignments/${assignmentId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'In Progress', version: assignRes.body.version, note: null }),
  }, adminToken);

  const submitRes = await api(`/api/trfs/${id}/ard-submit`, {
    method: 'POST',
    body: JSON.stringify({ version }),
  }, adminToken);
  assert.equal(submitRes.status, 409);
  assert.equal(submitRes.body.error?.code, 'TESTS_NOT_COMPLETED');
  await pool.query('DELETE FROM trfs WHERE id = $1', [id]);
});

maybe('ard-submit: succeeds when all assignments are completed with results', async () => {
  const { id } = await createApprovedTrf();

  await createCompletedAssignmentWithResult(id);

  // Reload TRF to get current version
  const trfRes = await api<TrfDetail>(`/api/trfs/${id}`, {}, adminToken);
  const version = trfRes.body.version;

  const submitRes = await api(`/api/trfs/${id}/ard-submit`, {
    method: 'POST',
    body: JSON.stringify({ version, note: 'All tests completed' }),
  }, adminToken);
  assert.equal(submitRes.status, 200, JSON.stringify(submitRes.body));
  assert.equal(submitRes.body.finalApprovalStatus, 'Pending');
  assert.equal(submitRes.body.workflowStatus, 'Completed');
  assert.ok(submitRes.body.ardSubmittedAt, 'ardSubmittedAt should be set');
  await pool.query('DELETE FROM trfs WHERE id = $1', [id]);
});

maybe('agm-complete: AGM can approve a submitted TRF and lock it', async () => {
  const { id } = await createApprovedTrf();

  await createCompletedAssignmentWithResult(id);

  // Submit to AGM
  const trfRes = await api<TrfDetail>(`/api/trfs/${id}`, {}, adminToken);
  const submitRes = await api(`/api/trfs/${id}/ard-submit`, {
    method: 'POST',
    body: JSON.stringify({ version: trfRes.body.version }),
  }, adminToken);
  assert.equal(submitRes.status, 200, JSON.stringify(submitRes.body));

  // AGM completes
  const afterSubmit = await api<TrfDetail>(`/api/trfs/${id}`, {}, adminToken);
  const completeRes = await api(`/api/trfs/${id}/agm-complete`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'Approved', version: afterSubmit.body.version }),
  }, agmToken);
  assert.equal(completeRes.status, 200, JSON.stringify(completeRes.body));
  assert.equal(completeRes.body.finalApprovalStatus, 'Approved');
  assert.ok(completeRes.body.lockedAt, 'TRF should be locked');
  assert.ok(completeRes.body.completedByAgm, 'completedByAgm should be set');
  assert.ok(completeRes.body.completedAt, 'completedAt should be set');
  await pool.query('DELETE FROM trfs WHERE id = $1', [id]);
});

maybe('agm-complete: AGM can reject a submitted TRF', async () => {
  const { id } = await createApprovedTrf();

  await createCompletedAssignmentWithResult(id);

  const trfRes = await api<TrfDetail>(`/api/trfs/${id}`, {}, adminToken);
  await api(`/api/trfs/${id}/ard-submit`, {
    method: 'POST',
    body: JSON.stringify({ version: trfRes.body.version }),
  }, adminToken);

  const afterSubmit = await api<TrfDetail>(`/api/trfs/${id}`, {}, adminToken);
  const rejectRes = await api(`/api/trfs/${id}/agm-complete`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'Rejected', version: afterSubmit.body.version, reason: 'Results need re-checking' }),
  }, agmToken);
  assert.equal(rejectRes.status, 200, JSON.stringify(rejectRes.body));
  assert.equal(rejectRes.body.finalApprovalStatus, 'Rejected');
  assert.equal(rejectRes.body.workflowStatus, 'In Progress');
  assert.equal(rejectRes.body.ardSubmittedAt, null);
  await pool.query('DELETE FROM trfs WHERE id = $1', [id]);
});

maybe('agm-complete: non-admin cannot call the route', async () => {
  const { id } = await createApprovedTrf();
  const res = await api(`/api/trfs/${id}/agm-complete`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'Approved', version: 1 }),
  }, analystToken);
  assert.equal(res.status, 403);
  await pool.query('DELETE FROM trfs WHERE id = $1', [id]);
});

maybe('workflow: locked TRF cannot be edited', async () => {
  const { id } = await createApprovedTrf();

  await createCompletedAssignmentWithResult(id);

  // Submit to AGM
  const trfRes = await api<TrfDetail>(`/api/trfs/${id}`, {}, adminToken);
  await api(`/api/trfs/${id}/ard-submit`, {
    method: 'POST',
    body: JSON.stringify({ version: trfRes.body.version }),
  }, adminToken);

  // AGM completes and locks
  const afterSubmit = await api<TrfDetail>(`/api/trfs/${id}`, {}, adminToken);
  const completeRes = await api(`/api/trfs/${id}/agm-complete`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'Approved', version: afterSubmit.body.version }),
  }, agmToken);
  assert.equal(completeRes.status, 200);

  // Try to PATCH a locked TRF - should fail
  const patchRes = await api(`/api/trfs/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ remarks: 'should fail', version: completeRes.body.version }),
  }, adminToken);
  assert.equal(patchRes.status, 409);
  assert.equal(patchRes.body.error?.code, 'TRF_LOCKED');

  // Try to submit again when locked
  const submitRes = await api(`/api/trfs/${id}/ard-submit`, {
    method: 'POST',
    body: JSON.stringify({ version: completeRes.body.version }),
  }, adminToken);
  assert.equal(submitRes.status, 409);
  assert.equal(submitRes.body.error?.code, 'TRF_LOCKED');

  await pool.query('DELETE FROM trfs WHERE id = $1', [id]);
});

maybe('workflow: full end-to-end submit and complete', async () => {
  const { id } = await createApprovedTrf();

  await createCompletedAssignmentWithResult(id);

  // Verify ardSubmittedAt, completedByAgm are null before submit
  const beforeSubmit = await api<TrfDetail>(`/api/trfs/${id}`, {}, adminToken);
  assert.equal(beforeSubmit.body.ardSubmittedAt, null);
  assert.equal(beforeSubmit.body.completedByAgm, null);
  assert.equal(beforeSubmit.body.completedAt, null);

  // Submit to AGM
  const submitRes = await api(`/api/trfs/${id}/ard-submit`, {
    method: 'POST',
    body: JSON.stringify({ version: beforeSubmit.body.version, note: 'Ready for review' }),
  }, adminToken);
  assert.equal(submitRes.status, 200, JSON.stringify(submitRes.body));
  assert.ok(submitRes.body.ardSubmittedAt);
  assert.equal(submitRes.body.finalApprovalStatus, 'Pending');

  // AGM approves
  const afterSubmit = await api<TrfDetail>(`/api/trfs/${id}`, {}, adminToken);
  const completeRes = await api(`/api/trfs/${id}/agm-complete`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'Approved', version: afterSubmit.body.version }),
  }, agmToken);
  assert.equal(completeRes.status, 200, JSON.stringify(completeRes.body));
  assert.equal(completeRes.body.finalApprovalStatus, 'Approved');
  assert.ok(completeRes.body.lockedAt);
  assert.ok(completeRes.body.completedByAgm);
  assert.ok(completeRes.body.completedAt);
  assert.equal(completeRes.body.completedByAgmName, 'EndOfWork AGM');

  await pool.query('DELETE FROM trfs WHERE id = $1', [id]);
});

maybe('approvals: ard-submit creates a PENDING ARD approval row', async () => {
  const { id } = await createApprovedTrf();

  await createCompletedAssignmentWithResult(id);

  const trfRes = await api<TrfDetail>(`/api/trfs/${id}`, {}, adminToken);
  await api(`/api/trfs/${id}/ard-submit`, {
    method: 'POST',
    body: JSON.stringify({ version: trfRes.body.version }),
  }, adminToken);

  const approvalsRes = await api<{ items: any[] }>(`/api/trfs/${id}/approvals`, {}, adminToken);
  assert.equal(approvalsRes.status, 200);
  const ardApprovals = approvalsRes.body.items.filter((a: any) => a.track === 'ARD');
  assert.ok(ardApprovals.length > 0, 'There should be at least one ARD approval row');
  const latest = ardApprovals[0];
  assert.equal(latest.status, 'Pending');

  await pool.query('DELETE FROM trfs WHERE id = $1', [id]);
});
