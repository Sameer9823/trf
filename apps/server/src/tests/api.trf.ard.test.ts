import { strict as assert } from 'node:assert';
import { after, before, test, TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { TrfDetail, TrfListPage, StageOption } from '@trf/shared';
import { buildApp } from '../app';
import { pool, isDatabaseReachable } from '../db';
import { runMigrations } from '../migrate';
import { hashPassword } from '../lib/password';

const dbReachable = isDatabaseReachable().catch(() => false);
let server: Server;
let baseUrl = '';

/**
 * The ARD block of the TRF screen: the Stage, the Final Status, the Sample
 * Submitted By employee and the rules about who may change what. Each check
 * reports as skipped when no database is reachable, so a green run never
 * claims untested coverage.
 */
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
  return {
    status: res.status,
    body: (text ? JSON.parse(text) : null) as T & {
      error?: { code: string; message: string; fields?: Record<string, string> };
      requestId?: string;
    },
  };
}

const today = new Date().toISOString().slice(0, 10);

function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

const ADMIN_PASSWORD = 'Trf-Ard-Admin-42';

async function ensureAdmin(): Promise<string> {
  await pool.query(
    `INSERT INTO employees (employee_code, full_name, email, username, password_hash, role)
     VALUES ('TRF-ARD-ADMIN', 'TRF ARD Admin', 'trf-ard-admin@test.local', 'trfardadmin', $1, 'Admin')
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = TRUE, role = 'Admin'`,
    [await hashPassword(ADMIN_PASSWORD)],
  );
  const res = await api<{ accessToken: string }>('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'trfardadmin', password: ADMIN_PASSWORD }),
  });
  return res.body.accessToken;
}

let adminToken = '';

/** A user in a named department with a named role, so the matrix can be walked. */
async function userInDepartment(role: 'Analyst' | 'Manager' | 'Viewer', department: string): Promise<{
  token: string; id: number; fullName: string;
}> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const password = 'Trf-Ard-User-42';
  const dept = await pool.query<{ id: number }>(`SELECT id FROM departments WHERE name = $1 LIMIT 1`, [department]);
  const deptId = dept.rows[0]?.id ?? null;
  const username = `trfard${suffix}`;
  const fullName = `TRF ARD ${role} ${department} ${suffix}`;
  await pool.query(
    `INSERT INTO employees (employee_code, full_name, email, username, password_hash, role, department_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = TRUE,
       role = EXCLUDED.role, department_id = EXCLUDED.department_id`,
    [`TRF-ARD-${suffix}`, fullName, `${username}@test.local`, username, await hashPassword(password), role, deptId],
  );
  const found = await pool.query<{ id: number }>(`SELECT id FROM employees WHERE username = $1`, [username]);
  const res = await api<{ accessToken: string }>('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username, password }),
  });
  return { token: res.body.accessToken, id: found.rows[0].id, fullName };
}

let baseCustomerId = 0;
let baseProductId = 0;

async function createTrf(overrides: Record<string, unknown> = {}, token = adminToken) {
  return api<TrfDetail>('/api/trfs', {
    method: 'POST',
    body: JSON.stringify({
      trfDate: today,
      customerId: baseCustomerId,
      productId: baseProductId,
      batchNumber: null, sampleQuantity: null,
      sampleReceivedDate: null, requiredCompletionDate: null, priority: 'Normal',
      requestedAnalysis: null, specialInstructions: null, departmentId: null, remarks: null,
      batchSize: null, dosageForm: null, manufacturingLocation: null,
      labelClaim: null, packSize: null, packType: null, storageCondition: null,
      storagePeriod: null, manufacturingDate: null, expiryDate: null,
      analysisPurpose: null, sampleGivenBy: null, signatureDate: null,
      remarksStatus: 'Pending', sampleReceivedBy: null,
      ...overrides,
    }),
  }, token);
}

maybe('setup: an admin session and the base lookups exist', async () => {
  adminToken = await ensureAdmin();
  assert.ok(adminToken.length > 20, 'the admin got a token');

  const customer = await api<{ id: number }>('/api/lookups/customers', {
    method: 'POST', body: JSON.stringify({ name: `TRF ARD Customer ${Date.now()}`, code: `TAC-${Date.now()}` }),
  }, adminToken);
  baseCustomerId = customer.body.id;
  const product = await api<{ id: number }>('/api/lookups/products', {
    method: 'POST', body: JSON.stringify({ name: `TRF ARD Product ${Date.now()}`, code: `TAP-${Date.now()}` }),
  }, adminToken);
  baseProductId = product.body.id;
  assert.ok(baseCustomerId > 0 && baseProductId > 0);
});

/* ------------------------------------------------------------------ */
/* Sample Submitted By                                                */
/* ------------------------------------------------------------------ */

maybe('the backfill matches the legacy free text to an employee and leaves the rest NULL', async () => {
  const employee = await userInDepartment('Analyst', 'Formulation');
  const created = await createTrf({
    batchNumber: `BACKFILL-${Date.now()}`,
    sampleGivenBy: employee.fullName,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;

  // The API never writes the legacy column's match; the migration does.
  await pool.query(`UPDATE trfs SET sample_submitted_by_id = NULL WHERE id = $1`, [id]);
  const before = await pool.query<{ sample_submitted_by_id: number | null }>(
    `SELECT sample_submitted_by_id FROM trfs WHERE id = $1`, [id]);
  assert.equal(before.rows[0].sample_submitted_by_id, null);

  // The backfill from migration 011 matches the legacy text to an employee.
  // Migration 012 removed the narrow ard_stage CHECK, so we run just the
  // backfill UPDATE here instead of re-running the whole migration file.
  const backfillSql = `UPDATE trfs t
    SET sample_submitted_by_id = matched.id
    FROM (
      SELECT DISTINCT ON (lower(e.full_name)) e.id, lower(e.full_name) AS name
      FROM employees e
      WHERE e.full_name IS NOT NULL
      ORDER BY lower(e.full_name), e.id ASC
    ) matched
    WHERE t.sample_given_by IS NOT NULL
      AND t.sample_submitted_by_id IS NULL
      AND matched.name = lower(btrim(t.sample_given_by))`;
  await pool.query(backfillSql);

  const after = await pool.query<{ sample_submitted_by_id: number | null }>(
    `SELECT sample_submitted_by_id FROM trfs WHERE id = $1`, [id]);
  assert.equal(after.rows[0].sample_submitted_by_id, employee.id,
    'the legacy text was matched to the employee id');

  // A name that matches nothing stays NULL.
  const unmatched = await createTrf({
    batchNumber: `BACKFILL-NONE-${Date.now()}`,
    sampleGivenBy: 'Nobody At All',
  });
  await pool.query(`UPDATE trfs SET sample_submitted_by_id = NULL WHERE id = $1`, [unmatched.body.id]);
  await pool.query(backfillSql);
  const stillNull = await pool.query<{ sample_submitted_by_id: number | null }>(
    `SELECT sample_submitted_by_id FROM trfs WHERE id = $1`, [unmatched.body.id]);
  assert.equal(stillNull.rows[0].sample_submitted_by_id, null,
    'a name that matches no employee stays NULL');

  await pool.query('DELETE FROM trfs WHERE id = ANY($1)', [[id, unmatched.body.id]]);
});

maybe('the sample submitted by id must be an active employee', async () => {
  const created = await createTrf({ batchNumber: `SSB-VALIDATION-${Date.now()}` });
  assert.equal(created.status, 201);

  const unknown = await api(`/api/trfs/${created.body.id}`, {
    method: 'PATCH', body: JSON.stringify({ version: created.body.version, sampleSubmittedById: 999999 }),
  }, adminToken);
  assert.equal(unknown.status, 400, JSON.stringify(unknown.body));
  assert.ok(unknown.body.error?.fields?.sampleSubmittedById, 'the field must be named');

  // A deactivated employee is refused as well.
  const employee = await userInDepartment('Analyst', 'Formulation');
  await pool.query(`UPDATE employees SET is_active = FALSE WHERE id = $1`, [employee.id]);
  const inactive = await api(`/api/trfs/${created.body.id}`, {
    method: 'PATCH', body: JSON.stringify({ version: created.body.version, sampleSubmittedById: employee.id }),
  }, adminToken);
  assert.equal(inactive.status, 400, JSON.stringify(inactive.body));
  assert.ok(inactive.body.error?.fields?.sampleSubmittedById);
  await pool.query(`UPDATE employees SET is_active = TRUE WHERE id = $1`, [employee.id]);

  // An active employee is accepted and comes back with the name.
  const ok = await api<TrfDetail>(`/api/trfs/${created.body.id}`, {
    method: 'PATCH', body: JSON.stringify({ version: created.body.version, sampleSubmittedById: employee.id }),
  }, adminToken);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.sampleSubmittedById, employee.id);
  assert.equal(ok.body.sampleSubmittedByName, employee.fullName);

  await pool.query('DELETE FROM trfs WHERE id = $1', [created.body.id]);
});

maybe('the list can be searched by the sample submitted by name', async () => {
  const employee = await userInDepartment('Analyst', 'Formulation');
  const created = await createTrf({
    batchNumber: `SSB-SEARCH-${Date.now()}`,
    sampleSubmittedById: employee.id,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const res = await api<TrfListPage>(
    `/api/trfs?search=${encodeURIComponent(employee.fullName)}&pageSize=200`, {}, adminToken);
  assert.equal(res.status, 200);
  const found = res.body.items.find((t) => t.id === created.body.id);
  assert.ok(found, `the TRF must be found by the name "${employee.fullName}"`);
  assert.equal(found.sampleSubmittedByName, employee.fullName);

  await pool.query('DELETE FROM trfs WHERE id = $1', [created.body.id]);
});

maybe('the employee lookup lists active employees for anyone who can see a TRF', async () => {
  const ardAnalyst = await userInDepartment('Analyst', 'ARD');
  const res = await api<{ items: { id: number; fullName: string; designation: string | null; departmentName: string | null }[] }>(
    '/api/employees/for-select', {}, ardAnalyst.token);
  assert.equal(res.status, 200, 'an ARD user may call the read-only employee lookup');
  assert.ok(Array.isArray(res.body.items));
  const first = res.body.items[0];
  assert.ok(first && typeof first.id === 'number' && typeof first.fullName === 'string');
  assert.ok(!('password_hash' in first), 'the lookup must not leak anything but the name');
});

/* ------------------------------------------------------------------ */
/* Stage and Final Status                                             */
/* ------------------------------------------------------------------ */

maybe('Stage: Initial is the default, new stages are added via the lookup, unknown stages are refused, legacy values load', async () => {
  // A brand-new TRF defaults to the active "Initial" stage.
  const created = await createTrf({ batchNumber: `STAGE-${Date.now()}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.stage, 'Initial', 'new TRFs default to Initial');

  // Add a new stage through the lookup (Admin has Part B rights).
  const added = await api<{ item: { id: number; name: string; isActive: boolean }; duplicate: boolean }>(
    '/api/lookups/stages', { method: 'POST', body: JSON.stringify({ name: 'Sample Preparation' }) }, adminToken);
  assert.ok(added.status === 200 || added.status === 201, JSON.stringify(added.body));
  assert.equal(added.body.item.name, 'Sample Preparation');

  // Using the new stage on the TRF is accepted.
  const withStage = await api<TrfDetail>(`/api/trfs/${created.body.id}`, {
    method: 'PATCH', body: JSON.stringify({ version: created.body.version, ardStage: 'Sample Preparation' }),
  }, adminToken);
  assert.equal(withStage.status, 200, JSON.stringify(withStage.body));
  assert.equal(withStage.body.stage, 'Sample Preparation');
  created.body.version = withStage.body.version;

  // Re-adding the same stage (different casing) reuses the existing record.
  const reused = await api<{ item: { name: string }; duplicate: boolean }>(
    '/api/lookups/stages', { method: 'POST', body: JSON.stringify({ name: 'sample preparation' }) }, adminToken);
  assert.equal(reused.status, 200, JSON.stringify(reused.body));
  assert.equal(reused.body.duplicate, true);
  assert.equal(reused.body.item.name, 'Sample Preparation');

  // An unknown stage is a 400 with a field message, never a 500.
  const unknown = await api(`/api/trfs/${created.body.id}`, {
    method: 'PATCH', body: JSON.stringify({ version: created.body.version, ardStage: 'Coffee Break' }),
  }, adminToken);
  assert.equal(unknown.status, 400, JSON.stringify(unknown.body));
  assert.ok(unknown.body.error?.fields?.stage, 'the stage field must be named');

  // A legacy stage value on an existing row still loads and displays.
  const legacy = await createTrf({ batchNumber: `STAGE-LEGACY-${Date.now()}` });
  assert.equal(legacy.status, 201);
  await pool.query(`UPDATE trfs SET ard_stage = 'Received' WHERE id = $1`, [legacy.body.id]);
  const loaded = await api<TrfDetail>(`/api/trfs/${legacy.body.id}`, {}, adminToken);
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.stage, 'Received', 'a legacy stage value still loads');

  await pool.query('DELETE FROM trfs WHERE id = ANY($1)', [[created.body.id, legacy.body.id]]);
});

maybe('only ARD users (plus Admin/Manager) can add stages', async () => {
  const formulation = await userInDepartment('Analyst', 'Formulation');
  const ardAnalyst = await userInDepartment('Analyst', 'ARD');

  const refused = await api(`/api/lookups/stages`, {
    method: 'POST', body: JSON.stringify({ name: 'Formulation Stage' }),
  }, formulation.token);
  assert.equal(refused.status, 403, 'a Formulation user cannot add stages');

  const ok = await api<{ item: { name: string } }>(
    '/api/lookups/stages', { method: 'POST', body: JSON.stringify({ name: 'ARD Stage' }) }, ardAnalyst.token);
  assert.ok(ok.status === 200 || ok.status === 201, JSON.stringify(ok.body));
  assert.equal(ok.body.item.name, 'ARD Stage');
});

maybe('Reporting accepts Rejected and refuses an unknown value', async () => {
  const created = await createTrf({ batchNumber: `REPORTING-${Date.now()}` });
  assert.equal(created.status, 201);
  const id = created.body.id;

  const rejected = await api<TrfDetail>(`/api/trfs/${id}`, {
    method: 'PATCH', body: JSON.stringify({ version: created.body.version, reportingStatus: 'Rejected' }),
  }, adminToken);
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  assert.equal(rejected.body.reportingStatus, 'Rejected');

  const bad = await api(`/api/trfs/${id}`, {
    method: 'PATCH', body: JSON.stringify({ version: rejected.body.version, reportingStatus: 'Not a real status' }),
  }, adminToken);
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  assert.ok(bad.body.error?.fields?.reportingStatus, 'the reporting field must be named');

  await pool.query('DELETE FROM trfs WHERE id = $1', [id]);
});

maybe('the list payload contains Test Requested and Test Details', async () => {
  const created = await createTrf({
    batchNumber: `LIST-TEST-${Date.now()}`,
    requestedAnalysis: 'Assay',
    specialInstructions: 'Keep cold',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const res = await api<TrfListPage>(
    `/api/trfs?pageSize=200`, {}, adminToken);
  assert.equal(res.status, 200);
  const found = res.body.items.find((t) => t.id === created.body.id);
  assert.ok(found, 'the TRF is in the list');
  assert.equal(found.requestedAnalysis, 'Assay', 'the list payload carries Test Requested');
  assert.equal(found.specialInstructions, 'Keep cold', 'the list payload carries Test Details');

  await pool.query('DELETE FROM trfs WHERE id = $1', [created.body.id]);
});

maybe('Completed needs an Analyst Name and a Date of Analysis', async () => {
  const created = await createTrf({ batchNumber: `COMPLETED-RULES-${Date.now()}` });
  assert.equal(created.status, 201);
  const id = created.body.id;

  // No analyst yet.
  const noAnalyst = await api(`/api/trfs/${id}`, {
    method: 'PATCH', body: JSON.stringify({ version: created.body.version, workflowStatus: 'Completed' }),
  }, adminToken);
  assert.equal(noAnalyst.status, 400, JSON.stringify(noAnalyst.body));
  assert.ok(noAnalyst.body.error?.fields?.ardAnalystId, 'the analyst field must be named');

  // Analyst, but no Date of Analysis.
  const analyst = await userInDepartment('Analyst', 'ARD');
  const withAnalyst = await api<TrfDetail>(`/api/trfs/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ version: created.body.version, ardAnalystId: analyst.id }),
  }, adminToken);
  assert.equal(withAnalyst.status, 200, JSON.stringify(withAnalyst.body));

  const noStart = await api(`/api/trfs/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ version: withAnalyst.body.version, workflowStatus: 'Completed' }),
  }, adminToken);
  assert.equal(noStart.status, 400, JSON.stringify(noStart.body));
  assert.ok(noStart.body.error?.fields?.analysisStartDate, 'the analysis start date field must be named');

  // Both present: the status is accepted.
  const done = await api<TrfDetail>(`/api/trfs/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      version: withAnalyst.body.version, analysisStartDate: today, workflowStatus: 'Completed',
    }),
  }, adminToken);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.workflowStatus, 'Completed');

  await pool.query('DELETE FROM trfs WHERE id = $1', [id]);
});

maybe('the TAT freezes when the Final Status is reached and counts on again when it is left', async () => {
  const created = await createTrf({ batchNumber: `TAT-${Date.now()}` });
  assert.equal(created.status, 201);
  const id = created.body.id;
  const analyst = await userInDepartment('Analyst', 'ARD');

  const start = daysAgo(30);
  const done = await api<TrfDetail>(`/api/trfs/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      version: created.body.version,
      ardAnalystId: analyst.id,
      analysisStartDate: start,
      workflowStatus: 'Completed',
    }),
  }, adminToken);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.tat, 30, 'the TAT counts the days from the Date of Analysis to today');

  // The finalized date is moved back: the TAT now stops there instead of
  // growing with the calendar.
  await pool.query(
    `UPDATE trfs SET finalized_at = now() - interval '10 days' WHERE id = $1`, [id]);
  const frozen = await api<TrfDetail>(`/api/trfs/${id}`, {}, adminToken);
  assert.equal(frozen.body.tat, 20, 'the TAT stops at the finalized date');

  // Leaving the terminal state clears the finalized date, so the TAT counts on.
  const reopened = await api<TrfDetail>(`/api/trfs/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ version: frozen.body.version, workflowStatus: 'In Progress' }),
  }, adminToken);
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  assert.equal(reopened.body.tat, 30, 'the TAT counts to today again once the status is open');

  const cleared = await pool.query<{ finalized_at: Date | null }>(
    `SELECT finalized_at FROM trfs WHERE id = $1`, [id]);
  assert.equal(cleared.rows[0].finalized_at, null, 'finalized_at is cleared when the status leaves Completed');

  await pool.query('DELETE FROM trfs WHERE id = $1', [id]);
});

maybe('every Final Status change is written to the ARD history', async () => {
  const created = await createTrf({ batchNumber: `HISTORY-${Date.now()}` });
  assert.equal(created.status, 201);
  const id = created.body.id;

  const moved = await api<TrfDetail>(`/api/trfs/${id}`, {
    method: 'PATCH', body: JSON.stringify({ version: created.body.version, workflowStatus: 'In Progress' }),
  }, adminToken);
  assert.equal(moved.status, 200, JSON.stringify(moved.body));

  const history = await api<{ items: { oldStatus: string | null; newStatus: string }[] }>(
    `/api/trfs/${id}/ard-history`, {}, adminToken);
  assert.equal(history.status, 200);
  assert.equal(history.body.items.length, 1, 'the change made through the form is recorded');
  assert.equal(history.body.items[0].oldStatus, 'Received');
  assert.equal(history.body.items[0].newStatus, 'In Progress');

  await pool.query('DELETE FROM trfs WHERE id = $1', [id]);
});

/* ------------------------------------------------------------------ */
/* Ownership                                                          */
/* ------------------------------------------------------------------ */

maybe('the ownership matrix: Formulation edits Part A, ARD edits the ARD block', async () => {
  const formulationViewer = await userInDepartment('Viewer', 'Formulation');
  const ardAnalyst = await userInDepartment('Analyst', 'ARD');
  const ardManager = await userInDepartment('Manager', 'ARD');
  const formulationApprover = await userInDepartment('Manager', 'Formulation');
  const admin = { token: adminToken };

  const created = await createTrf({ batchNumber: `OWNERSHIP-${Date.now()}` });
  assert.equal(created.status, 201);
  const id = created.body.id;
  // Every accepted edit bumps the version; a refused edit leaves it alone.
  let version = created.body.version;

  const partAEdit = async (token: string) => {
    const res = await api<TrfDetail>(`/api/trfs/${id}`, {
      method: 'PATCH', body: JSON.stringify({ version, batchNumber: `FORMULATION-${Date.now()}` }),
    }, token);
    if (res.status === 200) version = res.body.version;
    return res;
  };
  const ardEdit = async (token: string) => {
    const res = await api<TrfDetail>(`/api/trfs/${id}`, {
      method: 'PATCH', body: JSON.stringify({ version, reportingStatus: 'Draft' }),
    }, token);
    if (res.status === 200) version = res.body.version;
    return res;
  };

  // Formulation (a Viewer in the Formulation department) owns Part A.
  const formulationPartA = await partAEdit(formulationViewer.token);
  assert.equal(formulationPartA.status, 200, 'a Formulation user edits Part A');

  // ... and not the ARD block (409 because ARD block is locked until approval).
  const formulationArd = await ardEdit(formulationViewer.token);
  assert.equal(formulationArd.status, 409, 'a Formulation user does not edit the ARD block');

  // An ARD Analyst owns the ARD block ... (409 because ARD block is locked until approval)
  const ardArdEdit = await ardEdit(ardAnalyst.token);
  assert.equal(ardArdEdit.status, 409, 'an ARD user cannot edit the ARD block before approval');

  // ... and not Part A.
  const ardPartA = await partAEdit(ardAnalyst.token);
  assert.equal(ardPartA.status, 403, 'an ARD user does not edit Part A');

  // First, approve the TRF so the ARD block unlocks.
  const approve = await api<TrfDetail>(`/api/trfs/${id}`, {
    method: 'PATCH', body: JSON.stringify({ version: formulationPartA.body.version, remarksStatus: 'Approved' }),
  }, formulationApprover.token);
  assert.equal(approve.status, 200, 'Formulation Manager approves the TRF');
  version = approve.body.version;

  // A Manager may edit the ARD block (now that TRF is approved).
  const managerArd = await ardEdit(ardManager.token);
  assert.equal(managerArd.status, 200, 'a Manager edits the ARD block');
  version = managerArd.body.version;
  // But Part A is locked after approval for non-Admins.
  const managerPartA = await partAEdit(ardManager.token);
  assert.equal(managerPartA.status, 409, 'a Manager cannot edit Part A after approval');
  assert.equal(managerPartA.body.error?.code, 'PART_A_LOCKED');

  // An Admin may do both (Admin can bypass Part A lock).
  const adminArd = await ardEdit(admin.token);
  assert.equal(adminArd.status, 200, 'an Admin edits the ARD block');
  version = adminArd.body.version;
  const adminPartA = await partAEdit(admin.token);
  assert.equal(adminPartA.status, 200, 'an Admin edits Part A');
  version = adminPartA.body.version;

  await pool.query('DELETE FROM trfs WHERE id = $1', [id]);
});

maybe('an ARD Analyst can set the Final Status without the trf.changeStatus permission', async () => {
  const ardAnalyst = await userInDepartment('Analyst', 'ARD');
  const formulationApprover = await userInDepartment('Manager', 'Formulation');
  const created = await createTrf({ batchNumber: `FINAL-STATUS-${Date.now()}` });
  assert.equal(created.status, 201);
  const id = created.body.id;

  // First, approve the TRF so the ARD block unlocks.
  const approve = await api<TrfDetail>(`/api/trfs/${id}`, {
    method: 'PATCH', body: JSON.stringify({ version: created.body.version, remarksStatus: 'Approved' }),
  }, formulationApprover.token);
  assert.equal(approve.status, 200, JSON.stringify(approve.body));

  // The ard-status route must not ask for trf.changeStatus.
  const viaRoute = await api<TrfDetail>(`/api/trfs/${id}/ard-status`, {
    method: 'POST', body: JSON.stringify({ status: 'In Progress', version: approve.body.version }),
  }, ardAnalyst.token);
  assert.equal(viaRoute.status, 200, JSON.stringify(viaRoute.body));
  assert.equal(viaRoute.body.workflowStatus, 'In Progress');

  // And the same through the ordinary edit.
  const viaPatch = await api<TrfDetail>(`/api/trfs/${id}`, {
    method: 'PATCH', body: JSON.stringify({ version: viaRoute.body.version, workflowStatus: 'Cancelled' }),
  }, ardAnalyst.token);
  assert.equal(viaPatch.status, 200, JSON.stringify(viaPatch.body));
  assert.equal(viaPatch.body.workflowStatus, 'Cancelled');

  // A Formulation user may not.
  const formulation = await userInDepartment('Analyst', 'Formulation');
  const refused = await api(`/api/trfs/${id}/ard-status`, {
    method: 'POST', body: JSON.stringify({ status: 'Received', version: viaPatch.body.version }),
  }, formulation.token);
  assert.equal(refused.status, 403, 'a Formulation user does not drive the ARD workflow');

  await pool.query('DELETE FROM trfs WHERE id = $1', [id]);
});

maybe('the ARD number is generated once and never changes', async () => {
  const created = await createTrf({ batchNumber: `ARD-NO-${Date.now()}` });
  assert.equal(created.status, 201);
  assert.match(created.body.ardNumber ?? '', /^ARD-\d{4}-\d{5}$/);

  // It is not writable: the field is not in the editable list, so the request
  // carries nothing that may be saved.
  const res = await api(`/api/trfs/${created.body.id}`, {
    method: 'PATCH', body: JSON.stringify({ version: created.body.version, ardNumber: 'ARD-1999-00001' }),
  }, adminToken);
  assert.equal(res.status, 400, 'the A.R. number is not editable');

  const after = await api<TrfDetail>(`/api/trfs/${created.body.id}`, {}, adminToken);
  assert.equal(after.body.ardNumber, created.body.ardNumber, 'the A.R. number never changes');

  await pool.query('DELETE FROM trfs WHERE id = $1', [created.body.id]);
});
