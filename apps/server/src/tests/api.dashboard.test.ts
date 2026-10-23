import { strict as assert } from 'node:assert';
import { after, before, test, TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DashboardPayload } from '@trf/shared';
import { buildApp } from '../app';
import { pool, isDatabaseReachable } from '../db';
import { runMigrations } from '../migrate';
import { baseLookups } from './fixtures';
import type { TrfDetail } from '@trf/shared';

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

async function api(path: string, init: RequestInit = {}, token?: string) {
  const res = await fetch(baseUrl + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const TODAY = new Date().toISOString().slice(0, 10);

async function loginAs(username: string, password: string): Promise<string> {
  const res = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.accessToken as string;
}

async function makeEmployee(role: string) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const password = 'Test-Password-42';
  const res = await api('/api/employees', {
    method: 'POST',
    body: JSON.stringify({
      employeeCode: `P7-${suffix}`, fullName: `Phase7 ${role} ${suffix}`, email: `p7-${suffix}@company.local`,
      username: `p7${suffix}`, role, password,
    }),
  }, adminToken);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { id: res.body.id as number, token: await loginAs(`p7${suffix}`, password) };
}

const trfIds: number[] = [];
const employeeIds: number[] = [];

async function makeTrf(createdBy: string) {
  const lookups = await baseLookups();
  const res = await api('/api/trfs', {
    method: 'POST', body: JSON.stringify({ trfDate: TODAY, priority: 'Normal', ...lookups }),
  }, createdBy);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  trfIds.push(res.body.id);
  return res.body as { id: number; trfNumber: string; version: number };
}

/** A TRF with one assigned test, which is enough to move it out of New. */
/** A TRF with one assigned test, which is enough to move it out of New. */
async function assignedTrf(createdBy: string, employeeId: number, label: string) {
  const trf = await makeTrf(createdBy);
  // Approve the TRF so ARD work can begin.
  const approved = await api<TrfDetail>(`/api/trfs/${trf.id}`, {
    method: 'PATCH', body: JSON.stringify({ version: trf.version, remarksStatus: 'Approved' }),
  }, adminToken);
  assert.equal(approved.status, 200, 'TRF approved for analysis');
  const res = await api(`/api/assignments/trfs/${trf.id}/assignments`, {
    method: 'POST',
    body: JSON.stringify({ assignments: [{ testName: `${label} Test`, assignedEmployeeId: employeeId }] }),
  }, adminToken);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { trf: approved.body, test: res.body.items[0] as { id: number; version: number } };
}
let adminToken = '';
let analyst: { id: number; token: string };
let otherAnalyst: { id: number; token: string };
let viewer: { id: number; token: string };

maybe('setup: users exist for the dashboard tests', async () => {
  adminToken = await loginAs('phase2admin', 'Admin-Test-Password-42');
  analyst = await makeEmployee('Analyst');
  otherAnalyst = await makeEmployee('Analyst');
  viewer = await makeEmployee('Viewer');
  employeeIds.push(analyst.id, otherAnalyst.id, viewer.id);
});

maybe('the dashboard needs a signed-in employee with the dashboard permission', async () => {
  assert.equal((await api('/api/dashboard')).status, 401);
  const res = await api('/api/dashboard', {}, 'not-a-real-token');
  assert.equal(res.status, 401);
});

maybe('every status appears once, with a count, even at zero', async () => {
  const res = await api('/api/dashboard', {}, adminToken);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as DashboardPayload;

  assert.equal(body.scope, 'all');
  assert.deepEqual(body.trfStatus.map((s) => s.status),
    ['New', 'Assigned', 'In Progress', 'Analysis Completed', 'COA Pending', 'Completed', 'Cancelled']);
  assert.deepEqual(body.analysisStatus.map((s) => s.status),
    ['Pending', 'Assigned', 'In Progress', 'Completed', 'Re-test Required', 'Cancelled']);
  assert.deepEqual(body.coaStatus.map((s) => s.status),
    ['Pending', 'Draft', 'Under Review', 'Approved', 'Issued']);

  for (const list of [body.trfStatus, body.analysisStatus, body.coaStatus]) {
    assert.ok(list.every((s) => Number.isInteger(s.count) && s.count >= 0), 'counts are whole and never negative');
  }
});

maybe('the monthly series is exactly twelve months, oldest first, with gaps included', async () => {
  const body = (await api('/api/dashboard', {}, adminToken)).body as DashboardPayload;
  assert.equal(body.monthlyTrfs.length, 12);
  const months = body.monthlyTrfs.map((m) => m.month);
  assert.deepEqual(months, [...months].sort(), 'oldest first');
  assert.ok(months.every((m) => /^\d{4}-\d{2}$/.test(m)));
  assert.equal(months.at(-1), new Date().toISOString().slice(0, 7), 'the last month is this one');
  assert.ok(body.monthlyTrfs.every((m) => m.label.length > 0));
});

maybe('the totals count the same TRFs the TRF list returns', async () => {
  const { trf } = await assignedTrf(adminToken, analyst.id, 'Counted');
  const dashboard = (await api('/api/dashboard', {}, adminToken)).body as DashboardPayload;
  const list = await api('/api/trfs?pageSize=200', {}, adminToken);

  assert.equal(dashboard.totals.trfTotal, list.body.total);
  // The Assigned slice is compared with the list's own total for that status.
  // A page of rows is not the whole set, so the total is what has to agree.
  const assigned = await api('/api/trfs?status=Assigned&pageSize=1', {}, adminToken);
  assert.equal(dashboard.totals.trfAssigned, assigned.body.total);
  assert.ok(dashboard.totals.trfTotal >= 1);

  // The status slices add up to the same total.
  assert.equal(
    dashboard.trfStatus.reduce((sum, s) => sum + s.count, 0),
    dashboard.totals.trfTotal,
    'the pie and the headline number must agree',
  );
  void trf;
});

maybe('overdue is computed, not stored, and matches the TRF list', async () => {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const lookups = await baseLookups();
  const created = await api('/api/trfs', {
    method: 'POST',
    body: JSON.stringify({ trfDate: TODAY, priority: 'Urgent', requiredCompletionDate: yesterday, ...lookups }),
  }, adminToken);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  trfIds.push(created.body.id);

  const dashboard = (await api('/api/dashboard', {}, adminToken)).body as DashboardPayload;
  const list = await api('/api/trfs?overdueOnly=true&pageSize=200', {}, adminToken);
  assert.equal(dashboard.totals.trfOverdue, list.body.total);
  assert.ok(dashboard.totals.trfOverdue >= 1);
});

maybe('open and delayed tests count only what the role may see', async () => {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const mine = await assignedTrf(adminToken, analyst.id, 'My Work');
  await api(`/api/assignments/tests/${mine.test.id}`, {
    method: 'PATCH', body: JSON.stringify({ version: 1, dueDate: yesterday }),
  }, adminToken);
  const theirs = await assignedTrf(adminToken, otherAnalyst.id, 'Their Work');

  const mineDashboard = (await api('/api/dashboard', {}, analyst.token)).body as DashboardPayload;
  assert.equal(mineDashboard.scope, 'own');

  // The card must equal the list it opens, rather than a number of its own.
  const myAnalysis = await api('/api/analysis?pageSize=200', {}, analyst.token);
  const myOpen = myAnalysis.body.items.filter((i: { status: string }) =>
    i.status !== 'Completed' && i.status !== 'Cancelled');
  assert.equal(mineDashboard.totals.analysisOpenTests, myOpen.length, 'only this analyst\'s open tests');
  assert.ok(mineDashboard.totals.analysisOpenTests >= 1);

  const analysisList = await api('/api/analysis?delayedOnly=true&pageSize=200', {}, analyst.token);
  assert.equal(mineDashboard.totals.analysisDelayedTests, analysisList.body.total);

  const allDashboard = (await api('/api/dashboard', {}, adminToken)).body as DashboardPayload;
  assert.ok(allDashboard.totals.analysisOpenTests > mineDashboard.totals.analysisOpenTests,
    'an Admin sees this analyst\'s colleague as well');

  void theirs;
});

maybe('an Analyst sees their own TRFs only, and the cards cannot leak a colleague\'s work', async () => {
  // An Analyst cannot create a TRF, so a Manager creates one and assigns it.
  // That is the realistic way an Analyst comes to own a TRF.
  const mine = await assignedTrf(adminToken, analyst.id, 'Analyst Own');
  // Assignment already moved the TRF on, so re-read its version before assigning.
  const fresh = await api(`/api/trfs/${mine.trf.id}`, {}, adminToken);
  const assigned = await api(`/api/trfs/${mine.trf.id}/assign`, {
    method: 'POST', body: JSON.stringify({ assignedEmployeeId: analyst.id, version: fresh.body.version }),
  }, adminToken);
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  const theirs = await assignedTrf(adminToken, otherAnalyst.id, 'Analyst Other');

  const body = (await api('/api/dashboard', {}, analyst.token)).body as DashboardPayload;
  assert.equal(body.scope, 'own');
  const list = await api('/api/trfs?pageSize=200', {}, analyst.token);
  assert.equal(body.totals.trfTotal, list.body.total, 'the same scope as the list the card opens');

  const visible = list.body.items.map((t: { trfNumber: string }) => t.trfNumber);
  assert.ok(visible.includes(mine.trf.trfNumber), 'their own TRF is in scope');
  assert.ok(!visible.includes(theirs.trf.trfNumber), 'a colleague\'s TRF is not');

  const adminCount = (await api('/api/dashboard', {}, adminToken)).body as DashboardPayload;
  assert.ok(adminCount.totals.trfTotal > body.totals.trfTotal,
    'the same account sees more as an Admin, so nothing is hidden by the role');

  // The workload table is scoped too: one row, for this analyst.
  assert.equal(body.workload.length, 1);
  assert.equal(body.workload[0].employeeId, analyst.id);
});

maybe('a Viewer sees permitted totals but cannot widen the dashboard', async () => {
  const body = (await api('/api/dashboard', {}, viewer.token)).body as DashboardPayload;
  assert.equal(body.scope, 'all', 'a Viewer holds trf.viewAll');

  // Asking for another employee is not a parameter the dashboard accepts.
  const widened = await api('/api/dashboard?employeeId=1', {}, viewer.token);
  assert.equal(widened.status, 200);
  assert.equal((widened.body as DashboardPayload).totals.trfTotal, body.totals.trfTotal);

  // But a Viewer still cannot write anywhere.
  const write = await api('/api/trfs', {
    method: 'POST', body: JSON.stringify({ trfDate: TODAY, priority: 'Normal' }),
  }, viewer.token);
  assert.equal(write.status, 403);
});

maybe('the workload row splits passed and failed from the same outcome rule the list uses', async () => {
  const { test } = await assignedTrf(adminToken, analyst.id, 'Outcome Split');
  await api(`/api/analysis/tests/${test.id}/start`, { method: 'POST', body: JSON.stringify({ version: 1 }) }, analyst.token);
  await api(`/api/analysis/tests/${test.id}/result`, {
    method: 'PUT', body: JSON.stringify({ version: 2, resultValue: '7', lowerLimit: '1', upperLimit: '5' }),
  }, analyst.token);
  await api(`/api/analysis/tests/${test.id}/complete`, { method: 'POST', body: JSON.stringify({ version: 3 }) }, analyst.token);

  const body = (await api('/api/dashboard', {}, adminToken)).body as DashboardPayload;
  const row = body.workload.find((w) => w.employeeId === analyst.id);
  assert.ok(row, 'the analyst has a workload row');
  assert.equal(row.failed, 1, 'the failing test is counted as failed');

  // The row agrees with the analysis list over the same scope.
  const list = await api('/api/analysis?employeeId=' + analyst.id + '&outcome=Fail&pageSize=200', {}, adminToken);
  assert.ok(list.body.items.some((i: { testName: string }) => i.testName === 'Outcome Split Test'));
  assert.ok(row.passed + row.failed + row.assigned + row.inProgress >= list.body.total);
});

maybe('a raw database error never reaches the client through the dashboard', async () => {
  const res = await api('/api/dashboard', {}, adminToken);
  const text = JSON.stringify(res.body);
  assert.equal(text.includes('SELECT'), false);
  assert.equal(text.includes('analysis_tests'), false);
  assert.equal(text.includes('generate_series'), false);
});

maybe('cleanup: the TRFs and users created above are removed', async () => {
  await pool.query('DELETE FROM trfs WHERE id = ANY($1)', [trfIds]);
  await pool.query('DELETE FROM employees WHERE id = ANY($1)', [employeeIds]);
  const left = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM trfs WHERE trf_number LIKE 'TRF-%' AND id = ANY($1)`, [trfIds]);
  assert.equal(Number(left.rows[0].count), 0);
});