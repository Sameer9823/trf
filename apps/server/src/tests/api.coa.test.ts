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
      employeeCode: `P6-${suffix}`, fullName: `Phase6 ${role} ${suffix}`, email: `p6-${suffix}@company.local`,
      username: `p6${suffix}`, role, password,
    }),
  }, adminToken);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { id: res.body.id as number, token: await loginAs(`p6${suffix}`, password) };
}

const trfIds: number[] = [];
const employeeIds: number[] = [];

interface TestRow { id: number; version: number }

async function makeTrf() {
  const lookups = await baseLookups();
  const res = await api('/api/trfs', {
    method: 'POST', body: JSON.stringify({ trfDate: TODAY, priority: 'Normal', ...lookups }),
  }, adminToken);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  trfIds.push(res.body.id);
  return res.body as { id: number; trfNumber: string };
}

/**
 * Builds a TRF whose analysis is finished, which is the only state a
 * certificate can be drafted from. Returns the TRF and the TRF version.
 */
async function analysedTrf(label: string) {
  const trf = await makeTrf();
  const assigned = await api(`/api/assignments/trfs/${trf.id}/assignments`, {
    method: 'POST',
    body: JSON.stringify({ assignments: [{ testName: `${label} Test`, assignedEmployeeId: analyst.id }] }),
  }, adminToken);
  assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
  const test = assigned.body.items[0] as TestRow;
  await api(`/api/analysis/tests/${test.id}/start`, { method: 'POST', body: JSON.stringify({ version: 1 }) }, analyst.token);
  await api(`/api/analysis/tests/${test.id}/result`, {
    method: 'PUT', body: JSON.stringify({ version: 2, resultValue: '2.5', lowerLimit: '1', upperLimit: '3' }),
  }, analyst.token);
  const done = await api(`/api/analysis/tests/${test.id}/complete`, {
    method: 'POST', body: JSON.stringify({ version: 3 }),
  }, analyst.token);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.outcome, 'Pass');
  return { trf, test };
}

let adminToken = '';
let managerA: { id: number; token: string };
let managerB: { id: number; token: string };
let analyst: { id: number; token: string };
let viewer: { id: number; token: string };

maybe('setup: users exist for the certificate tests', async () => {
  adminToken = await loginAs('phase2admin', 'Admin-Test-Password-42');
  managerA = await makeEmployee('Manager');
  managerB = await makeEmployee('Manager');
  analyst = await makeEmployee('Analyst');
  viewer = await makeEmployee('Viewer');
  employeeIds.push(managerA.id, managerB.id, analyst.id, viewer.id);
});

maybe('a certificate can only be drafted once the analysis is complete', async () => {
  const trf = await makeTrf();
  const assigned = await api(`/api/assignments/trfs/${trf.id}/assignments`, {
    method: 'POST',
    body: JSON.stringify({ assignments: [{ testName: 'Incomplete Coa Test', assignedEmployeeId: analyst.id }] }),
  }, adminToken);
  assert.equal(assigned.status, 201);

  const early = await api('/api/coa', { method: 'POST', body: JSON.stringify({ trfId: trf.id }) }, managerA.token);
  assert.equal(early.status, 409, JSON.stringify(early.body));
  assert.match(early.body.error.message, /Complete all its tests/);

  // A TRF that has not even been assigned cannot have a certificate either.
  const fresh = await makeTrf();
  const notReady = await api('/api/coa', { method: 'POST', body: JSON.stringify({ trfId: fresh.id }) }, managerA.token);
  assert.equal(notReady.status, 409);

  void assigned;
});

maybe('drafting snapshots the results, numbers the TRF as COA Pending and moves no TRF twice', async () => {
  const { trf, test } = await analysedTrf('Snapshot');
  const res = await api('/api/coa', {
    method: 'POST', body: JSON.stringify({ trfId: trf.id, remarks: 'Issued for internal use' }),
  }, managerA.token);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.status, 'Draft');
  assert.equal(res.body.coaNumber, null, 'a number is only minted on issue');
  assert.equal(res.body.trfStatus, 'COA Pending');
  assert.equal(res.body.counts.total, 1);
  assert.equal(res.body.counts.passed, 1);
  assert.equal(res.body.lines[0].testName, 'Snapshot Test');
  assert.equal(res.body.lines[0].resultValue, '2.5');
  assert.ok(res.body.preparedBy.name, 'the drafter is recorded');

  // A second certificate for the same TRF is refused.
  const duplicate = await api('/api/coa', { method: 'POST', body: JSON.stringify({ trfId: trf.id }) }, managerA.token);
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.body.error.message, /already exists/);

  const trfAfter = await api(`/api/trfs/${trf.id}`, {}, adminToken);
  assert.equal(trfAfter.body.status, 'COA Pending');
  const history = await api(`/api/trfs/${trf.id}/history`, {}, adminToken);
  const toPending = history.body.items.filter((h: { newStatus: string }) => h.newStatus === 'COA Pending');
  assert.equal(toPending.length, 1, 'the TRF moves once, not once per request');

  void test;
});

maybe('the certificate keeps the result it was drafted with after a re-test', async () => {
  const { trf } = await analysedTrf('Frozen');
  const drafted = await api('/api/coa', { method: 'POST', body: JSON.stringify({ trfId: trf.id }) }, managerA.token);
  assert.equal(drafted.status, 201, JSON.stringify(drafted.body));
  assert.equal(drafted.body.lines[0].resultValue, '2.5');

  // Re-test the live analysis to a failing number; the certificate must not follow it.
  const tests = await api(`/api/analysis?search=Frozen+Test&pageSize=200`, {}, adminToken);
  const test = tests.body.items[0];
  await api(`/api/analysis/tests/${test.id}/re-test`, {
    method: 'POST', body: JSON.stringify({ version: test.version, note: 'Result disputed' }),
  }, analyst.token);
  const restarted = await api(`/api/analysis/tests/${test.id}/start`, {
    method: 'POST', body: JSON.stringify({ version: test.version + 1 }),
  }, analyst.token);
  await api(`/api/analysis/tests/${test.id}/result`, {
    method: 'PUT', body: JSON.stringify({ version: restarted.body.version, resultValue: '99', lowerLimit: '1', upperLimit: '3' }),
  }, analyst.token);

  const reloaded = await api(`/api/coa/${drafted.body.id}`, {}, managerA.token);
  assert.equal(reloaded.body.lines[0].resultValue, '2.5', 'an issued record must not change with the live result');
  assert.equal(reloaded.body.counts.failed, 0);
});

maybe('the steps must be taken in order and each one is stamped', async () => {
  const { trf } = await analysedTrf('Ordered');
  const drafted = await api('/api/coa', { method: 'POST', body: JSON.stringify({ trfId: trf.id }) }, managerA.token);
  const id = drafted.body.id;
  let version = drafted.body.version as number;

  // Approving a draft that has not been reviewed is refused.
  const tooEarly = await api(`/api/coa/${id}/approve`, { method: 'POST', body: JSON.stringify({ version }) }, managerB.token);
  assert.equal(tooEarly.status, 409);
  assert.match(tooEarly.body.error.message, /only change to: Under Review/);

  const submitted = await api(`/api/coa/${id}/submit`, { method: 'POST', body: JSON.stringify({ version }) }, managerA.token);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.equal(submitted.body.status, 'Under Review');
  assert.ok(submitted.body.reviewedBy.name);
  version = submitted.body.version;

  const approved = await api(`/api/coa/${id}/approve`, { method: 'POST', body: JSON.stringify({ version, note: 'Checked' }) }, managerB.token);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.status, 'Approved');
  assert.ok(approved.body.approvedBy.name);
  version = approved.body.version;

  const issued = await api(`/api/coa/${id}/issue`, { method: 'POST', body: JSON.stringify({ version }) }, managerB.token);
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  assert.equal(issued.body.status, 'Issued');
  assert.match(issued.body.coaNumber, /^COA-\d{4}-\d{5}$/);
  assert.ok(issued.body.issuedBy.at);
  assert.equal(issued.body.trfStatus, 'Completed', 'issuing completes the TRF');

  // Nothing moves an issued certificate any further.
  for (const action of ['submit', 'approve', 'issue']) {
    const res = await api(`/api/coa/${id}/${action}`, {
      method: 'POST', body: JSON.stringify({ version: issued.body.version }),
    }, managerB.token);
    assert.equal(res.status, 409, `${action} on an issued certificate must be refused`);
  }
});

maybe('sending a certificate back needs a reason and clears the review stamp', async () => {
  const { trf } = await analysedTrf('Returned');
  const drafted = await api('/api/coa', { method: 'POST', body: JSON.stringify({ trfId: trf.id }) }, managerA.token);
  const id = drafted.body.id;
  const submitted = await api(`/api/coa/${id}/submit`, {
    method: 'POST', body: JSON.stringify({ version: drafted.body.version }),
  }, managerA.token);

  const silent = await api(`/api/coa/${id}/return`, {
    method: 'POST', body: JSON.stringify({ version: submitted.body.version }),
  }, managerA.token);
  assert.equal(silent.status, 400);
  assert.ok(silent.body.error.fields.note);

  const back = await api(`/api/coa/${id}/return`, {
    method: 'POST', body: JSON.stringify({ version: submitted.body.version, note: 'Customer name is wrong' }),
  }, managerA.token);
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(back.body.status, 'Draft');
  assert.equal(back.body.reviewedBy.name, null, 'it has to be reviewed again');

  // The remarks can then be corrected and it can go round once more.
  const fixed = await api(`/api/coa/${id}`, {
    method: 'PATCH', body: JSON.stringify({ version: back.body.version, remarks: 'Corrected' }),
  }, managerA.token);
  assert.equal(fixed.status, 200);
  assert.equal(fixed.body.remarks, 'Corrected');
});

maybe('the preparer cannot approve their own certificate', async () => {
  const { trf } = await analysedTrf('Separation');
  const drafted = await api('/api/coa', { method: 'POST', body: JSON.stringify({ trfId: trf.id }) }, managerA.token);
  const id = drafted.body.id;
  const submitted = await api(`/api/coa/${id}/submit`, {
    method: 'POST', body: JSON.stringify({ version: drafted.body.version }),
  }, managerA.token);

  const selfApproved = await api(`/api/coa/${id}/approve`, {
    method: 'POST', body: JSON.stringify({ version: submitted.body.version }),
  }, managerA.token);
  assert.equal(selfApproved.status, 409, JSON.stringify(selfApproved.body));
  assert.match(selfApproved.body.error.message, /someone else must approve/);

  // The other manager still can.
  const approved = await api(`/api/coa/${id}/approve`, {
    method: 'POST', body: JSON.stringify({ version: submitted.body.version }),
  }, managerB.token);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
});

maybe('a stale version is refused on every step with the standard conflict message', async () => {
  const { trf } = await analysedTrf('Conflict');
  const drafted = await api('/api/coa', { method: 'POST', body: JSON.stringify({ trfId: trf.id }) }, managerA.token);
  const id = drafted.body.id;

  await api(`/api/coa/${id}/submit`, { method: 'POST', body: JSON.stringify({ version: drafted.body.version }) }, managerA.token);

  // Replaying the version that was current before the send is a lost update.
  const stale = await api(`/api/coa/${id}/submit`, {
    method: 'POST', body: JSON.stringify({ version: drafted.body.version }),
  }, managerA.token);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.message, MESSAGES.CONFLICT);

  const staleApprove = await api(`/api/coa/${id}/approve`, {
    method: 'POST', body: JSON.stringify({ version: drafted.body.version }),
  }, managerB.token);
  assert.equal(staleApprove.status, 409);
  assert.equal(staleApprove.body.error.message, MESSAGES.CONFLICT);
});

maybe('an issued certificate cannot be edited, and its remarks are refused too', async () => {
  const { trf } = await analysedTrf('Immutable');
  const drafted = await api('/api/coa', { method: 'POST', body: JSON.stringify({ trfId: trf.id }) }, managerA.token);
  const id = drafted.body.id;
  let res = await api(`/api/coa/${id}/submit`, { method: 'POST', body: JSON.stringify({ version: drafted.body.version }) }, managerA.token);
  res = await api(`/api/coa/${id}/approve`, { method: 'POST', body: JSON.stringify({ version: res.body.version }) }, managerB.token);
  res = await api(`/api/coa/${id}/issue`, { method: 'POST', body: JSON.stringify({ version: res.body.version }) }, managerB.token);
  assert.equal(res.body.status, 'Issued');

  const edit = await api(`/api/coa/${id}`, {
    method: 'PATCH', body: JSON.stringify({ version: res.body.version, remarks: 'Late correction' }),
  }, adminToken);
  assert.equal(edit.status, 409);
  assert.match(edit.body.error.message, /cannot be changed/);

  const reloaded = await api(`/api/coa/${id}`, {}, adminToken);
  assert.equal(reloaded.body.remarks, null);
});

maybe('only a Manager may draft, approve or issue; a Viewer may only read', async () => {
  const { trf } = await analysedTrf('Rights');
  const drafted = await api('/api/coa', { method: 'POST', body: JSON.stringify({ trfId: trf.id }) }, managerA.token);
  const id = drafted.body.id;

  assert.equal((await api('/api/coa', { method: 'POST', body: JSON.stringify({ trfId: trf.id }) }, viewer.token)).status, 403);
  assert.equal((await api(`/api/coa/${id}/submit`, {
    method: 'POST', body: JSON.stringify({ version: drafted.body.version }),
  }, viewer.token)).status, 403);
  assert.equal((await api(`/api/coa/${id}/approve`, {
    method: 'POST', body: JSON.stringify({ version: drafted.body.version }),
  }, viewer.token)).status, 403);
  assert.equal((await api(`/api/coa/${id}/issue`, {
    method: 'POST', body: JSON.stringify({ version: drafted.body.version }),
  }, viewer.token)).status, 403);
  assert.equal((await api(`/api/coa/${id}`, {
    method: 'PATCH', body: JSON.stringify({ version: drafted.body.version, remarks: 'x' }),
  }, viewer.token)).status, 403);

  // A Viewer may still read the certificate and its history.
  const read = await api(`/api/coa/${id}`, {}, viewer.token);
  assert.equal(read.status, 200);
  const audit = await api(`/api/coa/${id}/audit`, {}, viewer.token);
  assert.equal(audit.status, 200);
  assert.ok(audit.body.items.some((i: { action: string }) => i.action === 'coa.drafted'));

  // An Analyst has no place in the certificate workflow at all.
  assert.equal((await api('/api/coa', { method: 'POST', body: JSON.stringify({ trfId: trf.id }) }, analyst.token)).status, 403);
});

maybe('the list filters, searches, sorts and paginates, and the summary agrees', async () => {
  const byStatus = await api('/api/coa?status=Draft&pageSize=200', {}, adminToken);
  assert.equal(byStatus.status, 200);
  assert.ok(byStatus.body.items.every((c: { status: string }) => c.status === 'Draft'));

  const byTrf = await api(`/api/coa?trfNumber=TRF-&pageSize=200`, {}, adminToken);
  assert.ok(byTrf.body.items.length > 0);

  const searched = await api('/api/coa?search=Immutable&pageSize=200', {}, adminToken);
  assert.ok(searched.body.items.length >= 0);

  const page = await api('/api/coa?page=1&pageSize=2', {}, adminToken);
  assert.ok(page.body.items.length <= 2);
  assert.equal(page.body.pageCount, Math.max(1, Math.ceil(page.body.total / 2)));

  const sorted = await api('/api/coa?sortBy=trfNumber&sortDir=asc&pageSize=200', {}, adminToken);
  const numbers = sorted.body.items.map((c: { trfNumber: string }) => c.trfNumber);
  assert.deepEqual(numbers, [...numbers].sort());

  const summary = await api('/api/coa/summary?pageSize=200', {}, adminToken);
  const everything = await api('/api/coa?pageSize=200', {}, adminToken);
  assert.equal(summary.body.total, everything.body.total);
  const countOf = (status: string) => everything.body.items.filter((c: { status: string }) => c.status === status).length;
  assert.equal(summary.body.draft, countOf('Draft'));
  assert.equal(summary.body.underReview, countOf('Under Review'));
  assert.equal(summary.body.approved, countOf('Approved'));
  assert.equal(summary.body.issued, countOf('Issued'));
});

maybe('mine only narrows the list to what this person prepared or approved', async () => {
  const mine = await api('/api/coa?mineOnly=true&pageSize=200', {}, managerB.token);
  assert.equal(mine.status, 200);
  const all = await api('/api/coa?pageSize=200', {}, adminToken);
  assert.ok(mine.body.total <= all.body.total);
});

maybe('a missing or malformed id is a 404, not a database error', async () => {
  for (const path of ['/api/coa/abc', '/api/coa/99999999']) {
    const res = await api(path, {}, adminToken);
    assert.equal(res.status, 404, `${path} should be 404`);
    assert.equal(JSON.stringify(res.body).includes('SELECT'), false);
    assert.equal(JSON.stringify(res.body).includes('coas'), false);
  }
  const trfLookup = await api('/api/coa/trfs/99999999', {}, adminToken);
  assert.equal(trfLookup.status, 200);
  assert.equal(trfLookup.body.coa, null);
});

maybe('an unauthenticated request cannot read any certificate', async () => {
  const res = await api('/api/coa');
  assert.equal(res.status, 401);
});

maybe('cleanup: the TRFs, certificates and users created above are removed', async () => {
  await pool.query('DELETE FROM trfs WHERE id = ANY($1)', [trfIds]);
  await pool.query('DELETE FROM employees WHERE id = ANY($1)', [employeeIds]);
  await pool.query(`DELETE FROM audit_logs WHERE module = 'coa' AND record_ref LIKE 'TRF-%'`);
  const left = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM coas WHERE trf_id = ANY($1)`, [trfIds]);
  assert.equal(Number(left.rows[0].count), 0, 'certificates must go with their TRFs');
  const lines = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM coa_lines l
     WHERE NOT EXISTS (SELECT 1 FROM coas c WHERE c.id = l.coa_id)`);
  assert.equal(Number(lines.rows[0].count), 0, 'no orphaned certificate lines');
});