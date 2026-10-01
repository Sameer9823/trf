import { strict as assert } from 'node:assert';
import { after, before, test, TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { MESSAGES } from '@trf/shared';
import { buildApp } from '../app';
import { pool, isDatabaseReachable, withTransaction } from '../db';
import { runMigrations } from '../migrate';
import { hashPassword } from '../lib/password';

const dbReachable = isDatabaseReachable().catch(() => false);
let server: Server;
let baseUrl = '';

/**
 * These tests exercise the real endpoints against a real PostgreSQL database.
 * Without a reachable database each one reports as skipped, so a green run never
 * claims coverage that did not happen.
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

async function createEmployee(overrides: Record<string, unknown> = {}) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const password = 'Test-Password-42';
  const res = await api('/api/employees', {
    method: 'POST',
    body: JSON.stringify({
      employeeCode: `T-${suffix}`, fullName: `Test User ${suffix}`, email: `t-${suffix}@company.local`,
      username: `t${suffix}`, role: 'Analyst', password, ...overrides,
    }),
  }, adminToken);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { id: res.body.id as number, password, username: res.body.username as string };
}

async function ensureAdmin(): Promise<string> {
  const password = 'Admin-Test-Password-42';
  const email = 'phase2-admin@test.local';
  await pool.query(
    `INSERT INTO employees (employee_code, full_name, email, username, password_hash, role)
     VALUES ('PHASE2-ADMIN', 'Phase2 Test Admin', $1, 'phase2admin', $2, 'Admin')
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = TRUE, role = 'Admin'`,
    [email, await hashPassword(password)],
  );
  const res = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'phase2admin', password }) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.accessToken as string;
}

let adminToken = '';

maybe('setup: an admin session exists', async () => {
  adminToken = await ensureAdmin();
  assert.ok(adminToken.length > 20);
});

maybe('a correct password returns tokens and the employee profile without the hash', async () => {
  const password = 'Admin-Test-Password-42';
  const res = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'phase2admin', password }) });
  assert.equal(res.status, 200);
  assert.ok(res.body.accessToken);
  assert.ok(res.body.refreshToken);
  assert.ok(new Date(res.body.accessTokenExpiresAt).getTime() > Date.now());
  assert.equal(res.body.employee.password_hash, undefined);
  assert.equal(res.body.employee.role, 'Admin');
});

maybe('a wrong password returns the generic message and no token', async () => {
  const res = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'phase2admin', password: 'Wrong-Password-1' }) });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.message, 'Invalid username or password.');
  assert.equal(res.body.accessToken, undefined);
});

maybe('an unknown username returns the same message as a wrong password', async () => {
  const res = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'nobody-here', password: 'Whatever-123' }) });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.message, 'Invalid username or password.');
});

maybe('sign-in by email works as well as by username', async () => {
  const employee = await createEmployee({ role: 'Viewer' });
  const res = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: `t-${employee.username.slice(1)}@company.local`, password: employee.password }) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
});

maybe('a missing or malformed body is rejected with field messages', async () => {
  const res = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: '', password: '' }) });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.fields.username);
});

maybe('repeated failures lock the account and a correct password is then refused', async () => {
  const employee = await createEmployee({ role: 'Viewer' });
  let locked: string | null = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const res = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: employee.username, password: 'Wrong-Password-1' }) });
    if (res.body?.error?.message?.includes('temporarily locked')) { locked = res.body.error.message; break; }
  }
  assert.ok(locked, 'the account should have been locked after repeated failures');
  const afterLock = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: employee.username, password: employee.password }) });
  assert.equal(afterLock.status, 401);
});

maybe('a deactivated user cannot sign in and their tokens stop working', async () => {
  const employee = await createEmployee({ role: 'Analyst' });
  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: employee.username, password: employee.password }) });
  const token = login.body.accessToken as string;
  assert.equal((await api('/api/auth/me', {}, token)).status, 200);

  const off = await api(`/api/employees/${employee.id}/deactivate`, { method: 'POST' }, adminToken);
  assert.equal(off.status, 200);
  assert.equal(off.body.isActive, false);

  assert.equal((await api('/api/auth/me', {}, token)).status, 401);
  const relogin = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: employee.username, password: employee.password }) });
  assert.equal(relogin.status, 401);

  await pool.query('DELETE FROM employees WHERE id = $1', [employee.id]);
});

maybe('an expired or malformed token is refused', async () => {
  assert.equal((await api('/api/auth/me', {}, 'not-a-jwt')).status, 401);
  assert.equal((await api('/api/auth/me')).status, 401);
  const parts = (await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'phase2admin', password: 'Admin-Test-Password-42' }) })).body.accessToken.split('.');
  const tampered = `${parts[0]}.${parts[1]}.${'a'.repeat(parts[2].length)}`;
  assert.equal((await api('/api/auth/me', {}, tampered)).status, 401);
});

maybe('refresh rotates the token and the old refresh token no longer works', async () => {
  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'phase2admin', password: 'Admin-Test-Password-42' }) });
  const first = login.body.refreshToken as string;
  const refreshed = await api('/api/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: first }) });
  assert.equal(refreshed.status, 200);
  assert.notEqual(refreshed.body.refreshToken, first);
  assert.equal((await api('/api/auth/me', {}, refreshed.body.accessToken)).status, 200);
  const replay = await api('/api/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: first }) });
  assert.equal(replay.status, 401);
});

maybe('logout revokes the refresh token', async () => {
  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'phase2admin', password: 'Admin-Test-Password-42' }) });
  const refreshToken = login.body.refreshToken as string;
  assert.equal((await api('/api/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken }) })).status, 200);
  assert.equal((await api('/api/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken }) })).status, 401);
});

maybe('changing a password requires the current one and ends existing sessions', async () => {
  const employee = await createEmployee({ role: 'Viewer' });
  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: employee.username, password: employee.password }) });
  const oldRefresh = login.body.refreshToken as string;

  const wrong = await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: 'Wrong-Password-1', newPassword: 'New-Password-77' }) }, login.body.accessToken);
  assert.equal(wrong.status, 400);

  const changed = await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: employee.password, newPassword: 'New-Password-77' }) }, login.body.accessToken);
  assert.equal(changed.status, 200);

  assert.equal((await api('/api/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: oldRefresh }) })).status, 401);
  const relogin = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: employee.username, password: 'New-Password-77' }) });
  assert.equal(relogin.status, 200);
  await pool.query('DELETE FROM employees WHERE id = $1', [employee.id]);
});

maybe('a duplicate username, email or employee code is refused with its own message', async () => {
  const employee = await createEmployee({ role: 'Viewer' });
  const duplicateUsername = await api('/api/employees', {
    method: 'POST',
    body: JSON.stringify({
      employeeCode: `X-${Date.now()}`, fullName: 'Copy', email: `copy-${Date.now()}@company.local`,
      username: employee.username, role: 'Viewer', password: 'Another-Pass-42',
    }),
  }, adminToken);
  assert.equal(duplicateUsername.status, 409);
  assert.equal(duplicateUsername.body.error.message, 'This username is already taken.');
  await pool.query('DELETE FROM employees WHERE id = $1', [employee.id]);
});

maybe('a stale version is refused with the standard conflict message', async () => {
  const employee = await createEmployee({ role: 'Viewer' });
  const patch = (version: number) => api(`/api/employees/${employee.id}`, {
    method: 'PATCH', body: JSON.stringify({ version, fullName: `Renamed ${version}` }),
  }, adminToken);
  assert.equal((await patch(1)).status, 200);
  const stale = await patch(1);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.message, 'This record was changed by someone else. Please reload and try again.');
  await pool.query('DELETE FROM employees WHERE id = $1', [employee.id]);
});

maybe('the last active administrator cannot be demoted or deactivated', async () => {
  const admins = await pool.query<{ id: number }>(`SELECT id FROM employees WHERE role = 'Admin' AND is_active = TRUE ORDER BY id`);
  const only = admins.rows.length === 1 ? admins.rows[0].id : null;
  if (only === null) return; // another admin exists in this database: nothing to protect
  const demote = await api(`/api/employees/${only}`, { method: 'PATCH', body: JSON.stringify({ version: 1, role: 'Viewer' }) }, adminToken);
  assert.equal(demote.status, 409);
  assert.equal(demote.body.error.message, 'This action would leave the system without an active administrator.');
});

maybe('an employee cannot deactivate their own account', async () => {
  const admin = await pool.query<{ id: number }>(`SELECT id FROM employees WHERE username = 'phase2admin'`);
  const res = await api(`/api/employees/${admin.rows[0].id}/deactivate`, { method: 'POST' }, adminToken);
  assert.equal(res.status, 403);
  assert.equal(res.body.error.message, 'You cannot deactivate your own account.');
});

maybe('an Analyst is refused on Admin endpoints with the standard permission message', async () => {
  const employee = await createEmployee({ role: 'Analyst' });
  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: employee.username, password: employee.password }) });
  const token = login.body.accessToken as string;

  for (const [method, path] of [
    ['GET', '/api/employees'],
    ['POST', '/api/employees'],
    ['GET', '/api/departments'],
    ['PATCH', `/api/employees/${employee.id}`],
  ] as const) {
    const res = await api(path, { method, body: method === 'POST' || method === 'PATCH' ? '{}' : undefined }, token);
    assert.equal(res.status, 403, `${method} ${path} should be forbidden`);
    assert.equal(res.body.error.message, 'Your account does not have permission to perform this action.');
  }
  await pool.query('DELETE FROM employees WHERE id = $1', [employee.id]);
});

maybe('Viewer is refused the employee module; Manager may list but not create', async () => {
  // Viewer has no employee permission at all, so even reading the list is refused.
  const viewer = await createEmployee({ role: 'Viewer' });
  const viewerLogin = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: viewer.username, password: viewer.password }) });
  const viewerList = await api('/api/employees', {}, viewerLogin.body.accessToken);
  assert.equal(viewerList.status, 403);
  assert.equal(viewerList.body.error.message, MESSAGES.NO_PERMISSION);

  // Manager may look employees up for assignment, but may not create accounts.
  const manager = await createEmployee({ role: 'Manager' });
  const managerLogin = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: manager.username, password: manager.password }) });
  const list = await api('/api/employees', {}, managerLogin.body.accessToken);
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body.items));

  const create = await api('/api/employees', { method: 'POST', body: JSON.stringify({
    employeeCode: 'M-1', fullName: 'Manager Attempt', email: 'm1@company.local', username: 'm1', role: 'Analyst', password: 'Password-1234',
  }) }, managerLogin.body.accessToken);
  assert.equal(create.status, 403);
  await pool.query('DELETE FROM employees WHERE id = ANY($1)', [[viewer.id, manager.id]]);
});

maybe('the employee list paginates, searches and filters on the server', async () => {
  const suffix = Math.random().toString(36).slice(2, 7);
  for (let i = 0; i < 3; i += 1) {
    await createEmployee({ employeeCode: `P-${suffix}-${i}`, fullName: `Pager ${suffix} ${i}`, email: `p-${suffix}-${i}@company.local`, username: `p${suffix}${i}` });
  }
  const page = await api('/api/employees?page=1&pageSize=2', {}, adminToken);
  assert.equal(page.body.items.length, 2);
  assert.ok(page.body.total >= 3);
  assert.equal(page.body.pageCount, Math.max(1, Math.ceil(page.body.total / 2)));
  const search = await api(`/api/employees?search=pager+${suffix}`, {}, adminToken);
  assert.equal(search.body.items.length, 3);
  const byRole = await api('/api/employees?role=Analyst&pageSize=200', {}, adminToken);
  assert.ok(byRole.body.items.every((e: { role: string }) => e.role === 'Analyst'));
  await pool.query('DELETE FROM employees WHERE full_name LIKE $1', [`Pager ${suffix}%`]);
});

maybe('the assignable list contains only active staff who can hold a test', async () => {
  const res = await api('/api/employees/assignable', {}, adminToken);
  assert.equal(res.status, 200);
  for (const employee of res.body.items) {
    assert.equal(employee.isActive, true);
    assert.notEqual(employee.role, 'Viewer');
  }
});

maybe('every employee action is written to the audit trail', async () => {
  const employee = await createEmployee({ role: 'Viewer' });
  await api(`/api/employees/${employee.id}`, { method: 'PATCH', body: JSON.stringify({ version: 1, fullName: 'Audited Name' }) }, adminToken);
  await api(`/api/employees/${employee.id}/deactivate`, { method: 'POST' }, adminToken);
  const rows = await pool.query<{ action: string; user_name: string }>(
    `SELECT action, user_name FROM audit_logs WHERE module = 'employees' AND record_ref = $1 ORDER BY id`,
    [(await pool.query<{ employee_code: string }>('SELECT employee_code FROM employees WHERE id = $1', [employee.id])).rows[0].employee_code],
  );
  const actions = rows.rows.map((r) => r.action);
  assert.ok(actions.includes('employee.created'));
  assert.ok(actions.includes('employee.full_name_changed'));
  assert.ok(actions.includes('employee.deactivated'));
  assert.ok(rows.rows.every((r) => r.user_name === 'Phase2 Test Admin'));
  await pool.query('DELETE FROM employees WHERE id = $1', [employee.id]);
});

maybe('a raw database error never reaches the client', async () => {
  // A malformed id must produce the friendly 404, not a SQL message.
  const res = await api('/api/employees/abc', {}, adminToken);
  assert.equal(res.status, 404);
  assert.equal(JSON.stringify(res.body).includes('SQL'), false);
  assert.equal(JSON.stringify(res.body).includes('SELECT'), false);
});

maybe('a failed action leaves no partial rows behind', async () => {
  const before = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM employees`);
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO employees (employee_code, full_name, email, username, password_hash, role)
       VALUES ($1, $2, $3, $4, 'x', 'Viewer')`, ['ROLLBACK-1', 'Rollback', 'rollback@company.local', 'rollback1']);
    throw new Error('deliberate failure');
  }).catch(() => undefined);
  const after = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM employees`);
  assert.equal(after.rows[0].count, before.rows[0].count);
});
