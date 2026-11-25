import { strict as assert } from 'node:assert';
import { after, before, test, TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildApp } from '../app';
import { pool, isDatabaseReachable } from '../db';
import { runMigrations } from '../migrate';
import { baseLookups, ensureAdmin, assignOverdueTest } from './fixtures';
import { hashPassword } from '../lib/password';

const dbReachable = isDatabaseReachable().catch(() => false);
let server: Server;
let baseUrl = '';

/** No database means skipped, never a false pass. */
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

/** Inserts an individual employee directly (so any role/designation/team is possible). */
async function makeUser(
  role: string,
  opts: { designation?: string | null; department?: string | null; team?: 'FRD' | 'ARD' | null } = {},
) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const password = 'Test-Password-42';
  const username = `tv${suffix}`;
  let departmentId: number | null = null;
  if (opts.department) {
    const dept = await pool.query<{ id: number }>(`SELECT id FROM departments WHERE name = $1`, [opts.department]);
    departmentId = dept.rows[0]?.id ?? null;
  }
  const res = await pool.query<{ id: number }>(
    `INSERT INTO employees (employee_code, full_name, email, username, password_hash, role, designation, department_id, team, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE) RETURNING id`,
    [`TV-${suffix}`, `Team View ${role} ${suffix}`, `tv-${suffix}@company.local`, username,
      await hashPassword(password), role, opts.designation ?? null, departmentId, opts.team ?? null],
  );
  const id = res.rows[0].id;
  return { id, username, token: await loginAs(username, password) };
}

async function makeTrf(token: string, overrides: Record<string, unknown> = {}) {
  const lookups = await baseLookups();
  const res = await api('/api/trfs', {
    method: 'POST',
    body: JSON.stringify({ trfDate: TODAY, priority: 'Normal', ...lookups, ...overrides }),
  }, token);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as { id: number; trfNumber: string };
}

async function cleanup(trfIds: number[], employeeIds: number[]) {
  if (trfIds.length) await pool.query('DELETE FROM trfs WHERE id = ANY($1)', [trfIds]);
  if (employeeIds.length) await pool.query('DELETE FROM employees WHERE id = ANY($1)', [employeeIds]);
}

let adminToken = '';
let manager: { id: number; token: string };
let analyst: { id: number; token: string };
let viewer: { id: number; token: string };
let ardZero: { id: number; token: string };
let frdZero: { id: number; token: string };
let frdCreator: { id: number; token: string };
const createdTrfs: number[] = [];
const createdEmployees: number[] = [];

maybe('setup: role users and zero-work employees exist', async () => {
  adminToken = await ensureAdmin();
  manager = await makeUser('Manager');
  analyst = await makeUser('Analyst');
  viewer = await makeUser('Viewer');
  ardZero = await makeUser('Analyst', { department: 'ARD' });
  frdZero = await makeUser('Analyst', { department: 'Formulation' });
  frdCreator = await makeUser('Manager', { department: 'Formulation' });
  createdEmployees.push(manager.id, analyst.id, viewer.id, ardZero.id, frdZero.id, frdCreator.id);
});

maybe('FRD endpoints are forbidden for Manager, Analyst and Viewer', async () => {
  for (const u of [manager, analyst, viewer]) {
    const res = await api('/api/frd/employees', {}, u.token);
    assert.equal(res.status, 403, `${u.id} should be forbidden`);
  }
});

maybe('FRD endpoints are allowed for a higher authority (Admin)', async () => {
  // GM/AGM were folded into Admin (migration 017), so Admin is the higher-
  // authority role that can exist; requireHigherAuthority also accepts GM/AGM.
  const res = await api('/api/frd/employees', {}, adminToken);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(Array.isArray(res.body.items));
});

maybe('the ARD list and detail are allowed for a Manager', async () => {
  const list = await api('/api/ard-assignments/employees', {}, manager.token);
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const detail = await api(`/api/ard-assignments/employees/${ardZero.id}`, {}, manager.token);
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
});

maybe('the ARD list includes an employee with no assignments', async () => {
  const res = await api('/api/ard-assignments/employees', {}, adminToken);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const row = res.body.items.find((r: { employeeId: number }) => r.employeeId === ardZero.id);
  assert.ok(row, 'the zero-work ARD employee is listed');
  assert.equal(row.testsAssigned, 0);
  assert.equal(row.assignedTrfs, 0);
});

maybe('the FRD list includes an employee who has created no TRFs', async () => {
  const res = await api('/api/frd/employees', {}, adminToken);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const row = res.body.items.find((r: { employeeId: number }) => r.employeeId === frdZero.id);
  assert.ok(row, 'the zero-TRF FRD employee is listed');
  assert.equal(row.trfsCreated, 0);
});

maybe('the createdBy filter returns only TRFs created by that employee', async () => {
  const t1 = await makeTrf(frdCreator.token);
  const t2 = await makeTrf(frdCreator.token);
  createdTrfs.push(t1.id, t2.id);
  const res = await api(`/api/trfs?createdBy=${frdCreator.id}`, {}, adminToken);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.items.length >= 2);
  assert.ok(res.body.items.every((t: { createdBy: number | null }) => t.createdBy === frdCreator.id));
});

maybe('the FRD detail summary counts the whole set when there are more than 25 rows', async () => {
  const maker = await makeUser('Manager', { department: 'Formulation' });
  createdEmployees.push(maker.id);
  const ids: number[] = [];
  for (let i = 0; i < 30; i++) {
    const t = await makeTrf(maker.token);
    ids.push(t.id);
  }
  createdTrfs.push(...ids);
  const res = await api(`/api/frd/employees/${maker.id}?pageSize=25`, {}, adminToken);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.summary.trfsCreated, 30, 'summary counts the whole set');
  assert.equal(res.body.total, 30);
  assert.equal(res.body.items.length, 25, 'the page is capped at 25');
  assert.equal(res.body.pageCount, 2);
});

maybe('the list and detail overdue figures use the same definition', async () => {
  const emp = await makeUser('Analyst', { department: 'ARD' });
  createdEmployees.push(emp.id);
  const trf = await makeTrf(adminToken);
  createdTrfs.push(trf.id);
  await assignOverdueTest(trf.id, emp.id, inDays(-2));

  const list = await api('/api/ard-assignments/employees', {}, adminToken);
  const listRow = list.body.items.find((r: { employeeId: number }) => r.employeeId === emp.id);
  assert.ok(listRow, 'the employee is listed');
  const detail = await api(`/api/ard-assignments/employees/${emp.id}`, {}, adminToken);
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.ok(listRow.overdue >= 1, 'the list shows the overdue test');
  assert.equal(detail.body.summary.overdue, listRow.overdue, 'list and detail overdue agree');
});

maybe('cleanup: remove the rows these tests created', async () => {
  await cleanup(createdTrfs, createdEmployees);
});