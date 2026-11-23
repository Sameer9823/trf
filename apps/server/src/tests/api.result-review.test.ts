import { strict as assert } from 'node:assert';
import { after, before, test, TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { ArdTestAssignment, TrfDetail } from '@trf/shared';
import { buildApp } from '../app';
import { pool, isDatabaseReachable } from '../db';
import { runMigrations } from '../migrate';
import { hashPassword } from '../lib/password';

/**
 * The test-result flow: the assigned employee submits a result, an AGM approves or rejects it, and once every
 * test on the TRF is approved the AGM completes (locks) the TRF.
 */
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

async function api<T = any>(path: string, init: RequestInit = {}, token?: string) {
  const res = await fetch(baseUrl + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}
const post = (path: string, body: unknown, token?: string) => api(path, { method: 'POST', body: JSON.stringify(body) }, token);
const patch = (path: string, body: unknown, token?: string) => api(path, { method: 'PATCH', body: JSON.stringify(body) }, token);

const SUFFIX = Math.random().toString(36).slice(2, 7);
const PASSWORD = 'Result-Review-Pass-42';
let agmToken = '';
let agmId = 0;
let analystToken = '';
let analystId = 0;
let otherToken = '';
let customerId = 0;
let productId = 0;
let optionIds: number[] = [];
let dosageOptId = 0;
const trfIds: number[] = [];

async function seedEmployee(code: string, username: string, role: string, designation: string) {
  const row = await pool.query<{ id: number }>(
    `INSERT INTO employees (employee_code, full_name, email, username, password_hash, role, designation)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = TRUE, role = EXCLUDED.role,
       designation = EXCLUDED.designation, failed_login_count = 0, locked_until = NULL
     RETURNING id`,
    [code, `Review ${username}`, `${username}@test.local`, username, await hashPassword(PASSWORD), role, designation]);
  const signedIn = await post('/api/auth/login', { username, password: PASSWORD });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  return { id: row.rows[0].id, token: signedIn.body.accessToken as string };
}

before(async () => {
  if (!(await dbReachable)) return;
  const agm = await seedEmployee(`RR-AGM-${SUFFIX}`, 'rragm', 'Admin', 'AGM');
  agmToken = agm.token; agmId = agm.id;
  const analyst = await seedEmployee(`RR-ANA-${SUFFIX}`, 'rranalyst', 'Analyst', 'Junior Analyst');
  analystToken = analyst.token; analystId = analyst.id;
  const other = await seedEmployee(`RR-OTH-${SUFFIX}`, 'rrother', 'Analyst', 'Junior Analyst');
  otherToken = other.token;

  const c = await pool.query<{ id: number }>(`INSERT INTO customers (name, code) VALUES ('RR Customer', 'RR-FIXTURE') ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`);
  const p = await pool.query<{ id: number }>(`INSERT INTO products (name, code) VALUES ('RR Product', 'RRP-FIXTURE') ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`);
  customerId = c.rows[0].id; productId = p.rows[0].id;
  for (const name of ['RR Test A', 'RR Test B']) {
    await pool.query(`INSERT INTO test_requested_options (name, display_order) SELECT $1, 900 WHERE NOT EXISTS (SELECT 1 FROM test_requested_options WHERE name = $1)`, [name]);
  }
  optionIds = (await pool.query<{ id: number }>(`SELECT id FROM test_requested_options WHERE name IN ('RR Test A','RR Test B') ORDER BY name`)).rows.map((r) => r.id);
  if (!(await pool.query('SELECT 1 FROM dosage_form_options LIMIT 1')).rowCount) {
    await pool.query("INSERT INTO dosage_form_options (name, display_order) VALUES ('Tablet', 1)");
  }
  dosageOptId = (await pool.query<{ id: number }>('SELECT id FROM dosage_form_options ORDER BY id LIMIT 1')).rows[0].id;
});

after(async () => {
  if (!(await dbReachable)) return;
  for (const id of trfIds) await pool.query('DELETE FROM trfs WHERE id = $1', [id]).catch(() => undefined);
});

/** A TRF whose Formulation request is approved and that has one assignment per requested test, all given to the analyst. */
async function approvedTrfWithAssignments(tests: number) {
  const created = await post('/api/trfs', {
    trfDate: new Date().toISOString().slice(0, 10), customerId, productId, priority: 'Normal',
    batchNumber: `RR-${SUFFIX}-${Math.random().toString(36).slice(2, 6)}`,
    testRequestedOptionIds: optionIds.slice(0, tests), dosageFormOptionIds: [dosageOptId],
  }, agmToken);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const trf = created.body as TrfDetail;
  trfIds.push(trf.id);
  const approved = await post(`/api/trfs/${trf.id}/decision`, { track: 'FORMULATION', decision: 'Approved', version: trf.version }, agmToken);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const assignments: ArdTestAssignment[] = [];
  for (const optionId of optionIds.slice(0, tests)) {
    const res = await post('/api/ard-assignments', {
      trfId: trf.id, testRequestedOptionId: optionId, testName: `RR Test ${optionId}`, analystIds: [analystId],
    }, agmToken);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assignments.push({ id: Number(res.body.assignmentId), version: res.body.version } as ArdTestAssignment);
  }
  return { trfId: trf.id, assignments };
}

const goodResult = (version: number) => ({
  version, resultValue: '99.5', unit: '%', methodUsed: 'HPLC', specification: '98.0 - 102.0', lowerLimit: '98', upperLimit: '102',
  outcome: 'Pass', remarks: 'Within specification',
});

async function assignmentOf(trfId: number, assignmentId: number) {
  const list = await api<{ items: ArdTestAssignment[] }>(`/api/ard-assignments/trfs/${trfId}`, {}, agmToken);
  const found = list.body.items.find((a) => a.id === assignmentId);
  assert.ok(found, 'the assignment is listed');
  return found!;
}
async function trfOf(trfId: number) {
  return (await api<TrfDetail>(`/api/trfs/${trfId}`, {}, agmToken)).body;
}

maybe('the assigned employee submits a result and it waits for AGM review', async () => {
  const { trfId, assignments } = await approvedTrfWithAssignments(1);
  const a = assignments[0];

  const res = await post(`/api/ard-assignments/${a.id}/result`, goodResult(a.version), analystToken);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.reviewStatus, 'Submitted');
  assert.equal(res.body.status, 'In Progress', 'the test is not complete until the AGM approves it');
  assert.equal(res.body.resultValue, '99.5');
  assert.equal(res.body.outcome, 'Pass');
  assert.equal(res.body.enteredByName, 'Review rranalyst');

  const note = await pool.query(`SELECT 1 FROM notifications WHERE recipient_employee_id = $1 AND type = 'result_review_needed' AND related_trf_id = $2`, [agmId, trfId]);
  assert.equal(note.rowCount, 1, 'the AGM is told a result is waiting');

  const audit = await pool.query(`SELECT user_name FROM audit_logs WHERE action = 'ard_assignment.result_submitted' AND record_ref = (SELECT trf_number FROM trfs WHERE id = $1)`, [trfId]);
  assert.equal(audit.rowCount, 1);

  // It is not accepted twice while it waits, and the TRF is not yet in front of the AGM.
  const again = await post(`/api/ard-assignments/${a.id}/result`, goodResult(res.body.version), analystToken);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'RESULT_AWAITING_REVIEW');
  assert.equal((await trfOf(trfId)).finalApprovalStatus, 'None');
});

maybe('only the assigned employee can submit; invalid results are refused', async () => {
  const { assignments } = await approvedTrfWithAssignments(1);
  const a = assignments[0];

  const stranger = await post(`/api/ard-assignments/${a.id}/result`, goodResult(a.version), otherToken);
  assert.equal(stranger.status, 403, 'an employee the test is not assigned to cannot submit it');

  const empty = await post(`/api/ard-assignments/${a.id}/result`, { version: a.version, outcome: 'Pass' }, analystToken);
  assert.equal(empty.status, 400, 'a result needs a value or text');

  const badDates = await post(`/api/ard-assignments/${a.id}/result`,
    { ...goodResult(a.version), analysisStartDate: '2026-10-10', completionDate: '2026-10-01' }, analystToken);
  assert.equal(badDates.status, 400);

  const stale = await post(`/api/ard-assignments/${a.id}/result`, goodResult(a.version + 7), analystToken);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'VERSION_CONFLICT');
});

maybe('nobody submits on someone else behalf: a non-assigned Admin/Manager gets 403', async () => {
  const { assignments } = await approvedTrfWithAssignments(1);
  const a = assignments[0];

  // The AGM (Admin role) is not on the assignment's analyst list.
  const asAdmin = await post(`/api/ard-assignments/${a.id}/result`, goodResult(a.version), agmToken);
  assert.equal(asAdmin.status, 403, 'even an Admin cannot submit on someone else behalf');
});

maybe('results cannot be submitted before the Formulation request is approved', async () => {
  const created = await post('/api/trfs', {
    trfDate: new Date().toISOString().slice(0, 10), customerId, productId, priority: 'Normal',
    batchNumber: `RR-${SUFFIX}-pre`, testRequestedOptionIds: [optionIds[0]], dosageFormOptionIds: [dosageOptId],
  }, agmToken);
  trfIds.push(created.body.id);
  // The assignment screens only open once approved, so create the assignment directly.
  const row = await pool.query<{ id: number; version: number }>(
    `INSERT INTO ard_test_assignments (trf_id, test_requested_option_id, test_name, status, assigned_by, version)
     VALUES ($1, $2, 'RR Test', 'Assigned', $3, 1) RETURNING id, version`, [created.body.id, optionIds[0], agmId]);
  await pool.query(`INSERT INTO ard_test_assignment_analysts (assignment_id, analyst_id, assigned_by) VALUES ($1, $2, $3)`, [row.rows[0].id, analystId, agmId]);
  const res = await post(`/api/ard-assignments/${row.rows[0].id}/result`, goodResult(row.rows[0].version), analystToken);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'FORMULATION_NOT_APPROVED');
});

maybe('a test cannot be marked completed without an approved result', async () => {
  const { assignments } = await approvedTrfWithAssignments(1);
  const a = assignments[0];
  const direct = await patch(`/api/ard-assignments/${a.id}/status`, { status: 'Completed', version: a.version }, analystToken);
  assert.equal(direct.status, 409);
  assert.equal(direct.body.error.code, 'RESULT_NOT_APPROVED');
});

maybe('an AGM rejects a result with a reason, the employee corrects it, the AGM approves, then completes the TRF', async () => {
  const { trfId, assignments } = await approvedTrfWithAssignments(1);
  const a = assignments[0];

  const submitted = await post(`/api/ard-assignments/${a.id}/result`, goodResult(a.version), analystToken);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));

  // The employee cannot review their own result, and the AGM must give a reason to reject.
  const selfReview = await post(`/api/ard-assignments/${a.id}/result/review`, { version: submitted.body.version, decision: 'Approved' }, analystToken);
  assert.equal(selfReview.status, 403);
  const noReason = await post(`/api/ard-assignments/${a.id}/result/review`, { version: submitted.body.version, decision: 'Rejected', reason: 'bad' }, agmToken);
  assert.equal(noReason.status, 400);

  const rejected = await post(`/api/ard-assignments/${a.id}/result/review`,
    { version: submitted.body.version, decision: 'Rejected', reason: 'Chromatogram attached is for another batch' }, agmToken);
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  assert.equal(rejected.body.assignment.reviewStatus, 'Rejected');
  assert.equal(rejected.body.assignment.status, 'Re-test Required');
  assert.equal(rejected.body.assignment.reviewReason, 'Chromatogram attached is for another batch');
  assert.equal(rejected.body.readyForCompletion, false);
  const told = await pool.query(`SELECT body FROM notifications WHERE recipient_employee_id = $1 AND type = 'result_rejected' AND related_trf_id = $2`, [analystId, trfId]);
  assert.equal(told.rowCount, 1);
  assert.match(told.rows[0].body, /another batch/);
  assert.equal((await trfOf(trfId)).finalApprovalStatus, 'None');

  // A rejected result cannot be reviewed again, and it cannot be approved by mistake.
  const twice = await post(`/api/ard-assignments/${a.id}/result/review`, { version: rejected.body.assignment.version, decision: 'Approved' }, agmToken);
  assert.equal(twice.status, 409);
  assert.equal(twice.body.error.code, 'RESULT_NOT_AWAITING_REVIEW');

  // The employee corrects it and submits again.
  const resubmitted = await post(`/api/ard-assignments/${a.id}/result`,
    { ...goodResult(rejected.body.assignment.version), resultValue: '99.8', remarks: 'Re-run on the right batch' }, analystToken);
  assert.equal(resubmitted.status, 200, JSON.stringify(resubmitted.body));
  assert.equal(resubmitted.body.reviewStatus, 'Submitted');
  assert.equal(resubmitted.body.resultValue, '99.8');
  assert.equal(resubmitted.body.reviewReason, null, 'the old rejection no longer applies');

  const approved = await post(`/api/ard-assignments/${a.id}/result/review`, { version: resubmitted.body.version, decision: 'Approved' }, agmToken);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.assignment.reviewStatus, 'Approved');
  assert.equal(approved.body.assignment.status, 'Completed');
  assert.equal(approved.body.assignment.reviewedByName, 'Review rragm');
  assert.equal(approved.body.readyForCompletion, true);

  // With every test approved the TRF is waiting for the AGM to complete it.
  const waiting = await trfOf(trfId);
  assert.equal(waiting.finalApprovalStatus, 'Pending');
  assert.equal(waiting.workflowStatus, 'Completed');
  assert.ok(waiting.ardSubmittedAt);
  const ready = await pool.query(`SELECT 1 FROM notifications WHERE recipient_employee_id = $1 AND type = 'final_approval_needed' AND related_trf_id = $2`, [agmId, trfId]);
  assert.equal(ready.rowCount, 1);

  // The AGM completes the TRF: it is approved and locked.
  const done = await post(`/api/trfs/${trfId}/agm-complete`, { decision: 'Approved', version: waiting.version }, agmToken);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.finalApprovalStatus, 'Approved');
  assert.ok(done.body.lockedAt);
  assert.equal(done.body.completedByAgmName, 'Review rragm');

  // The history keeps the whole trail.
  const history = await pool.query<{ action: string }>(`SELECT action FROM ard_test_assignment_history WHERE assignment_id = $1 ORDER BY id`, [a.id]);
  const actions = history.rows.map((r) => r.action).filter((x) => x.startsWith('RESULT_'));
  assert.deepEqual(actions, ['RESULT_ENTERED', 'RESULT_REJECTED', 'RESULT_CHANGED', 'RESULT_APPROVED']);

  // Once locked, nothing more can be submitted or reviewed.
  const late = await post(`/api/ard-assignments/${a.id}/result`, goodResult(approved.body.assignment.version), analystToken);
  assert.equal(late.status, 409);
});

maybe('the TRF reaches the AGM only after every test result is approved', async () => {
  const { trfId, assignments } = await approvedTrfWithAssignments(2);
  const [first, second] = assignments;

  const s1 = await post(`/api/ard-assignments/${first.id}/result`, goodResult(first.version), analystToken);
  const s2 = await post(`/api/ard-assignments/${second.id}/result`, goodResult(second.version), analystToken);
  assert.equal(s1.status, 200); assert.equal(s2.status, 200);

  const r1 = await post(`/api/ard-assignments/${first.id}/result/review`, { version: s1.body.version, decision: 'Approved' }, agmToken);
  assert.equal(r1.body.readyForCompletion, false, 'one test is still waiting');
  assert.equal((await trfOf(trfId)).finalApprovalStatus, 'None');

  // A manual submit to the AGM is refused while a result is unapproved.
  const early = await post(`/api/trfs/${trfId}/ard-submit`, { version: (await trfOf(trfId)).version }, agmToken);
  assert.equal(early.status, 409);

  const r2 = await post(`/api/ard-assignments/${second.id}/result/review`, { version: s2.body.version, decision: 'Approved' }, agmToken);
  assert.equal(r2.body.readyForCompletion, true);
  assert.equal((await trfOf(trfId)).finalApprovalStatus, 'Pending');
});

maybe('the AGM review queue lists submitted results and is for AGMs only', async () => {
  const { trfId, assignments } = await approvedTrfWithAssignments(1);
  const a = assignments[0];
  const submitted = await post(`/api/ard-assignments/${a.id}/result`, goodResult(a.version), analystToken);
  assert.equal(submitted.status, 200);

  const queue = await api<{ items: { assignmentId: number; trfId: number; submittedByName: string; assignmentVersion: number }[] }>('/api/ard-assignments/result-reviews', {}, agmToken);
  assert.equal(queue.status, 200, JSON.stringify(queue.body));
  const item = queue.body.items.find((i) => i.assignmentId === a.id);
  assert.ok(item, 'the submitted result is in the queue');
  assert.equal(item!.trfId, trfId);
  assert.equal(item!.submittedByName, 'Review rranalyst');
  assert.equal(item!.assignmentVersion, submitted.body.version);

  assert.equal((await api('/api/ard-assignments/result-reviews', {}, analystToken)).status, 403);

  await post(`/api/ard-assignments/${a.id}/result/review`, { version: submitted.body.version, decision: 'Approved' }, agmToken);
  const after = await api<{ items: { assignmentId: number }[] }>('/api/ard-assignments/result-reviews', {}, agmToken);
  assert.ok(!after.body.items.some((i) => i.assignmentId === a.id), 'a reviewed result leaves the queue');
});

maybe('the employee dashboard shows each result and its review', async () => {
  const { assignments } = await approvedTrfWithAssignments(1);
  const a = assignments[0];
  const submitted = await post(`/api/ard-assignments/${a.id}/result`, goodResult(a.version), analystToken);
  const dash = await api<{ items: any[] }>('/api/ard-assignments/employee-dashboard', {}, analystToken);
  const row = dash.body.items.find((i) => i.assignmentId === a.id);
  assert.ok(row);
  assert.equal(row.reviewStatus, 'Submitted');
  assert.equal(row.resultValue, '99.5');
  assert.equal(row.assignmentVersion, submitted.body.version);
});
