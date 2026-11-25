import { strict as assert } from 'node:assert';
import { after, before, test, TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildApp } from '../app';
import { pool, isDatabaseReachable } from '../db';
import { runMigrations } from '../migrate';
import { hashPassword } from '../lib/password';

const dbReachable = isDatabaseReachable().catch(() => false);
let server: Server;
let baseUrl = '';

/** These tests exercise GET /api/settings/form against a real PostgreSQL database.
 *  Without a reachable database each one reports as skipped. */
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
  // Remove only the GM rows this file created; leave everything else alone.
  await pool.query(`DELETE FROM employees WHERE employee_code LIKE 'SETGM-%'`).catch(() => undefined);
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

async function ensureAdmin(): Promise<string> {
  const password = 'Settings-Test-Admin-42';
  await pool.query(
    `INSERT INTO employees (employee_code, full_name, email, username, password_hash, role)
     VALUES ('SETTINGS-ADMIN', 'Settings Test Admin', 'settings-admin@test.local', 'settingsadmin', $1, 'Admin')
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = TRUE, role = 'Admin'`,
    [await hashPassword(password)],
  );
  const res = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'settingsadmin', password }) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.accessToken as string;
}

let adminToken = '';

maybe('setup: an admin session exists', async () => {
  adminToken = await ensureAdmin();
  assert.ok(adminToken.length > 20);
});

/** Deactivate every GM so a scenario starts from a known empty GM population. */
async function clearActiveGms(): Promise<void> {
  await pool.query(`UPDATE employees SET is_active = FALSE WHERE designation = 'GM'`);
}

async function insertGm(code: string, fullName: string, active: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO employees (employee_code, full_name, email, username, password_hash, role, designation, is_active)
     VALUES ($1, $2, $3, $4, 'x', 'Manager', 'GM', $5)`,
    [code, fullName, `${code.toLowerCase()}@test.local`, code.toLowerCase(), active],
  );
}

maybe('the form settings name the active GM in approvedByName', async () => {
  await clearActiveGms();
  await insertGm('SETGM-ONE', 'Ramesh Iyer', true);

  const res = await api('/api/settings/form', {}, adminToken);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.approvedByName, 'Ramesh Iyer');
  // The existing header settings are still present alongside the new field.
  assert.equal(res.body.sopNo, 'QAQN-003:F1');
});

maybe('approvedByName is empty when there is no GM', async () => {
  await clearActiveGms();

  const res = await api('/api/settings/form', {}, adminToken);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.approvedByName, '');
});

maybe('an inactive GM is ignored, so approvedByName is empty', async () => {
  await clearActiveGms();
  await insertGm('SETGM-INACTIVE', 'Inactive GM', false);

  const res = await api('/api/settings/form', {}, adminToken);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.approvedByName, '');
});

maybe('the form settings need a signed-in employee with trf.view', async () => {
  const anon = await api('/api/settings/form');
  assert.equal(anon.status, 401);
});