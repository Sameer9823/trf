import { strict as assert } from 'node:assert';
import { after, before, test, TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { TrfDetail, TrfListPage, StageOption } from '@trf/shared';
import { buildApp } from '../app';
import { pool, isDatabaseReachable } from '../db';
import { runMigrations } from '../migrate';
import { hashPassword } from '../lib/password';
import { assignAnalystToATest } from './fixtures';

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
      batchSize: null, dosageForm: null, dosageFormOther: null, manufacturingLocation: null,
      labelClaim: null, packSize: null, packType: null, storageCondition: null,
      storagePeriod: null, manufacturingDate: null, expiryDate: null,
      analysisPurpose: null, sampleGivenBy: null, signatureDate: null,
      remarksStatus: 'Pending', sampleReceivedBy: null,
      testRequestedOptionIds: [1],
      testRequestedOther: null,
      dosageFormOptionIds: [1],
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

  // No analyst assigned to a test yet.
  const noAnalyst = await api(`/api/trfs/${id}`, {
    method: 'PATCH', body: JSON.stringify({ version: created.body.version, workflowStatus: 'Completed' }),
  }, adminToken);
  assert.equal(noAnalyst.status, 400, JSON.stringify(noAnalyst.body));
  assert.ok(noAnalyst.body.error?.fields?.testAssignments, 'the test assignment field must be named');

  // An analyst assigned to a test, but no Date of Analysis.
  const analyst = await userInDepartment('Analyst', 'ARD');
  await assignAnalystToATest(id, analyst.id);
  const noStart = await api(`/api/trfs/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ version: created.body.version, workflowStatus: 'Completed' }),
  }, adminToken);
  assert.equal(noStart.status, 400, JSON.stringify(noStart.body));
  assert.ok(noStart.body.error?.fields?.analysisStartDate, 'the analysis start date field must be named');

  // Both present: the status is accepted.
  const done = await api<TrfDetail>(`/api/trfs/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      version: created.body.version, analysisStartDate: today, workflowStatus: 'Completed',
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
  await assignAnalystToATest(id, analyst.id);

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
  }, adminToken);
  assert.equal(approve.status, 200, 'an administrator approves the TRF');
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

maybe('team-wide editing: an ARD Analyst edits the ARD block of a TRF they do not own', async () => {
  const ardAnalyst = await userInDepartment('Analyst', 'ARD');
  const created = await createTrf({ batchNumber: `TEAMWIDE-${Date.now()}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;

  // The TRF is admin-created and not assigned to the analyst, so it is not in
  // their own list before approval.
  const list = await api<TrfListPage>('/api/trfs?pageSize=200', {}, ardAnalyst.token);
  assert.ok(!list.body.items.map((t) => t.id).includes(id), 'the TRF is not in the analyst own list');

  // Approve so the ARD block unlocks.
  const approve = await api<TrfDetail>(`/api/trfs/${id}`, {
    method: 'PATCH', body: JSON.stringify({ version: created.body.version, remarksStatus: 'Approved' }),
  }, adminToken);
  assert.equal(approve.status, 200, JSON.stringify(approve.body));

  // Department-based (team-wide) editing is intended: an ARD Analyst edits the
  // ARD block of a TRF they do not own, so the edit route is not blocked by a
  // visibility check (it would be a 403, not the 200 asserted here).
  const edit = await api<TrfDetail>(`/api/trfs/${id}`, {
    method: 'PATCH', body: JSON.stringify({ version: approve.body.version, reportingStatus: 'Draft' }),
  }, ardAnalyst.token);
  assert.equal(edit.status, 200, JSON.stringify(edit.body));

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
  }, adminToken);
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

/* ---------------------------------------------------------------------------
 * Reassigning the ARD analyst (absent / unavailable), single and bulk.
 * ------------------------------------------------------------------------- */

async function userAgm(): Promise<{ token: string; id: number; fullName: string }> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const password = 'Trf-Ard-User-42';
  const username = `trfardagm${suffix}`;
  const fullName = `TRF ARD AGM ${suffix}`;
  await pool.query(
    `INSERT INTO employees (employee_code, full_name, email, username, password_hash, role, designation)
     VALUES ($1, $2, $3, $4, $5, 'Admin', 'AGM')`,
    [`TRF-AGM-${suffix}`, fullName, `${username}@test.local`, username, await hashPassword(password)],
  );
  const res = await api<{ accessToken: string }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  const found = await pool.query<{ id: number }>(`SELECT id FROM employees WHERE username = $1`, [username]);
  return { token: res.body.accessToken, id: found.rows[0].id, fullName };
}

async function assignTest(trfId: number, analystIds: number[], testOptionId = 1, token = adminToken) {
  return api<{ assignmentId: number; version: number }>('/api/ard-assignments', {
    method: 'POST',
    body: JSON.stringify({ trfId, testRequestedOptionId: testOptionId, testName: 'Assay', analystIds }),
  }, token);
}

maybe('an AGM reassigns a test with a reason and the TRF list follows the new analyst', async () => {
  const agm = await userAgm();
  const oldA = await userInDepartment('Analyst', 'ARD');
  const newA = await userInDepartment('Analyst', 'ARD');
  const trf = await createTrf({ batchNumber: `REASSIGN-${Date.now()}` });
  const trfId = trf.body.id;
  const created = await assignTest(trfId, [oldA.id]);
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const patch = await api<{ analystIds: number[] }>(`/api/ard-assignments/${created.body.assignmentId}`, {
    method: 'PATCH', body: JSON.stringify({ version: created.body.version, analystIds: [newA.id], reason: 'Absent' }),
  }, agm.token);
  assert.equal(patch.status, 200, JSON.stringify(patch.body));
  assert.deepEqual(patch.body.analystIds, [newA.id]);

  // The list "Analyst Name" is derived from the per-test analysts, so it follows.
  const list = await api<TrfListPage>(`/api/trfs?search=${encodeURIComponent(trf.body.trfNumber)}`, {}, adminToken);
  const item = list.body.items.find((t) => t.trfNumber === trf.body.trfNumber);
  assert.ok(item, 'the TRF is in the list');
  assert.ok((item!.assignedAnalystNames ?? '').includes(newA.fullName), 'the list shows the new analyst');
  assert.ok(!(item!.assignedAnalystNames ?? '').includes(oldA.fullName), 'the old analyst is gone');

  await pool.query('DELETE FROM ard_test_assignments WHERE trf_id = $1', [trfId]);
  await pool.query('DELETE FROM trfs WHERE id = $1', [trfId]);
});

maybe('an ARD analyst cannot reassign (403)', async () => {
  const analyst = await userInDepartment('Analyst', 'ARD');
  const other = await userInDepartment('Analyst', 'ARD');
  const trf = await createTrf({ batchNumber: `REASSIGN-403-${Date.now()}` });
  const created = await assignTest(trf.body.id, [analyst.id]);
  const patch = await api(`/api/ard-assignments/${created.body.assignmentId}`, {
    method: 'PATCH', body: JSON.stringify({ version: created.body.version, analystIds: [other.id], reason: 'Absent' }),
  }, analyst.token);
  assert.equal(patch.status, 403, 'an analyst may not reassign');
  await pool.query('DELETE FROM ard_test_assignments WHERE trf_id = $1', [trf.body.id]);
  await pool.query('DELETE FROM trfs WHERE id = $1', [trf.body.id]);
});

maybe('a reason is required when the analyst changes (400 with a field message)', async () => {
  const agm = await userAgm();
  const oldA = await userInDepartment('Analyst', 'ARD');
  const newA = await userInDepartment('Analyst', 'ARD');
  const trf = await createTrf({ batchNumber: `REASSIGN-NO-REASON-${Date.now()}` });
  const created = await assignTest(trf.body.id, [oldA.id]);
  const patch = await api<{ error: { fields?: Record<string, string> } }>(`/api/ard-assignments/${created.body.assignmentId}`, {
    method: 'PATCH', body: JSON.stringify({ version: created.body.version, analystIds: [newA.id] }),
  }, agm.token);
  assert.equal(patch.status, 400, 'a reason is required');
  assert.ok(patch.body.error.fields?.reason, 'the reason field carries the message');
  await pool.query('DELETE FROM ard_test_assignments WHERE trf_id = $1', [trf.body.id]);
  await pool.query('DELETE FROM trfs WHERE id = $1', [trf.body.id]);
});

maybe('picking the same analyst is a no-op (no history, still assigned)', async () => {
  const agm = await userAgm();
  const a = await userInDepartment('Analyst', 'ARD');
  const trf = await createTrf({ batchNumber: `REASSIGN-SAME-${Date.now()}` });
  const created = await assignTest(trf.body.id, [a.id]);
  const before = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ard_test_assignment_history WHERE assignment_id = $1 AND action = 'REASSIGNED'`, [created.body.assignmentId]);
  const patch = await api<{ analystIds: number[] }>(`/api/ard-assignments/${created.body.assignmentId}`, {
    method: 'PATCH', body: JSON.stringify({ version: created.body.version, analystIds: [a.id], reason: 'Absent' }),
  }, agm.token);
  assert.equal(patch.status, 200);
  assert.deepEqual(patch.body.analystIds, [a.id]);
  const after = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ard_test_assignment_history WHERE assignment_id = $1 AND action = 'REASSIGNED'`, [created.body.assignmentId]);
  assert.equal(after.rows[0].count, before.rows[0].count, 'no reassignment history was written');
  await pool.query('DELETE FROM ard_test_assignments WHERE trf_id = $1', [trf.body.id]);
  await pool.query('DELETE FROM trfs WHERE id = $1', [trf.body.id]);
});

maybe('bulk reassign is all-or-nothing and rolls back on a version conflict', async () => {
  const agm = await userAgm();
  const oldA = await userInDepartment('Analyst', 'ARD');
  const newA = await userInDepartment('Analyst', 'ARD');
  const opts = await pool.query<{ id: number }>(`SELECT id FROM test_requested_options ORDER BY id LIMIT 2`);
  const optA = opts.rows[0].id;
  const optB = opts.rows[1].id;
  const trf = await createTrf({ batchNumber: `REASSIGN-BULK-${Date.now()}`, testRequestedOptionIds: [optA, optB] });
  const t1 = await assignTest(trf.body.id, [oldA.id], optA);
  // A second test on the same TRF.
  const t2 = await api<{ assignmentId: number; version: number }>('/api/ard-assignments', {
    method: 'POST', body: JSON.stringify({ trfId: trf.body.id, testRequestedOptionId: optB, testName: 'Moisture', analystIds: [oldA.id] }),
  }, adminToken);
  assert.equal(t2.status, 201, JSON.stringify(t2.body));

  // Stale version on the second row forces a rollback of the whole batch.
  const bulk = await api(`/api/ard-assignments/reassign-bulk`, {
    method: 'POST',
    body: JSON.stringify({ reason: 'On leave', items: [
      { assignmentId: Number(t1.body.assignmentId), version: t1.body.version, analystIds: [newA.id] },
      { assignmentId: Number(t2.body.assignmentId), version: t2.body.version + 5, analystIds: [newA.id] },
    ] }),
  }, agm.token);
  assert.equal(bulk.status, 409, `a version conflict fails the batch: ${JSON.stringify(bulk.body)}`);

  // The first row must be unchanged (rolled back).
  const row1 = await pool.query<{ analyst_ids: number[] }>(
    `SELECT ARRAY(SELECT analyst_id FROM ard_test_assignment_analysts WHERE assignment_id = $1) AS analyst_ids`, [Number(t1.body.assignmentId)]);
  assert.deepEqual(row1.rows[0].analyst_ids, [oldA.id], 'the first row was rolled back');

  await pool.query('DELETE FROM ard_test_assignments WHERE trf_id = $1', [trf.body.id]);
  await pool.query('DELETE FROM trfs WHERE id = $1', [trf.body.id]);
});

maybe('the old analyst cannot submit a result after being reassigned', async () => {
  const agm = await userAgm();
  const oldA = await userInDepartment('Analyst', 'ARD');
  const newA = await userInDepartment('Analyst', 'ARD');
  const trf = await createTrf({ batchNumber: `REASSIGN-SUBMIT-${Date.now()}` });
  const created = await assignTest(trf.body.id, [oldA.id]);
  const patch = await api(`/api/ard-assignments/${created.body.assignmentId}`, {
    method: 'PATCH', body: JSON.stringify({ version: created.body.version, analystIds: [newA.id], reason: 'Absent' }),
  }, agm.token);
  assert.equal(patch.status, 200);

  const submit = await api(`/api/ard-assignments/${created.body.assignmentId}/result`, {
    method: 'POST',
    body: JSON.stringify({ version: patch.body.version, resultMode: 'text', resultValue: '1.0', outcome: 'Pass' }),
  }, oldA.token);
  assert.equal(submit.status, 403, 'the old analyst can no longer submit');

  await pool.query('DELETE FROM ard_test_assignments WHERE trf_id = $1', [trf.body.id]);
  await pool.query('DELETE FROM trfs WHERE id = $1', [trf.body.id]);
});

maybe('reassigning removes the TRF from the previous analyst and shows it to the new one', async () => {
  const agm = await userAgm();
  const oldA = await userInDepartment('Analyst', 'ARD');
  const newA = await userInDepartment('Analyst', 'ARD');
  const trf = await createTrf({ batchNumber: `REASSIGN-VIEW-${Date.now()}` });
  const trfId = trf.body.id;

  // The TRF is assigned to the old analyst, so it is in their list.
  const assign = await api<{ version: number }>(`/api/trfs/${trfId}/assign`, {
    method: 'POST', body: JSON.stringify({ assignedEmployeeId: oldA.id, version: trf.body.version }),
  }, adminToken);
  assert.equal(assign.status, 200, JSON.stringify(assign.body));
  const created = await assignTest(trfId, [oldA.id]);

  const before = await api<TrfListPage>(`/api/trfs?search=${encodeURIComponent(trf.body.trfNumber)}`, {}, oldA.token);
  assert.ok(before.body.items.some((t) => t.trfNumber === trf.body.trfNumber), 'the old analyst sees it before');

  // Reassign to the new analyst with a reason.
  const patch = await api(`/api/ard-assignments/${created.body.assignmentId}`, {
    method: 'PATCH', body: JSON.stringify({ version: created.body.version, analystIds: [newA.id], reason: 'Absent' }),
  }, agm.token);
  assert.equal(patch.status, 200, JSON.stringify(patch.body));

  // The old analyst no longer sees it; the new analyst does.
  const afterOld = await api<TrfListPage>(`/api/trfs?search=${encodeURIComponent(trf.body.trfNumber)}`, {}, oldA.token);
  assert.ok(!afterOld.body.items.some((t) => t.trfNumber === trf.body.trfNumber), 'the TRF left the old analyst\'s list');
  const afterNew = await api<TrfListPage>(`/api/trfs?search=${encodeURIComponent(trf.body.trfNumber)}`, {}, newA.token);
  assert.ok(afterNew.body.items.some((t) => t.trfNumber === trf.body.trfNumber), 'the new analyst sees it');

  await pool.query('DELETE FROM ard_test_assignments WHERE trf_id = $1', [trfId]);
  await pool.query('DELETE FROM trfs WHERE id = $1', [trfId]);
});

maybe('reassigning one of multiple analysts keeps the other and updates history and notifications correctly', async () => {
  const agm = await userAgm();
  const analystA = await userInDepartment('Analyst', 'ARD');
  const analystB = await userInDepartment('Analyst', 'ARD');
  const analystC = await userInDepartment('Analyst', 'ARD');
  const trf = await createTrf({ batchNumber: `REASSIGN-MULTI-${Date.now()}` });
  const trfId = trf.body.id;

  // Create assignment with two analysts A and B
  const created = await api<{ assignmentId: number; version: number }>('/api/ard-assignments', {
    method: 'POST',
    body: JSON.stringify({ trfId, testRequestedOptionId: 1, testName: 'Assay', analystIds: [analystA.id, analystB.id] }),
  }, adminToken);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const assignmentId = created.body.assignmentId;
  const initialVersion = created.body.version;

  // PATCH to replace B with C: analystIds [A, C]
  const patch = await api<{ analystIds: number[]; version: number }>(`/api/ard-assignments/${assignmentId}`, {
    method: 'PATCH',
    body: JSON.stringify({ version: initialVersion, analystIds: [analystA.id, analystC.id], reason: 'Absent' }),
  }, agm.token);
  assert.equal(patch.status, 200, JSON.stringify(patch.body));
  assert.deepEqual(patch.body.analystIds.sort((a: number, b: number) => a - b), [analystA.id, analystC.id].sort((a: number, b: number) => a - b));

  // Verify database: A and C assigned, B not
  const assigned = await pool.query<{ analyst_id: number }>(
    `SELECT analyst_id FROM ard_test_assignment_analysts WHERE assignment_id = $1 ORDER BY analyst_id`, [assignmentId]);
  assert.deepEqual(assigned.rows.map(r => r.analyst_id).sort((a: number, b: number) => a - b), [analystA.id, analystC.id].sort((a: number, b: number) => a - b));

  // History row has old_analyst_ids [A,B] and new_analyst_ids [A,C]
  const history = await pool.query<{ old_analyst_ids: number[]; new_analyst_ids: number[] }>(
    `SELECT old_analyst_ids, new_analyst_ids FROM ard_test_assignment_history WHERE assignment_id = $1 AND action = 'REASSIGNED' ORDER BY id DESC LIMIT 1`, [assignmentId]);
  assert.equal(history.rowCount, 1, 'one reassignment history row');
  assert.deepEqual(history.rows[0].old_analyst_ids.sort((a: number, b: number) => a - b), [analystA.id, analystB.id].sort((a: number, b: number) => a - b));
  assert.deepEqual(history.rows[0].new_analyst_ids.sort((a: number, b: number) => a - b), [analystA.id, analystC.id].sort((a: number, b: number) => a - b));

  // Notifications: only C (added) and B (removed) get notified, A gets none
  const notifications = await pool.query<{ recipient_employee_id: number; type: string }>(
    `SELECT recipient_employee_id, type FROM notifications WHERE recipient_employee_id IN ($1, $2, $3) AND type IN ('ARD_TEST_ASSIGNED', 'ARD_TEST_REASSIGNED') ORDER BY created_at DESC`, [analystA.id, analystB.id, analystC.id]);
  const notifiedTypes = new Map<number, string[]>();
  for (const n of notifications.rows) {
    if (!notifiedTypes.has(n.recipient_employee_id)) notifiedTypes.set(n.recipient_employee_id, []);
    notifiedTypes.get(n.recipient_employee_id)!.push(n.type);
  }
  assert.ok(!notifiedTypes.has(analystA.id) || notifiedTypes.get(analystA.id)!.length === 0, 'analyst A (unchanged) should not be notified');
  assert.ok(notifiedTypes.has(analystB.id) && notifiedTypes.get(analystB.id)!.includes('ARD_TEST_REASSIGNED'), 'analyst B (removed) should get REASSIGNED notification');
  assert.ok(notifiedTypes.has(analystC.id) && notifiedTypes.get(analystC.id)!.includes('ARD_TEST_ASSIGNED'), 'analyst C (added) should get ASSIGNED notification');

  await pool.query('DELETE FROM ard_test_assignments WHERE trf_id = $1', [trfId]);
  await pool.query('DELETE FROM trfs WHERE id = $1', [trfId]);
});

maybe('duplicate analystIds in PATCH are deduplicated: [B,B] on test with A -> [B], one history row, B notified once', async () => {
  const agm = await userAgm();
  const analystA = await userInDepartment('Analyst', 'ARD');
  const analystB = await userInDepartment('Analyst', 'ARD');
  const trf = await createTrf({ batchNumber: `DEDUP-PATCH-${Date.now()}` });
  const trfId = trf.body.id;

  // Create assignment with analyst A
  const created = await api<{ assignmentId: number; version: number }>('/api/ard-assignments', {
    method: 'POST',
    body: JSON.stringify({ trfId, testRequestedOptionId: 1, testName: 'Assay', analystIds: [analystA.id] }),
  }, adminToken);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const assignmentId = created.body.assignmentId;
  const initialVersion = created.body.version;

  // PATCH with duplicate analystIds [B, B]
  const patch = await api<{ analystIds: number[]; version: number }>(`/api/ard-assignments/${assignmentId}`, {
    method: 'PATCH',
    body: JSON.stringify({ version: initialVersion, analystIds: [analystB.id, analystB.id], reason: 'Absent' }),
  }, agm.token);
  assert.equal(patch.status, 200, JSON.stringify(patch.body));
  assert.deepEqual(patch.body.analystIds, [analystB.id]);

  // Database has only B assigned once
  const assigned = await pool.query<{ analyst_id: number }>(
    `SELECT analyst_id FROM ard_test_assignment_analysts WHERE assignment_id = $1 ORDER BY analyst_id`, [assignmentId]);
  assert.deepEqual(assigned.rows.map(r => r.analyst_id), [analystB.id]);

  // One history row for REASSIGNED
  const history = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ard_test_assignment_history WHERE assignment_id = $1 AND action = 'REASSIGNED'`, [assignmentId]);
  assert.equal(history.rows[0].count, '1', 'exactly one reassignment history row');

  // B notified once (ASSIGNED), A notified once (REASSIGNED)
  const notifications = await pool.query<{ recipient_employee_id: number; type: string }>(
    `SELECT recipient_employee_id, type FROM notifications WHERE recipient_employee_id IN ($1, $2) AND type IN ('ARD_TEST_ASSIGNED', 'ARD_TEST_REASSIGNED') ORDER BY created_at DESC`, [analystA.id, analystB.id]);
  const notifiedTypes = new Map<number, string[]>();
  for (const n of notifications.rows) {
    if (!notifiedTypes.has(n.recipient_employee_id)) notifiedTypes.set(n.recipient_employee_id, []);
    notifiedTypes.get(n.recipient_employee_id)!.push(n.type);
  }
  assert.ok(notifiedTypes.has(analystA.id) && notifiedTypes.get(analystA.id)!.includes('ARD_TEST_REASSIGNED'), 'analyst A (removed) should get REASSIGNED notification');
  assert.ok(notifiedTypes.has(analystB.id) && notifiedTypes.get(analystB.id)!.includes('ARD_TEST_ASSIGNED'), 'analyst B (added) should get ASSIGNED notification');
  // B should only have one notification
  const bNotifications = notifiedTypes.get(analystB.id) ?? [];
  assert.equal(bNotifications.filter(t => t === 'ARD_TEST_ASSIGNED').length, 1, 'analyst B should be notified exactly once');

  await pool.query('DELETE FROM ard_test_assignments WHERE trf_id = $1', [trfId]);
  await pool.query('DELETE FROM trfs WHERE id = $1', [trfId]);
});

maybe('duplicate analystIds in reassign-bulk are deduplicated', async () => {
  const agm = await userAgm();
  const analystA = await userInDepartment('Analyst', 'ARD');
  const analystB = await userInDepartment('Analyst', 'ARD');
  const trf = await createTrf({ batchNumber: `DEDUP-BULK-${Date.now()}` });
  const trfId = trf.body.id;

  const created = await api<{ assignmentId: number; version: number }>('/api/ard-assignments', {
    method: 'POST',
    body: JSON.stringify({ trfId, testRequestedOptionId: 1, testName: 'Assay', analystIds: [analystA.id] }),
  }, adminToken);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const assignmentId = created.body.assignmentId;
  const initialVersion = created.body.version;

  // POST /reassign-bulk with duplicate analystIds [B, B]
  const bulk = await api<{ items: { assignmentId: number; changed: boolean; version: number }[] }>('/api/ard-assignments/reassign-bulk', {
    method: 'POST',
    body: JSON.stringify({ reason: 'On leave', items: [{ assignmentId, version: initialVersion, analystIds: [analystB.id, analystB.id] }] }),
  }, agm.token);
  assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
  assert.equal(bulk.body.items[0].changed, true);

  // Database has only B assigned once
  const assigned = await pool.query<{ analyst_id: number }>(
    `SELECT analyst_id FROM ard_test_assignment_analysts WHERE assignment_id = $1 ORDER BY analyst_id`, [assignmentId]);
  assert.deepEqual(assigned.rows.map(r => r.analyst_id), [analystB.id]);

  // One history row
  const history = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ard_test_assignment_history WHERE assignment_id = $1 AND action = 'REASSIGNED'`, [assignmentId]);
  assert.equal(history.rows[0].count, '1', 'exactly one reassignment history row');

  await pool.query('DELETE FROM ard_test_assignments WHERE trf_id = $1', [trfId]);
  await pool.query('DELETE FROM trfs WHERE id = $1', [trfId]);
});

maybe('PATCH with exact current ids repeated [A,A] changes nothing (no history, version unchanged)', async () => {
  const agm = await userAgm();
  const analystA = await userInDepartment('Analyst', 'ARD');
  const trf = await createTrf({ batchNumber: `DEDUP-SAME-${Date.now()}` });
  const trfId = trf.body.id;

  const created = await api<{ assignmentId: number; version: number }>('/api/ard-assignments', {
    method: 'POST',
    body: JSON.stringify({ trfId, testRequestedOptionId: 1, testName: 'Assay', analystIds: [analystA.id] }),
  }, adminToken);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const assignmentId = created.body.assignmentId;
  const initialVersion = created.body.version;

  // PATCH with same analystIds [A, A] (duplicates of current)
  const patch = await api<{ analystIds: number[]; version: number }>(`/api/ard-assignments/${assignmentId}`, {
    method: 'PATCH',
    body: JSON.stringify({ version: initialVersion, analystIds: [analystA.id, analystA.id] }),
  }, agm.token);
  assert.equal(patch.status, 200, JSON.stringify(patch.body));
  assert.deepEqual(patch.body.analystIds, [analystA.id]);

  // Version should NOT increment (no change)
  const after = await pool.query<{ version: number }>(`SELECT version FROM ard_test_assignments WHERE id = $1`, [assignmentId]);
  assert.equal(after.rows[0].version, initialVersion, 'version must not change when analyst set is identical');

  // No REASSIGNED history row
  const history = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ard_test_assignment_history WHERE assignment_id = $1 AND action = 'REASSIGNED'`, [assignmentId]);
  assert.equal(history.rows[0].count, '0', 'no reassignment history when nothing changed');

  // No notifications
  const notifications = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM notifications WHERE recipient_employee_id = $1 AND type IN ('ARD_TEST_ASSIGNED', 'ARD_TEST_REASSIGNED')`, [analystA.id]);
  assert.equal(notifications.rows[0].count, '0', 'no notifications when nothing changed');

  await pool.query('DELETE FROM ard_test_assignments WHERE trf_id = $1', [trfId]);
  await pool.query('DELETE FROM trfs WHERE id = $1', [trfId]);
});

maybe('GET /:id/history reassignments only queries needed employee IDs and shows deactivated analyst names', async () => {
  const agm = await userAgm();
  const analystA = await userInDepartment('Analyst', 'ARD');
  const analystB = await userInDepartment('Analyst', 'ARD');
  const trf = await createTrf({ batchNumber: `HISTORY-EMP-${Date.now()}` });
  const trfId = trf.body.id;

  // Create assignment with analyst A
  const created = await api<{ assignmentId: number; version: number }>('/api/ard-assignments', {
    method: 'POST',
    body: JSON.stringify({ trfId, testRequestedOptionId: 1, testName: 'Assay', analystIds: [analystA.id] }),
  }, adminToken);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const assignmentId = created.body.assignmentId;
  const initialVersion = created.body.version;

  // Reassign from A to B
  const patch = await api<{ analystIds: number[]; version: number }>(`/api/ard-assignments/${assignmentId}`, {
    method: 'PATCH',
    body: JSON.stringify({ version: initialVersion, analystIds: [analystB.id], reason: 'Absent' }),
  }, agm.token);
  assert.equal(patch.status, 200, JSON.stringify(patch.body));

  // Deactivate analyst A (simulate employee leaving)
  await pool.query(`UPDATE employees SET is_active = FALSE WHERE id = $1`, [analystA.id]);

  // Call history endpoint - should not load all employees, only A and B
  const history = await api<{ items: any[]; reassignments: any[] }>(`/api/trfs/${trfId}/history`, {}, adminToken);
  assert.equal(history.status, 200, JSON.stringify(history.body));

  // The reassignment should show both names (A and B) even though A is deactivated
  const reassignment = history.body.reassignments.find((r) => r.testName === 'Assay');
  assert.ok(reassignment, 'reassignment entry must exist');
  // fromNames should contain analyst A's name (deactivated but still in employees table)
  assert.ok(reassignment.fromNames.includes(analystA.fullName), `fromNames should include deactivated analyst A: ${reassignment.fromNames}`);
  // toNames should contain analyst B's name
  assert.ok(reassignment.toNames.includes(analystB.fullName), `toNames should include analyst B: ${reassignment.toNames}`);

  // Reactivate A for cleanup
  await pool.query(`UPDATE employees SET is_active = TRUE WHERE id = $1`, [analystA.id]);

  await pool.query('DELETE FROM ard_test_assignments WHERE trf_id = $1', [trfId]);
  await pool.query('DELETE FROM trfs WHERE id = $1', [trfId]);
});
