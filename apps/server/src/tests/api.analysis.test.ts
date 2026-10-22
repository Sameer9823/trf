import { strict as assert } from 'node:assert';
import { after, before, test, TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { MESSAGES } from '@trf/shared';
import { buildApp } from '../app';
import { pool, isDatabaseReachable } from '../db';
import { runMigrations } from '../migrate';
import { baseLookups } from './fixtures';

const dbReachable = isDatabaseReachable().catch(() => false);
let server: Server;
let baseUrl = '';

/** Database tests report as skipped rather than silently passing. */
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
      employeeCode: `P5-${suffix}`, fullName: `Phase5 ${role} ${suffix}`, email: `p5-${suffix}@company.local`,
      username: `p5${suffix}`, role, password,
    }),
  }, adminToken);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { id: res.body.id as number, token: await loginAs(`p5${suffix}`, password) };
}

const trfIds: number[] = [];
const employeeIds: number[] = [];

async function makeTrf() {
  const lookups = await baseLookups();
  const res = await api('/api/trfs', {
    method: 'POST', body: JSON.stringify({ trfDate: TODAY, priority: 'Normal', ...lookups }),
  }, adminToken);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  trfIds.push(res.body.id);
  return res.body as { id: number; trfNumber: string; status: string; version: number };
}

/** Assigns tests on a new TRF and returns them in the order they were assigned. */
async function assignedTests(specs: { name: string; employeeId: number; dueDate?: string }[]) {
  const trf = await makeTrf();
  const res = await api(`/api/assignments/trfs/${trf.id}/assignments`, {
    method: 'POST',
    body: JSON.stringify({
      assignments: specs.map((s) => ({ testName: s.name, assignedEmployeeId: s.employeeId, dueDate: s.dueDate ?? null })),
    }),
  }, adminToken);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { trf, items: res.body.items as { id: number; version: number; testName: string }[] };
}

let adminToken = '';
let managerToken = '';
let analyst: { id: number; token: string };
let otherAnalyst: { id: number; token: string };
let viewer: { id: number; token: string };

maybe('setup: users exist for the analysis tests', async () => {
  adminToken = await loginAs('phase2admin', 'Admin-Test-Password-42');
  analyst = await makeEmployee('Analyst');
  otherAnalyst = await makeEmployee('Analyst');
  const manager = await makeEmployee('Manager');
  managerToken = manager.token;
  viewer = await makeEmployee('Viewer');
  employeeIds.push(analyst.id, otherAnalyst.id, manager.id, viewer.id);
});

maybe('the analysis list is scoped to the analyst and shows the computed outcome', async () => {
  const { items } = await assignedTests([
    { name: 'Outcome Pass Test', employeeId: analyst.id },
    { name: 'Outcome Fail Test', employeeId: otherAnalyst.id },
  ]);

  const mine = await api('/api/analysis?pageSize=200', {}, analyst.token);
  assert.equal(mine.status, 200);
  assert.ok(mine.body.items.every((i: { assignedEmployeeId: number }) => i.assignedEmployeeId === analyst.id));
  assert.ok(!mine.body.items.some((i: { testName: string }) => i.testName === 'Outcome Fail Test'));

  const pass = mine.body.items.find((i: { testName: string }) => i.testName === 'Outcome Pass Test');
  assert.equal(pass.outcome, 'Not Tested', 'no result means nothing to judge yet');

  const saved = await api(`/api/analysis/tests/${items[0].id}/result`, {
    method: 'PUT', body: JSON.stringify({ version: 1, resultValue: '2.5', lowerLimit: '1', upperLimit: '3' }),
  }, analyst.token);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.outcome, 'Pass');
  assert.equal(saved.body.result.resultValue, '2.5');
  assert.ok(saved.body.startDate, 'recording a result starts the test');

  const failed = await api(`/api/analysis/tests/${items[1].id}/result`, {
    method: 'PUT', body: JSON.stringify({ version: 1, resultValue: '9.9', lowerLimit: '1', upperLimit: '3' }),
  }, otherAnalyst.token);
  assert.equal(failed.body.outcome, 'Fail');
});

maybe('a result with no limits is Not Specified, not a pass', async () => {
  const { items } = await assignedTests([{ name: 'No Limits Test', employeeId: analyst.id }]);
  const res = await api(`/api/analysis/tests/${items[0].id}/result`, {
    method: 'PUT', body: JSON.stringify({ version: 1, resultValue: '4.2' }),
  }, analyst.token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.outcome, 'Not Specified');

  const filtered = await api('/api/analysis?outcome=Pass&pageSize=200', {}, adminToken);
  assert.ok(filtered.body.items.every((i: { outcome: string }) => i.outcome === 'Pass'));
  assert.ok(!filtered.body.items.some((i: { testName: string }) => i.testName === 'No Limits Test'));
});

maybe('a text result is allowed where a number is not', async () => {
  const { items } = await assignedTests([{ name: 'Appearance Test', employeeId: analyst.id }]);
  const res = await api(`/api/analysis/tests/${items[0].id}/result`, {
    method: 'PUT', body: JSON.stringify({ version: 1, resultText: 'Clear, odourless' }),
  }, analyst.token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.result.resultText, 'Clear, odourless');
  assert.equal(res.body.outcome, 'Not Specified');
});

maybe('an empty or malformed result is refused with field messages', async () => {
  const { items } = await assignedTests([{ name: 'Validation Test', employeeId: analyst.id }]);
  const id = items[0].id;

  const empty = await api(`/api/analysis/tests/${id}/result`, { method: 'PUT', body: JSON.stringify({ version: 1 }) }, analyst.token);
  assert.equal(empty.status, 400);
  assert.ok(empty.body.error.fields.resultValue);

  const notANumber = await api(`/api/analysis/tests/${id}/result`, {
    method: 'PUT', body: JSON.stringify({ version: 1, resultValue: 'about five' }),
  }, analyst.token);
  assert.equal(notANumber.status, 400);

  const limitsWithoutValue = await api(`/api/analysis/tests/${id}/result`, {
    method: 'PUT', body: JSON.stringify({ version: 1, resultText: 'clear', lowerLimit: '1', upperLimit: '2' }),
  }, analyst.token);
  assert.equal(limitsWithoutValue.status, 400);

  const inverted = await api(`/api/analysis/tests/${id}/result`, {
    method: 'PUT', body: JSON.stringify({ version: 1, resultValue: '5', lowerLimit: '9', upperLimit: '1' }),
  }, analyst.token);
  assert.equal(inverted.status, 400);
  assert.ok(inverted.body.error.fields.lowerLimit);

  const left = await api(`/api/analysis/tests/${id}`, {}, adminToken);
  assert.equal(left.body.result, null, 'a refused result must not be partially stored');
});

maybe('an Analyst can only record results on their own tests', async () => {
  const { items } = await assignedTests([{ name: 'Ownership Test', employeeId: otherAnalyst.id }]);
  const res = await api(`/api/analysis/tests/${items[0].id}/result`, {
    method: 'PUT', body: JSON.stringify({ version: 1, resultValue: '1' }),
  }, analyst.token);
  assert.equal(res.status, 403);
  assert.equal(res.body.error.message, MESSAGES.NO_PERMISSION);

  // A Manager can see the test but may not enter a number on someone's behalf.
  const byManager = await api(`/api/analysis/tests/${items[0].id}`, {}, managerToken);
  assert.equal(byManager.status, 200);
  const managerWrite = await api(`/api/analysis/tests/${items[0].id}/result`, {
    method: 'PUT', body: JSON.stringify({ version: 1, resultValue: '1' }),
  }, managerToken);
  assert.equal(managerWrite.status, 403);

  assert.equal((await api(`/api/analysis/tests/${items[0].id}`, {}, viewer.token)).status, 403);
});

maybe('a Viewer may read nothing of other people’s work and cannot change anything', async () => {
  const { items } = await assignedTests([{ name: 'Viewer Read Test', employeeId: analyst.id }]);
  await api(`/api/analysis/tests/${items[0].id}/result`, {
    method: 'PUT', body: JSON.stringify({ version: 1, resultValue: '3', upperLimit: '5' }),
  }, analyst.token);

  // Viewer holds analysis.view but not analysis.viewAll, so the list stays empty.
  const list = await api('/api/analysis?search=Viewer+Read+Test', {}, viewer.token);
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 0);
  assert.equal((await api(`/api/analysis/tests/${items[0].id}`, {}, viewer.token)).status, 403);

  // A Viewer with nothing assigned still cannot write anywhere.
  for (const [method, path, body] of [
    ['PUT', `/api/analysis/tests/${items[0].id}/result`, { version: 2, resultValue: '4' }],
    ['POST', `/api/analysis/tests/${items[0].id}/start`, { version: 2 }],
    ['POST', `/api/analysis/tests/${items[0].id}/complete`, { version: 2 }],
  ] as const) {
    const res = await api(path, { method, body: JSON.stringify(body) }, viewer.token);
    assert.equal(res.status, 403, `${method} ${path} should be forbidden`);
  }
});

maybe('start, complete and the TRF hand-off follow the transition table', async () => {
  const { trf, items } = await assignedTests([
    { name: 'Flow One', employeeId: analyst.id },
    { name: 'Flow Two', employeeId: analyst.id },
  ]);
  const id = items[0].id;

  // Completing before starting is refused.
  const early = await api(`/api/analysis/tests/${id}/complete`, { method: 'POST', body: JSON.stringify({ version: 1 }) }, analyst.token);
  assert.equal(early.status, 409);
  assert.match(early.body.error.message, /only change to: In Progress/);

  const started = await api(`/api/analysis/tests/${id}/start`, { method: 'POST', body: JSON.stringify({ version: 1 }) }, analyst.token);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.status, 'In Progress');
  assert.ok(started.body.startDate);
  const startDate = started.body.startDate;

  // Starting a test that is already running is refused rather than resetting its dates.
  const alreadyRunning = await api(`/api/analysis/tests/${id}/start`, { method: 'POST', body: JSON.stringify({ version: 2 }) }, analyst.token);
  assert.equal(alreadyRunning.status, 409);
  assert.match(alreadyRunning.body.error.message, /only change to: Completed, Cancelled/);

  // Completing a running test still needs a result first.
  const withoutResult = await api(`/api/analysis/tests/${id}/complete`, { method: 'POST', body: JSON.stringify({ version: 2 }) }, analyst.token);
  assert.equal(withoutResult.status, 409);
  assert.match(withoutResult.body.error.message, /Record the result/);

  await api(`/api/analysis/tests/${id}/result`, {
    method: 'PUT', body: JSON.stringify({ version: 2, resultValue: '1.5' }),
  }, analyst.token);
  const noResult = await api(`/api/analysis/tests/${id}/complete`, { method: 'POST', body: JSON.stringify({ version: 3 }) }, analyst.token);
  assert.equal(noResult.status, 200, JSON.stringify(noResult.body));
  assert.equal(noResult.body.startDate, startDate);

  // One test is still open, so the TRF has not moved past In Progress.
  const midway = await api(`/api/trfs/${trf.id}`, {}, adminToken);
  assert.equal(midway.body.status, 'In Progress');

  // Finish the second test and the TRF follows on its own.
  const second = await api(`/api/analysis/tests/${items[1].id}/start`, { method: 'POST', body: JSON.stringify({ version: 1 }) }, analyst.token);
  await api(`/api/analysis/tests/${items[1].id}/result`, {
    method: 'PUT', body: JSON.stringify({ version: second.body.version, resultValue: '2' }),
  }, analyst.token);
  const done = await api(`/api/analysis/tests/${items[1].id}/complete`, {
    method: 'POST', body: JSON.stringify({ version: second.body.version + 1 }),
  }, analyst.token);
  assert.equal(done.status, 200, JSON.stringify(done.body));

  const trfAfter = await api(`/api/trfs/${trf.id}`, {}, adminToken);
  assert.equal(trfAfter.body.status, 'Analysis Completed', 'the TRF follows its tests');
  const history = await api(`/api/trfs/${trf.id}/history`, {}, adminToken);
  assert.ok(history.body.items.some((h: { newStatus: string }) => h.newStatus === 'Analysis Completed'));
});

maybe('a completed test can be sent for a re-test, which clears the result', async () => {
  const { items } = await assignedTests([{ name: 'Re-test Flow', employeeId: analyst.id }]);
  const id = items[0].id;

  await api(`/api/analysis/tests/${id}/start`, { method: 'POST', body: JSON.stringify({ version: 1 }) }, analyst.token);
  await api(`/api/analysis/tests/${id}/result`, {
    method: 'PUT', body: JSON.stringify({ version: 2, resultValue: '5', upperLimit: '4' }),
  }, analyst.token);
  const completed = await api(`/api/analysis/tests/${id}/complete`, { method: 'POST', body: JSON.stringify({ version: 3 }) }, analyst.token);
  assert.equal(completed.body.outcome, 'Fail');

  // A reason is required: an unexplained repeat is how results quietly change.
  const noReason = await api(`/api/analysis/tests/${id}/re-test`, { method: 'POST', body: JSON.stringify({ version: 4 }) }, analyst.token);
  assert.equal(noReason.status, 400);
  assert.ok(noReason.body.error.fields.note);

  const reTest = await api(`/api/analysis/tests/${id}/re-test`, {
    method: 'POST', body: JSON.stringify({ version: 4, note: 'Sample was contaminated in transit' }),
  }, analyst.token);
  assert.equal(reTest.status, 200, JSON.stringify(reTest.body));
  assert.equal(reTest.body.status, 'Re-test Required');
  assert.equal(reTest.body.result, null);
  assert.equal(reTest.body.completionDate, null);
  assert.ok(reTest.body.startDate, 'the original start date survives a re-test');

  const restarted = await api(`/api/analysis/tests/${id}/start`, { method: 'POST', body: JSON.stringify({ version: 5 }) }, analyst.token);
  assert.equal(restarted.status, 200, JSON.stringify(restarted.body));
  assert.equal(restarted.body.status, 'In Progress');

  const rows = await pool.query<{ action: string }>(
    `SELECT action FROM audit_logs WHERE module = 'analysis' AND record_ref LIKE $1 ORDER BY id`, ['%Re-test Flow%']);
  const actions = rows.rows.map((r) => r.action);
  assert.ok(actions.includes('analysis.started'));
  assert.ok(actions.includes('analysis.result_recorded'));
  assert.ok(actions.includes('analysis.completed'));
  assert.ok(actions.includes('analysis.re_test_requested'));
});

maybe('a cancelled assignment cannot be started or completed', async () => {
  const { items } = await assignedTests([{ name: 'Cancelled Flow', employeeId: analyst.id }]);
  const id = items[0].id;
  const cancelled = await api(`/api/assignments/tests/${id}/cancel`, { method: 'POST', body: JSON.stringify({ version: 1 }) }, adminToken);
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));

  const start = await api(`/api/analysis/tests/${id}/start`, { method: 'POST', body: JSON.stringify({ version: 2 }) }, analyst.token);
  assert.equal(start.status, 409);
  const complete = await api(`/api/analysis/tests/${id}/complete`, { method: 'POST', body: JSON.stringify({ version: 2 }) }, analyst.token);
  assert.equal(complete.status, 409);
});

maybe('a stale version is refused with the standard conflict message', async () => {
  const { items } = await assignedTests([{ name: 'Conflict Test', employeeId: analyst.id }]);
  const id = items[0].id;

  assert.equal((await api(`/api/analysis/tests/${id}/result`, {
    method: 'PUT', body: JSON.stringify({ version: 1, resultValue: '1' }),
  }, analyst.token)).status, 200);

  const stale = await api(`/api/analysis/tests/${id}/result`, {
    method: 'PUT', body: JSON.stringify({ version: 1, resultValue: '2' }),
  }, analyst.token);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.message, MESSAGES.CONFLICT);

  const staleStart = await api(`/api/analysis/tests/${id}/start`, { method: 'POST', body: JSON.stringify({ version: 1 }) }, analyst.token);
  assert.equal(staleStart.status, 409);
});

maybe('saving a result twice updates the same row instead of adding a second one', async () => {
  const { items } = await assignedTests([{ name: 'Overwrite Test', employeeId: analyst.id }]);
  const id = items[0].id;

  const first = await api(`/api/analysis/tests/${id}/result`, {
    method: 'PUT', body: JSON.stringify({ version: 1, resultValue: '1', remarks: 'first reading' }),
  }, analyst.token);
  assert.equal(first.status, 200);
  const second = await api(`/api/analysis/tests/${id}/result`, {
    method: 'PUT', body: JSON.stringify({ version: first.body.version, resultValue: '2', remarks: 'corrected reading' }),
  }, analyst.token);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.id, first.body.id, 'the result row is reused');
  assert.equal(second.body.result.resultValue, '2');

  const rows = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM analysis_results WHERE analysis_test_id = $1`, [id]);
  assert.equal(Number(rows.rows[0].count), 1);
});

maybe('the analysis list filters, sorts and paginates on the server', async () => {
  const { items } = await assignedTests([
    { name: 'Filter Late A', employeeId: analyst.id, dueDate: inDays(30) },
    { name: 'Filter Late B', employeeId: otherAnalyst.id, dueDate: inDays(60) },
  ]);

  const byEmployee = await api(`/api/analysis?employeeId=${otherAnalyst.id}&pageSize=200`, {}, adminToken);
  assert.ok(byEmployee.body.items.every((i: { assignedEmployeeId: number }) => i.assignedEmployeeId === otherAnalyst.id));

  const page = await api('/api/analysis?page=1&pageSize=2', {}, adminToken);
  assert.equal(page.body.items.length, 2);
  assert.equal(page.body.pageCount, Math.max(1, Math.ceil(page.body.total / 2)));

  const sorted = await api('/api/analysis?sortBy=dueDate&sortDir=asc&pageSize=200', {}, adminToken);
  const dates = sorted.body.items.map((i: { dueDate: string | null }) => i.dueDate).filter(Boolean);
  assert.deepEqual(dates, [...dates].sort());

  const byStatus = await api('/api/analysis?status=Assigned&pageSize=200', {}, adminToken);
  assert.ok(byStatus.body.items.every((i: { status: string }) => i.status === 'Assigned'));

  // An Analyst cannot widen their own list by asking for someone else's id.
  const widened = await api(`/api/analysis?employeeId=${otherAnalyst.id}&mineOnly=false&pageSize=200`, {}, analyst.token);
  assert.ok(widened.body.items.every((i: { assignedEmployeeId: number }) => i.assignedEmployeeId === analyst.id));

  void items;
});

maybe('my work and the summary count the same rows the list returns', async () => {
  const mine = await api('/api/analysis/mine', {}, analyst.token);
  assert.equal(mine.status, 200);
  assert.ok(mine.body.items.every((i: { status: string }) => i.status !== 'Completed' && i.status !== 'Cancelled'));

  const list = await api('/api/analysis?mineOnly=true&pageSize=200&status=Assigned', {}, analyst.token);
  const summary = await api('/api/analysis/summary?mineOnly=true&status=Assigned', {}, analyst.token);
  assert.equal(summary.status, 200);
  assert.equal(summary.body.total, list.body.total);
  assert.equal(summary.body.inProgress, list.body.items.filter((i: { status: string }) => i.status === 'In Progress').length);
});

maybe('a raw database error never reaches the client through the analysis routes', async () => {
  const res = await api('/api/analysis/tests/abc', {}, adminToken);
  assert.equal(res.status, 404);
  assert.equal(JSON.stringify(res.body).includes('SELECT'), false);
  assert.equal(JSON.stringify(res.body).includes('analysis_results'), false);
});

maybe('cleanup: the TRFs, users and results created above are removed', async () => {
  await pool.query('DELETE FROM trfs WHERE id = ANY($1)', [trfIds]);
  await pool.query('DELETE FROM employees WHERE id = ANY($1)', [employeeIds]);
  await pool.query(`DELETE FROM audit_logs WHERE record_ref LIKE '%/ %' AND record_ref NOT LIKE '%Phase2%'`);
  const left = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM analysis_results r JOIN analysis_tests a ON a.id = r.analysis_test_id
     WHERE a.trf_id = ANY($1)`, [trfIds]);
  assert.equal(Number(left.rows[0].count), 0, 'results must go with their TRFs');
});
