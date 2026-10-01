import { strict as assert } from 'node:assert';
import { after, before, test, TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { MESSAGES } from '@trf/shared';
import { buildApp } from '../app';
import { pool, isDatabaseReachable } from '../db';
import { runMigrations } from '../migrate';
import { hashPassword } from '../lib/password';

const dbReachable = isDatabaseReachable().catch(() => false);
let server: Server;
let baseUrl = '';

/** Same rule as the Phase 2 tests: no database means skipped, never a false pass. */
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
      employeeCode: `P4-${suffix}`, fullName: `Phase4 ${role} ${suffix}`, email: `p4-${suffix}@company.local`,
      username: `p4${suffix}`, role, password,
    }),
  }, adminToken);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const token = await loginAs(`p4${suffix}`, password);
  return { id: res.body.id as number, token };
}

async function makeTrf(token: string, overrides: Record<string, unknown> = {}) {
  const res = await api('/api/trfs', {
    method: 'POST',
    body: JSON.stringify({ trfDate: TODAY, priority: 'Normal', ...overrides }),
  }, token);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as { id: number; trfNumber: string; status: string; version: number };
}

async function assign(trfId: number, items: unknown[], token = adminToken) {
  return api(`/api/assignments/trfs/${trfId}/assignments`, {
    method: 'POST', body: JSON.stringify({ assignments: items }),
  }, token);
}

/** Removes the rows a test created, TRF first so nothing is left dangling. */
async function cleanup(trfIds: number[], employeeIds: number[]) {
  if (trfIds.length) await pool.query('DELETE FROM trfs WHERE id = ANY($1)', [trfIds]);
  if (employeeIds.length) await pool.query('DELETE FROM employees WHERE id = ANY($1)', [employeeIds]);
}

let adminToken = '';
let analyst: { id: number; token: string };
let otherAnalyst: { id: number; token: string };
let viewer: { id: number; token: string };
let manager: { id: number; token: string };
let trfId = 0;
const toDelete: number[] = [];

maybe('setup: users and a TRF exist for the assignment tests', async () => {
  adminToken = await loginAs('phase2admin', 'Admin-Test-Password-42');
  analyst = await makeEmployee('Analyst');
  otherAnalyst = await makeEmployee('Analyst');
  viewer = await makeEmployee('Viewer');
  manager = await makeEmployee('Manager');
  const trf = await makeTrf(adminToken, { batchNumber: 'P4-BATCH-1', requiredCompletionDate: inDays(7) });
  trfId = trf.id;
  toDelete.push(trf.id);
  assert.equal(trf.status, 'New');
});

maybe('assigning several tests at once creates them all and moves the TRF to Assigned', async () => {
  const res = await assign(trfId, [
    { testName: 'Moisture Content', assignedEmployeeId: analyst.id, dueDate: inDays(3) },
    { testName: 'pH Value', assignedEmployeeId: otherAnalyst.id },
  ]);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.items.length, 2);
  assert.ok(res.body.items.every((i: { status: string }) => i.status === 'Assigned'));

  const trf = await api(`/api/trfs/${trfId}`, {}, adminToken);
  assert.equal(trf.body.status, 'Assigned', 'the TRF should follow the tests');
  const history = await api(`/api/trfs/${trfId}/history`, {}, adminToken);
  assert.ok(history.body.items.some((h: { newStatus: string }) => h.newStatus === 'Assigned'));
});

maybe('the same test cannot be assigned twice on one TRF', async () => {
  const res = await assign(trfId, [{ testName: 'moisture content', assignedEmployeeId: analyst.id }]);
  assert.equal(res.status, 409);
  assert.match(res.body.error.message, /already assigned/i);
});

maybe('the same test listed twice in one request is refused before anything is written', async () => {
  const trf = await makeTrf(adminToken);
  toDelete.push(trf.id);
  const res = await assign(trf.id, [
    { testName: 'Viscosity', assignedEmployeeId: analyst.id },
    { testName: 'Viscosity', assignedEmployeeId: otherAnalyst.id },
  ]);
  assert.equal(res.status, 409);
  const left = await api(`/api/assignments/trfs/${trf.id}`, {}, adminToken);
  assert.equal(left.body.items.length, 0, 'the refused request must leave no tests behind');
});

maybe('a batch where the last test fails leaves none of them assigned', async () => {
  const trf = await makeTrf(adminToken);
  toDelete.push(trf.id);
  const res = await assign(trf.id, [
    { testName: 'Particle Size', assignedEmployeeId: analyst.id },
    { testName: 'Density', assignedEmployeeId: 999_999 },
  ]);
  assert.equal(res.status, 400);
  const left = await api(`/api/assignments/trfs/${trf.id}`, {}, adminToken);
  assert.equal(left.body.items.length, 0, 'the whole batch must roll back');
  const check = await api(`/api/trfs/${trf.id}`, {}, adminToken);
  assert.equal(check.body.status, 'New', 'a rolled back batch must not move the TRF');
});

maybe('a Viewer or an inactive employee cannot be given a test', async () => {
  const trf = await makeTrf(adminToken);
  toDelete.push(trf.id);
  const asViewer = await assign(trf.id, [{ testName: 'Colour', assignedEmployeeId: viewer.id }]);
  assert.equal(asViewer.status, 400);
  assert.match(asViewer.body.error.message, /Viewer cannot be assigned/i);
  assert.ok(asViewer.body.error.fields.assignedEmployeeId);

  await api(`/api/employees/${otherAnalyst.id}/deactivate`, { method: 'POST' }, adminToken);
  const asInactive = await assign(trf.id, [{ testName: 'Colour', assignedEmployeeId: otherAnalyst.id }]);
  assert.equal(asInactive.status, 400);
  assert.match(asInactive.body.error.message, /not active/i);

  // Back to active so the later tests can still assign work to this person.
  await api(`/api/employees/${otherAnalyst.id}/activate`, { method: 'POST' }, adminToken);
  const left = await api(`/api/assignments/trfs/${trf.id}`, {}, adminToken);
  assert.equal(left.body.items.length, 0, 'neither refused attempt may leave a test behind');
});

maybe('an empty or malformed assignment body is refused with field messages', async () => {
  const empty = await assign(trfId, []);
  assert.equal(empty.status, 400);

  const bad = await assign(trfId, [{ testName: 'A', assignedEmployeeId: analyst.id, dueDate: '31/12/2026' }]);
  assert.equal(bad.status, 400);
  assert.ok(JSON.stringify(bad.body.error.fields).includes('dueDate'));
});

maybe('a Completed TRF cannot receive more assignments', async () => {
  const trf = await makeTrf(adminToken);
  toDelete.push(trf.id);
  // Walk the TRF to Completed through the real transition table.
  let version = trf.version;
  for (const status of ['Assigned', 'In Progress', 'Analysis Completed', 'COA Pending', 'Completed']) {
    const step = await api(`/api/trfs/${trf.id}/status`, {
      method: 'POST', body: JSON.stringify({ status, version }),
    }, adminToken);
    assert.equal(step.status, 200, `${status}: ${JSON.stringify(step.body)}`);
    version = step.body.version;
  }
  const res = await assign(trf.id, [{ testName: 'Late Test', assignedEmployeeId: analyst.id }]);
  assert.equal(res.status, 409);
  assert.match(res.body.error.message, /Completed/);
});

maybe('reassigning a test records the old and new employee in the audit trail', async () => {
  const trf = await makeTrf(adminToken);
  toDelete.push(trf.id);
  const created = await assign(trf.id, [{ testName: 'Ash Content', assignedEmployeeId: analyst.id }]);
  const id = created.body.items[0].id as number;

  const moved = await api(`/api/assignments/tests/${id}`, {
    method: 'PATCH', body: JSON.stringify({ version: 1, assignedEmployeeId: otherAnalyst.id, note: 'Analyst on leave' }),
  }, adminToken);
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.assignedEmployeeId, otherAnalyst.id);
  assert.equal(moved.body.version, 2);

  const rows = await pool.query<{ action: string }>(
    `SELECT action FROM audit_logs WHERE module = 'assignments' AND record_ref LIKE $1 ORDER BY id`,
    [`%Ash Content%`]);
  const actions = rows.rows.map((r) => r.action);
  assert.ok(actions.includes('assignment.reassigned'), `expected reassigned audit row, saw ${actions.join(', ')}`);
  assert.ok(actions.includes('assignment.note'));
});

maybe('a stale version on reassignment is refused with the standard conflict message', async () => {
  const trf = await makeTrf(adminToken);
  toDelete.push(trf.id);
  const created = await assign(trf.id, [{ testName: 'Bulk Density', assignedEmployeeId: analyst.id }]);
  const id = created.body.items[0].id as number;

  assert.equal((await api(`/api/assignments/tests/${id}`, {
    method: 'PATCH', body: JSON.stringify({ version: 1, dueDate: inDays(9) }),
  }, adminToken)).status, 200);

  const stale = await api(`/api/assignments/tests/${id}`, {
    method: 'PATCH', body: JSON.stringify({ version: 1, dueDate: inDays(10) }),
  }, adminToken);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.message, MESSAGES.CONFLICT);
});

maybe('changing a due date is written to the audit trail', async () => {
  const trf = await makeTrf(adminToken);
  toDelete.push(trf.id);
  const created = await assign(trf.id, [{ testName: 'Flash Point', assignedEmployeeId: analyst.id, dueDate: inDays(2) }]);
  const id = created.body.items[0].id as number;
  await api(`/api/assignments/tests/${id}`, {
    method: 'PATCH', body: JSON.stringify({ version: 1, dueDate: inDays(11) }),
  }, adminToken);
  const rows = await pool.query<{ action: string }>(
    `SELECT action FROM audit_logs WHERE module = 'assignments' AND record_ref LIKE $1`, ['%Flash Point%']);
  assert.ok(rows.rows.some((r) => r.action === 'assignment.due_date_changed'));
});

maybe('a due date in the past is reported as Delayed, and clearing it removes the flag', async () => {
  const trf = await makeTrf(adminToken);
  toDelete.push(trf.id);
  const created = await assign(trf.id, [
    { testName: 'Overdue Test', assignedEmployeeId: analyst.id, dueDate: '2020-01-01' },
    { testName: 'Future Test', assignedEmployeeId: analyst.id, dueDate: inDays(20) },
    { testName: 'No Due Date Test', assignedEmployeeId: analyst.id },
  ]);
  const [overdue] = created.body.items;

  const late = await api('/api/assignments?search=Overdue+Test', {}, adminToken);
  assert.equal(late.body.items[0].isDelayed, true);

  const soon = await api('/api/assignments?search=Future+Test', {}, adminToken);
  assert.equal(soon.body.items[0].isDelayed, false);

  const none = await api('/api/assignments?search=No+Due+Date+Test', {}, adminToken);
  assert.equal(none.body.items[0].isDelayed, false, 'a test with no due date can never be late');

  // The Delayed filter matches the same expression in SQL.
  const filter = await api('/api/assignments?status=Delayed&pageSize=200', {}, adminToken);
  assert.ok(filter.body.items.length > 0);
  assert.ok(filter.body.items.every((i: { isDelayed: boolean }) => i.isDelayed));

  // Moving the date into the future clears the computed flag, with no stored column to reset.
  const fixed = await api(`/api/assignments/tests/${overdue.id}`, {
    method: 'PATCH', body: JSON.stringify({ version: 1, dueDate: inDays(10) }),
  }, adminToken);
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  assert.equal(fixed.body.isDelayed, false);
});

maybe('an assignment cannot be edited once it is cancelled', async () => {
  const trf = await makeTrf(adminToken);
  toDelete.push(trf.id);
  const created = await assign(trf.id, [{ testName: 'Cancelled Test', assignedEmployeeId: analyst.id }]);
  const id = created.body.items[0].id as number;

  const cancelled = await api(`/api/assignments/tests/${id}/cancel`, {
    method: 'POST', body: JSON.stringify({ version: 1, note: 'Customer withdrew the sample' }),
  }, adminToken);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.status, 'Cancelled');

  const after = await api(`/api/assignments/tests/${id}`, {
    method: 'PATCH', body: JSON.stringify({ version: 2, assignedEmployeeId: otherAnalyst.id }),
  }, adminToken);
  assert.equal(after.status, 409);

  const rows = await pool.query<{ action: string }>(
    `SELECT action FROM audit_logs WHERE module = 'assignments' AND record_ref LIKE $1`, ['%Cancelled Test%']);
  assert.ok(rows.rows.some((r) => r.action === 'assignment.cancelled'));
});

maybe('an Analyst sees only their own work and cannot assign anything', async () => {
  const mine = await api('/api/assignments?pageSize=200', {}, analyst.token);
  assert.equal(mine.status, 200);
  assert.ok(mine.body.items.length > 0);
  assert.ok(mine.body.items.every((i: { assignedEmployeeId: number }) => i.assignedEmployeeId === analyst.id));

  const denied = await assign(trfId, [{ testName: 'Sneaky Test', assignedEmployeeId: analyst.id }], analyst.token);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.message, MESSAGES.NO_PERMISSION);

  // Another analyst's single test must stay invisible.
  const otherTrf = await makeTrf(adminToken);
  toDelete.push(otherTrf.id);
  const theirs = await assign(otherTrf.id, [{ testName: 'Private Test', assignedEmployeeId: otherAnalyst.id }]);
  const peek = await api(`/api/assignments/tests/${theirs.body.items[0].id}`, {}, analyst.token);
  assert.equal(peek.status, 403);
});

maybe('the Analyst workload endpoint is refused and the Manager view is not', async () => {
  assert.equal((await api('/api/assignments/workload', {}, analyst.token)).status, 403);
  const res = await api('/api/assignments/workload', {}, manager.token);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.items));
  for (const row of res.body.items) {
    assert.equal(typeof row.openTotal, 'number');
    assert.equal(row.openTotal, row.pending + row.inProgress);
  }
});

maybe('assignments filter, sort and paginate on the server', async () => {
  const trf = await makeTrf(adminToken);
  toDelete.push(trf.id);
  await assign(trf.id, [
    { testName: 'Filter Alpha', assignedEmployeeId: analyst.id, dueDate: inDays(5) },
    { testName: 'Filter Beta', assignedEmployeeId: otherAnalyst.id, dueDate: inDays(30) },
    { testName: 'Filter Gamma', assignedEmployeeId: otherAnalyst.id, dueDate: inDays(15) },
  ]);

  const byEmployee = await api(`/api/assignments?employeeId=${otherAnalyst.id}&pageSize=200`, {}, adminToken);
  assert.ok(byEmployee.body.items.length >= 3);
  assert.ok(byEmployee.body.items.every((i: { assignedEmployeeId: number }) => i.assignedEmployeeId === otherAnalyst.id));

  const page = await api('/api/assignments?page=1&pageSize=2', {}, adminToken);
  assert.equal(page.body.items.length, 2);
  assert.equal(page.body.pageCount, Math.max(1, Math.ceil(page.body.total / 2)));

  const sorted = await api('/api/assignments?sortBy=dueDate&sortDir=asc&pageSize=200', {}, adminToken);
  const dates = sorted.body.items.map((i: { dueDate: string | null }) => i.dueDate).filter(Boolean);
  assert.deepEqual(dates, [...dates].sort());

  const byStatus = await api('/api/assignments?status=Assigned&pageSize=200', {}, adminToken);
  assert.ok(byStatus.body.items.every((i: { status: string }) => i.status === 'Assigned'));
});

maybe('the grouped view returns one group per TRF with its tests inside', async () => {
  const trf = await makeTrf(adminToken);
  toDelete.push(trf.id);
  await assign(trf.id, [
    { testName: 'Group One', assignedEmployeeId: analyst.id },
    { testName: 'Group Two', assignedEmployeeId: otherAnalyst.id },
  ]);

  const res = await api('/api/assignments?groupByTrf=true&pageSize=200', {}, adminToken);
  assert.equal(res.status, 200);
  const group = res.body.items.find((g: { trfId: number }) => g.trfId === trf.id);
  assert.ok(group, 'the new TRF should appear as a group');
  assert.equal(group.tests.length, 2);
  assert.ok(group.tests.every((t: { trfNumber: string }) => t.trfNumber === trf.trfNumber));
  assert.equal(group.trfStatus, 'Assigned');

  const ids = res.body.items.map((g: { trfId: number }) => g.trfId);
  assert.equal(new Set(ids).size, ids.length, 'a TRF must not appear twice');
});

maybe('the catalogue is readable by everyone who assigns and only editable by an admin', async () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const created = await api('/api/test-catalog', {
    method: 'POST', body: JSON.stringify({ name: `Catalog Test ${suffix}`, defaultMethod: 'ASTM D1234', unit: '%' }),
  }, adminToken);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.defaultMethod, 'ASTM D1234');

  const duplicate = await api('/api/test-catalog', {
    method: 'POST', body: JSON.stringify({ name: `catalog test ${suffix}` }),
  }, adminToken);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.message, 'That test is already in the catalogue.');

  // A new catalogue entry fills in the method when the assigner leaves it blank.
  const trf = await makeTrf(adminToken);
  toDelete.push(trf.id);
  const assigned = await assign(trf.id, [{ testName: `Catalog Test ${suffix}`, assignedEmployeeId: analyst.id }]);
  assert.equal(assigned.body.items[0].testMethod, 'ASTM D1234');

  assert.equal((await api('/api/test-catalog', {}, analyst.token)).status, 200);
  assert.equal((await api('/api/test-catalog', { method: 'POST', body: JSON.stringify({ name: 'Analyst Try' }) }, analyst.token)).status, 403);
  assert.equal((await api('/api/test-catalog', { method: 'POST', body: JSON.stringify({ name: 'Manager Try' }) }, manager.token)).status, 403);

  const retired = await api(`/api/test-catalog/${created.body.id}`, {
    method: 'PATCH', body: JSON.stringify({ isActive: false }),
  }, adminToken);
  assert.equal(retired.status, 200);
  const active = await api('/api/test-catalog', {}, adminToken);
  assert.equal(active.body.items.some((i: { id: number }) => i.id === created.body.id), false);
  const all = await api('/api/test-catalog?includeInactive=true', {}, adminToken);
  assert.equal(all.body.items.some((i: { id: number }) => i.id === created.body.id), true);

  await pool.query('DELETE FROM test_catalog WHERE id = $1', [created.body.id]);
});

maybe('a raw database error never reaches the client through the assignment routes', async () => {
  const res = await api('/api/assignments/tests/abc', {}, adminToken);
  assert.equal(res.status, 404);
  assert.equal(JSON.stringify(res.body).includes('SELECT'), false);
  assert.equal(JSON.stringify(res.body).includes('relation'), false);

  const missingTrf = await assign(999_999, [{ testName: 'Nowhere', assignedEmployeeId: 1 }]);
  assert.equal(missingTrf.status, 404);
});

maybe('cleanup: the TRFs, users and catalogue rows created above are removed', async () => {
  await cleanup(toDelete, [analyst.id, otherAnalyst.id, viewer.id, manager.id]);
  await pool.query(`DELETE FROM test_catalog WHERE name LIKE 'Catalog Test %'`);
  const left = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM analysis_tests WHERE trf_id = ANY($1)`, [toDelete]);
  assert.equal(Number(left.rows[0].count), 0);
});