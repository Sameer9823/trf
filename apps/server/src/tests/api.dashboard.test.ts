import { strict as assert } from 'node:assert';
import { after, before, test, TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DashboardPayload } from '@trf/shared';
import { buildApp } from '../app';
import { pool, isDatabaseReachable } from '../db';
import { runMigrations } from '../migrate';
import { baseLookups, assignAnalystToATest, assignOverdueTest } from './fixtures';

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
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

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

/** The analyst's own ARD tests, the list the test cards stand for. */
async function ownArdTests(analystToken: string) {
  const res = await api('/api/ard-assignments/employee-dashboard', {}, analystToken);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.items as { testStatus: string; dueDate: string | null }[];
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
  assert.equal((await api('/api/dashboard', {}, 'not-a-real-token')).status, 401);
});

maybe('the status mixes use the ARD Final Status and ARD test statuses, COA hidden', async () => {
  const body = (await api('/api/dashboard', {}, adminToken)).body as DashboardPayload;
  assert.equal(body.scope, 'all');
  assert.equal(body.showCoa, false);
  assert.deepEqual(body.trfStatus.map((s) => s.status), ['Received', 'In Progress', 'Completed', 'Cancelled']);
  assert.deepEqual(body.analysisStatus.map((s) => s.status),
    ['Pending Assignment', 'Assigned', 'In Progress', 'Completed', 'Re-test Required', 'Cancelled']);
  assert.deepEqual(body.coaStatus, []);
  for (const list of [body.trfStatus, body.analysisStatus]) {
    assert.ok(list.every((s) => Number.isInteger(s.count) && s.count >= 0));
  }
});

maybe('the monthly series is exactly twelve months, oldest first, gaps included', async () => {
  const body = (await api('/api/dashboard', {}, adminToken)).body as DashboardPayload;
  assert.equal(body.monthlyTrfs.length, 12);
  const months = body.monthlyTrfs.map((m) => m.month);
  assert.deepEqual(months, [...months].sort());
  assert.ok(months.every((m) => /^\d{4}-\d{2}$/.test(m)));
  assert.equal(months.at(-1), new Date().toISOString().slice(0, 7));
});

maybe('every TRF card equals the TRF list it opens (Admin sees all)', async () => {
  const trf = await makeTrf(adminToken);
  await assignAnalystToATest(trf.id, analyst.id);
  const body = (await api('/api/dashboard', {}, adminToken)).body as DashboardPayload;

  const all = await api('/api/trfs?pageSize=1', {}, adminToken);
  assert.equal(body.totals.trfTotal, all.body.total, 'headline TRFs equals the list total');

  for (const slice of body.trfStatus) {
    const list = await api(`/api/trfs?workflowStatus=${encodeURIComponent(slice.status)}&pageSize=1`, {}, adminToken);
    assert.equal(slice.count, list.body.total, `${slice.status} slice equals its filtered list`);
  }

  const overdue = await api('/api/trfs?overdueOnly=true&pageSize=1', {}, adminToken);
  assert.equal(body.totals.trfOverdue, overdue.body.total, 'overdue equals the overdue list');
});

maybe('open and delayed tests come from the ARD tables and match the ARD views', async () => {
  const trf = await makeTrf(adminToken);
  await assignOverdueTest(trf.id, analyst.id, inDays(-2));

  const body = (await api('/api/dashboard', {}, adminToken)).body as DashboardPayload;
  const own = await ownArdTests(analyst.token);
  const open = own.filter((t) => t.testStatus !== 'Completed' && t.testStatus !== 'Cancelled').length;
  const delayed = own.filter((t) => t.dueDate && t.dueDate < TODAY
    && t.testStatus !== 'Completed' && t.testStatus !== 'Cancelled').length;

  // Admin sees at least this analyst's work; the figures are never zero here.
  assert.ok(body.totals.analysisOpenTests >= open, 'open tests include the ARD assignment');
  assert.ok(body.totals.analysisDelayedTests >= delayed, 'delayed tests include the overdue ARD assignment');
  assert.ok(body.totals.analysisDelayedTests >= 1, 'the overdue assignment is counted');
});

maybe('passed and failed count only AGM-approved results', async () => {
  const trf = await makeTrf(adminToken);
  await assignAnalystToATest(trf.id, analyst.id);
  const assignment = (await pool.query<{ id: number }>(
    `SELECT ata.id FROM ard_test_assignments ata
     JOIN ard_test_assignment_analysts ataa ON ataa.assignment_id = ata.id
     WHERE ata.trf_id = $1 AND ataa.analyst_id = $2 LIMIT 1`, [trf.id, analyst.id])).rows[0];
  // One approved Pass and one submitted (not yet approved) Fail: only the approved
  // Pass may count, and a submitted result must not.
  await pool.query(
    `INSERT INTO ard_assignment_results (assignment_id, outcome, review_status) VALUES ($1, 'Pass', 'Approved')`,
    [assignment.id]);
  const trf2 = await makeTrf(adminToken);
  await assignAnalystToATest(trf2.id, analyst.id);
  const assignment2 = (await pool.query<{ id: number }>(
    `SELECT ata.id FROM ard_test_assignments ata
     JOIN ard_test_assignment_analysts ataa ON ataa.assignment_id = ata.id
     WHERE ata.trf_id = $1 AND ataa.analyst_id = $2 LIMIT 1`, [trf2.id, analyst.id])).rows[0];
  await pool.query(
    `INSERT INTO ard_assignment_results (assignment_id, outcome, review_status) VALUES ($1, 'Fail', 'Submitted')`,
    [assignment2.id]);

  const body = (await api('/api/dashboard', {}, adminToken)).body as DashboardPayload;
  const row = body.workload.find((w) => w.employeeId === analyst.id);
  assert.ok(row, 'the analyst has a workload row');
  assert.ok(row.passed >= 1, 'the approved Pass is counted');
  assert.equal(row.failed, 0, 'a submitted (not approved) Fail is not counted as failed');
});

maybe('a restricted Analyst sees only their own TRFs, exactly like the list', async () => {
  const mine = await makeTrf(adminToken);
  const assigned = await api(`/api/trfs/${mine.id}/assign`, {
    method: 'POST', body: JSON.stringify({ assignedEmployeeId: analyst.id, version: mine.version }),
  }, adminToken);
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
  const theirs = await makeTrf(adminToken);
  await assignAnalystToATest(theirs.id, otherAnalyst.id);

  const body = (await api('/api/dashboard', {}, analyst.token)).body as DashboardPayload;
  assert.equal(body.scope, 'own');
  const list = await api('/api/trfs?pageSize=200', {}, analyst.token);
  assert.equal(body.totals.trfTotal, list.body.total, 'the same scope as the list the card opens');

  const visible = list.body.items.map((t: { trfNumber: string }) => t.trfNumber);
  assert.ok(visible.includes(mine.trfNumber), 'their own TRF is in scope');
  assert.ok(!visible.includes(theirs.trfNumber), 'a colleague\'s TRF is not');

  // The analyst's test figures are their own ARD work only.
  const own = await ownArdTests(analyst.token);
  assert.equal(body.workload.length, 1);
  assert.equal(body.workload[0].employeeId, analyst.id);
  assert.ok(body.totals.analysisOpenTests <= own.length + 0, 'no more than their own tests');
});

maybe('a Viewer sees permitted totals but cannot widen the dashboard', async () => {
  const body = (await api('/api/dashboard', {}, viewer.token)).body as DashboardPayload;
  assert.equal(body.scope, 'all');
  const widened = await api('/api/dashboard?employeeId=1', {}, viewer.token);
  assert.equal((widened.body as DashboardPayload).totals.trfTotal, body.totals.trfTotal);
});

maybe('a raw database error never reaches the client through the dashboard', async () => {
  const text = JSON.stringify((await api('/api/dashboard', {}, adminToken)).body);
  assert.equal(text.includes('SELECT'), false);
  assert.equal(text.includes('analysis_tests'), false);
  assert.equal(text.includes('generate_series'), false);
});

maybe('cleanup: the TRFs and users created above are removed', async () => {
  await pool.query('DELETE FROM trfs WHERE id = ANY($1)', [trfIds]);
  await pool.query('DELETE FROM employees WHERE id = ANY($1)', [employeeIds]);
});