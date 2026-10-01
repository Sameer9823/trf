import { strict as assert } from 'node:assert';
import { after, before, test, TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildApp } from '../app';
import { pool, isDatabaseReachable } from '../db';
import { runMigrations } from '../migrate';

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
      employeeCode: `P11-${suffix}`, fullName: `Phase11 Search ${role} ${suffix}`, email: `p11-${suffix}@company.local`,
      username: `p11${suffix}`, role, password,
    }),
  }, adminToken);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { id: res.body.id as number, token: await loginAs(`p11${suffix}`, password) };
}

let adminToken = '';
let managerToken = '';
let analyst: { id: number; token: string };
let otherAnalyst: { id: number; token: string };

/**
 * One TRF per scenario, all carrying the same marker string in their batch number
 * so a single search term finds them. Each is assigned a different test, and one
 * of them gets a certificate, so all three result groups have something in them.
 */
const MARKER = `p11search${Math.random().toString(36).slice(2, 7)}`;

interface Fixture { trfId: number; trfNumber: string; testId: number; testName: string }

const analystTrf: Fixture[] = [];
let otherTrf: Fixture = { trfId: 0, trfNumber: '', testId: 0, testName: '' };
let issuedCoa: { id: number; coaNumber: string } = { id: 0, coaNumber: '' };

async function makeAssignedTrf(createdBy: string, employeeId: number, tag: string): Promise<Fixture> {
  const created = await api('/api/trfs', {
    method: 'POST',
    body: JSON.stringify({ trfDate: TODAY, priority: 'Normal', batchNumber: `${MARKER}-${tag}` }),
  }, createdBy);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const trfId = created.body.id as number;
  const trfNumber = created.body.trfNumber as string;

  // The TRF is assigned to the same person as its tests, because the TRF list
  // scope is the TRF's own assignee, not whoever is doing the bench work.
  const assignedTrf = await api(`/api/trfs/${trfId}/assign`, {
    method: 'POST',
    body: JSON.stringify({ assignedEmployeeId: employeeId, version: created.body.version }),
  }, adminToken);
  assert.equal(assignedTrf.status, 200, JSON.stringify(assignedTrf.body));

  const assigned = await api(`/api/assignments/trfs/${trfId}/assignments`, {
    method: 'POST',
    body: JSON.stringify({ assignments: [{ testName: `${MARKER} ${tag} Titration`, assignedEmployeeId: employeeId }] }),
  }, adminToken);
  assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
  const item = assigned.body.items[0] as { id: number };

  return { trfId, trfNumber, testId: item.id, testName: `${MARKER} ${tag} Titration` };
}

/** Runs a test to completion, which is the precondition for drafting any certificate. */
async function completeTest(fixture: Fixture, analystToken: string) {
  await api(`/api/analysis/tests/${fixture.testId}/start`, {
    method: 'POST', body: JSON.stringify({ version: 1 }),
  }, analystToken);
  await api(`/api/analysis/tests/${fixture.testId}/result`, {
    method: 'PUT', body: JSON.stringify({ version: 2, resultValue: '2.5', lowerLimit: '1', upperLimit: '3' }),
  }, analystToken);
  const done = await api(`/api/analysis/tests/${fixture.testId}/complete`, {
    method: 'POST', body: JSON.stringify({ version: 3 }),
  }, analystToken);
  assert.equal(done.status, 200, JSON.stringify(done.body));
}

/**
 * A certificate can only be drafted once every test on the TRF is finished, and
 * the preparer may not approve their own, so this walks the whole path: a manager
 * drafts and submits, an admin approves and issues, and only issue mints a number.
 */
async function issueCertificate(fixture: Fixture, analystToken: string) {
  await completeTest(fixture, analystToken);

  const created = await api('/api/coa', { method: 'POST', body: JSON.stringify({ trfId: fixture.trfId }) }, managerToken);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const coaId = created.body.id as number;
  assert.equal(created.body.coaNumber, null, 'a number is only minted on issue');

  const submitted = await api(`/api/coa/${coaId}/submit`, {
    method: 'POST', body: JSON.stringify({ version: created.body.version }),
  }, managerToken);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));

  const approved = await api(`/api/coa/${coaId}/approve`, {
    method: 'POST', body: JSON.stringify({ version: submitted.body.version }),
  }, adminToken);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));

  const issued = await api(`/api/coa/${coaId}/issue`, {
    method: 'POST', body: JSON.stringify({ version: approved.body.version }),
  }, adminToken);
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  assert.equal(issued.body.status, 'Issued');
  assert.ok(issued.body.coaNumber, 'issuing mints the certificate number');
  return issued.body as { id: number; coaNumber: string };
}

maybe('setup: records exist for the search tests', async () => {
  adminToken = await loginAs('phase2admin', 'Admin-Test-Password-42');
  const manager = await makeEmployee('Manager');
  managerToken = manager.token;
  analyst = await makeEmployee('Analyst');
  otherAnalyst = await makeEmployee('Analyst');

  analystTrf.push(await makeAssignedTrf(adminToken, analyst.id, 'one'));
  analystTrf.push(await makeAssignedTrf(adminToken, analyst.id, 'two'));
  otherTrf = await makeAssignedTrf(adminToken, otherAnalyst.id, 'other');

  // The first TRF's certificate goes all the way to Issued, so it has a number.
  issuedCoa = await issueCertificate(analystTrf[0], analyst.token);
  // The second one's test is finished too, which is what lets a Draft be created;
  // it stops there, so it stays unnumbered.
  await completeTest(analystTrf[1], analyst.token);
  const draft = await api('/api/coa', { method: 'POST', body: JSON.stringify({ trfId: analystTrf[1].trfId }) }, managerToken);
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  assert.equal(draft.body.coaNumber, null);
});

maybe('search returns all three groups for a matching term', async () => {
  const res = await api(`/api/search?q=${MARKER}`, {}, analyst.token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(Array.isArray(res.body.trfs), JSON.stringify(res.body));
  assert.ok(Array.isArray(res.body.analysis), JSON.stringify(res.body));
  assert.ok(Array.isArray(res.body.coas), JSON.stringify(res.body));
  // Both of this analyst's TRFs match, and they are returned under their real numbers.
  const numbers = res.body.trfs.map((r: { trfNumber: string }) => r.trfNumber);
  assert.ok(numbers.includes(analystTrf[0].trfNumber), JSON.stringify(numbers));
  assert.ok(numbers.includes(analystTrf[1].trfNumber), JSON.stringify(numbers));
});

maybe('search finds a TRF by its exact number', async () => {
  const res = await api(`/api/search?q=${encodeURIComponent(analystTrf[1].trfNumber)}`, {}, analyst.token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const hit = res.body.trfs.find((r: { trfNumber: string }) => r.trfNumber === analystTrf[1].trfNumber);
  assert.ok(hit, JSON.stringify(res.body));
  assert.equal(hit.id, analystTrf[1].trfId);
  assert.equal(hit.batchNumber, `${MARKER}-two`);
});

maybe('search finds an analysis test by its name', async () => {
  const res = await api(`/api/search?q=${encodeURIComponent(analystTrf[1].testName)}`, {}, analyst.token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const hit = res.body.analysis.find((r: { id: number }) => r.id === analystTrf[1].testId);
  assert.ok(hit, JSON.stringify(res.body));
  assert.equal(hit.trfNumber, analystTrf[1].trfNumber);
});

maybe('search finds an issued certificate by its number', async () => {
  const res = await api(`/api/search?q=${encodeURIComponent(issuedCoa.coaNumber)}`, {}, adminToken);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const hit = res.body.coas.find((c: { id: number }) => c.id === issuedCoa.id);
  assert.ok(hit, JSON.stringify(res.body));
  assert.equal(hit.coaNumber, issuedCoa.coaNumber);
  assert.equal(hit.status, 'Issued');
});

maybe('search covers an unnumbered draft certificate through its TRF number', async () => {
  const res = await api(`/api/search?q=${encodeURIComponent(analystTrf[1].trfNumber)}`, {}, analyst.token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const draft = res.body.coas.find((c: { trfId: number }) => c.trfId === analystTrf[1].trfId);
  assert.ok(draft, JSON.stringify(res.body));
  assert.equal(draft.coaNumber, null);
  assert.equal(draft.status, 'Draft');
});

maybe('an Analyst only sees their own TRFs and tests', async () => {
  const res = await api(`/api/search?q=${MARKER}`, {}, analyst.token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const trfIds = res.body.trfs.map((r: { id: number }) => r.id);
  const testIds = res.body.analysis.map((r: { id: number }) => r.id);
  assert.ok(!trfIds.includes(otherTrf.trfId), 'saw a TRF assigned to someone else');
  assert.ok(!testIds.includes(otherTrf.testId), 'saw a test assigned to someone else');
});

maybe('an Admin sees every matching record, including other people’s work', async () => {
  const res = await api(`/api/search?q=${MARKER}`, {}, adminToken);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const trfIds = res.body.trfs.map((r: { id: number }) => r.id);
  const testIds = res.body.analysis.map((r: { id: number }) => r.id);
  assert.ok(trfIds.includes(otherTrf.trfId), JSON.stringify(trfIds));
  assert.ok(testIds.includes(otherTrf.testId), JSON.stringify(testIds));
});

maybe('the limit bounds each group', async () => {
  const res = await api(`/api/search?q=${MARKER}&limit=1`, {}, adminToken);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.trfs.length <= 1, JSON.stringify(res.body));
  assert.ok(res.body.analysis.length <= 1, JSON.stringify(res.body));
  assert.ok(res.body.coas.length <= 1, JSON.stringify(res.body));
});

maybe('a term that matches nothing returns three empty groups, not an error', async () => {
  const res = await api('/api/search?q=zzznomatchzzz999', {}, adminToken);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { trfs: [], analysis: [], coas: [] });
});

maybe('a one-character term is refused with a readable message', async () => {
  const res = await api('/api/search?q=a', {}, adminToken);
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'BAD_REQUEST');
  assert.match(res.body.error.message, /at least 2 characters/i);
});

maybe('search requires a signed-in user', async () => {
  const res = await api(`/api/search?q=${MARKER}`);
  assert.equal(res.status, 401, JSON.stringify(res.body));
});

maybe('a term containing SQL is treated as text, not as a query', async () => {
  const res = await api(`/api/search?q=${encodeURIComponent("'; DROP TABLE trfs; --")}`, {}, adminToken);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  // The table is still there, which is the point of the assertion.
  const check = await api('/api/trfs?pageSize=1', {}, adminToken);
  assert.equal(check.status, 200, JSON.stringify(check.body));
});

maybe('the search term is length limited', async () => {
  const res = await api(`/api/search?q=${'x'.repeat(200)}`, {}, adminToken);
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'BAD_REQUEST');
});
