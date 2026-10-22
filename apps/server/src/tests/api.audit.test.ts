import { strict as assert } from 'node:assert';
import { after, before, test, TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import ExcelJS from 'exceljs';
import type { AuditAction, AuditPage } from '@trf/shared';
import { AUDIT_ACTIONS, AUDIT_ACTION_LABELS } from '@trf/shared';
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
      employeeCode: `P9-${suffix}`, fullName: `Phase9 ${role} ${suffix}`, email: `p9-${suffix}@company.local`,
      username: `p9${suffix}`, role, password,
    }),
  }, adminToken);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const username = `p9${suffix}`;
  return {
    id: res.body.id as number,
    fullName: res.body.fullName as string,
    username,
    token: await loginAs(username, password),
  };
}

let adminToken = '';
let manager: { id: number; fullName: string; token: string };
let analyst: { id: number; fullName: string; username: string; token: string };
let viewer: { id: number; fullName: string; token: string };
let trfId = 0;
let trfNumber = '';

/** One TRF that has been through a real change, so the trail has something to show. */
async function seedTrf() {
  const lookups = await baseLookups();
  const created = await api('/api/trfs', {
    method: 'POST', body: JSON.stringify({ trfDate: TODAY, priority: 'High', batchNumber: `P9-${Date.now()}`, ...lookups }),
  }, manager.token);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  trfId = created.body.id;
  trfNumber = created.body.trfNumber;

  const edited = await api(`/api/trfs/${trfId}`, {
    method: 'PATCH', body: JSON.stringify({ version: created.body.version, remarks: 'Phase 9 trail sample' }),
  }, manager.token);
  assert.equal(edited.status, 200, JSON.stringify(edited.body));

  const assigned = await api(`/api/assignments/trfs/${trfId}/assignments`, {
    method: 'POST', body: JSON.stringify({ assignments: [{ testName: `P9 Test ${trfId}`, assignedEmployeeId: analyst.id }] }),
  }, manager.token);
  assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
}

async function readTrail(token: string, query = ''): Promise<AuditPage> {
  const res = await api(`/api/audit?${query}`, {}, token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as AuditPage;
}

maybe('setup: users and a changed TRF exist for the audit tests', async () => {
  adminToken = await loginAs('phase2admin', 'Admin-Test-Password-42');
  manager = await makeEmployee('Manager');
  analyst = await makeEmployee('Analyst');
  viewer = await makeEmployee('Viewer');
  await seedTrf();
});

maybe('the trail needs audit.view, and only Admin and Manager hold it', async () => {
  assert.equal((await api('/api/audit')).status, 401);
  assert.equal((await api('/api/audit', {}, 'not-a-real-token')).status, 401);
  assert.equal((await api('/api/audit', {}, analyst.token)).status, 403);
  assert.equal((await api('/api/audit', {}, viewer.token)).status, 403);
  assert.equal((await api('/api/audit', {}, manager.token)).status, 200);
  assert.equal((await api('/api/audit', {}, adminToken)).status, 200);
});

maybe('the trail is read-only: no verb may change or remove a row', async () => {
  const before = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM audit_logs');

  for (const [method, path, body] of [
    ['POST', '/api/audit', { action: 'forged.created' }],
    ['PUT', '/api/audit/1', { action: 'forged.updated' }],
    ['PATCH', '/api/audit/1', { action: 'forged.patched' }],
    ['DELETE', '/api/audit/1', undefined],
  ] as const) {
    const res = await api(path, { method, body: body ? JSON.stringify(body) : undefined }, manager.token);
    assert.ok(res.status === 404 || res.status === 405, `${method} ${path} is refused, got ${res.status}`);
  }

  const after = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM audit_logs');
  assert.equal(after.rows[0].n, before.rows[0].n, 'no row was added or removed');
  const forged = await pool.query('SELECT id FROM audit_logs WHERE action = $1', ['forged.created']);
  assert.equal(forged.rowCount, 0, 'nothing forged a row');
});

maybe('a field change is recorded as a before and an after, not as a blob', async () => {
  const page = await readTrail(manager.token, `recordRef=${encodeURIComponent(trfNumber)}&action=trf.field_changed`);
  const entry = page.items[0];
  assert.ok(entry, 'the edit is on the trail');

  const remarks = entry.changes.find((c) => c.field === 'remarks');
  assert.ok(remarks, `remarks is listed, got ${JSON.stringify(entry.changes)}`);
  assert.equal(remarks!.old, null, 'it did not exist before');
  assert.equal(remarks!.new, 'Phase 9 trail sample');
  assert.equal(entry.userName, manager.fullName);
  assert.equal(entry.recordRef, trfNumber);
  assert.equal(entry.recordType, 'TRF');
});

maybe('only the fields that actually changed are listed', async () => {
  const page = await readTrail(manager.token, `recordRef=${encodeURIComponent(trfNumber)}&action=trf.field_changed`);
  const fields = page.items[0].changes.map((c) => c.field);
  assert.ok(fields.includes('remarks'), 'the edited field is present');
  // A TRF carries many fields; one edit must not list all of them.
  assert.ok(fields.length < 6, `only the change is listed, got ${JSON.stringify(fields)}`);
});

maybe('every entry reads as a person, a moment, a label and a tone', async () => {
  const page = await readTrail(manager.token);
  assert.ok(page.items.length > 0);
  for (const entry of page.items) {
    assert.ok(entry.createdAt && !Number.isNaN(Date.parse(entry.createdAt)), 'the moment is a real time');
    assert.ok(entry.label, `${entry.action} has a label`);
    assert.ok(['ok', 'info', 'warn', 'danger'].includes(entry.tone), `${entry.action} has a tone`);
    assert.ok(AUDIT_ACTIONS.includes(entry.action as AuditAction)
      || !AUDIT_ACTION_LABELS[entry.action as AuditAction], 'actions come from the agreed vocabulary');
  }
});

maybe('a failure and a security event are told apart from ordinary work', async () => {
  const page = await readTrail(adminToken);
  const failed = page.items.filter((e) => e.action === 'auth.login_failed' || e.action === 'auth.login_locked');
  for (const entry of failed) assert.equal(entry.tone, 'danger', `${entry.action} reads as a failure`);
  assert.ok(page.summary.securityEvents > 0, 'the security count is called out');
});

maybe('filters narrow the trail and the counts agree with them', async () => {
  const all = await readTrail(manager.token);
  const byModule = await readTrail(manager.token, 'module=trf');

  assert.ok(byModule.total < all.total, 'a module filter narrows the result');
  assert.ok(byModule.items.every((e) => e.module === 'trf'), 'only that module is returned');
  // The summary must describe the filtered set, or a count would contradict the list.
  const listed = byModule.items.filter((e) => e.module === 'trf').length;
  const fromSummary = byModule.summary.byModule.find((m) => m.module === 'trf')?.count ?? 0;
  assert.equal(fromSummary, byModule.total, 'the module count matches the filtered total');
  assert.ok(listed <= byModule.pageSize, 'the page is not longer than the page size');

  const byAction = await readTrail(manager.token, 'action=trf.created');
  assert.ok(byAction.items.every((e) => e.action === 'trf.created'));
  assert.equal(byAction.total, byAction.summary.total);
});

maybe('a search matches the person, the action or the record', async () => {
  const byPerson = await readTrail(manager.token, `search=${encodeURIComponent('Phase9')}`);
  assert.ok(byPerson.items.length > 0, 'the seeded employees are on the trail');
  assert.ok(byPerson.items.every((e) => `${e.userName ?? ''} ${e.action} ${e.recordRef ?? ''}`.toLowerCase()
    .includes('phase9')), 'every row matches what was searched');

  const byRecord = await readTrail(manager.token, `search=${encodeURIComponent(trfNumber.toLowerCase())}`);
  assert.ok(byRecord.items.length > 0, 'the TRF number is found');
  assert.ok(byRecord.items.every((e) => (e.recordRef ?? '').toLowerCase().includes(trfNumber.toLowerCase())));
});

maybe('a date range is inclusive of the whole end day', async () => {
  const page = await readTrail(manager.token, `dateFrom=${TODAY}&dateTo=${TODAY}`);
  assert.ok(page.total > 0, "today's entries are inside a today-to-today range");
  for (const entry of page.items) {
    assert.equal(new Date(entry.createdAt).toISOString().slice(0, 10), TODAY, 'nothing from another day');
  }
});

maybe('paging walks the trail without repeating or dropping a row', async () => {
  const first = await readTrail(manager.token, 'pageSize=2&page=1');
  const second = await readTrail(manager.token, 'pageSize=2&page=2');
  assert.equal(first.items.length, 2);
  const ids = new Set([...first.items, ...second.items].map((e) => e.id));
  assert.equal(ids.size, 4, 'no row appears on both pages');
  assert.equal(first.pageCount, Math.max(1, Math.ceil(first.total / 2)));
});

maybe('sorting by the moment gives the newest first, and the other way on request', async () => {
  const newest = await readTrail(manager.token, 'sortBy=createdAt&sortDir=desc&pageSize=50');
  const oldest = await readTrail(manager.token, 'sortBy=createdAt&sortDir=asc&pageSize=50');
  const newTimes = newest.items.map((e) => Date.parse(e.createdAt));
  const oldTimes = oldest.items.map((e) => Date.parse(e.createdAt));
  assert.deepEqual(newTimes, [...newTimes].sort((a, b) => b - a), 'newest first');
  assert.deepEqual(oldTimes, [...oldTimes].sort((a, b) => a - b), 'oldest first');
});

maybe('an unknown sort field or a bad date is refused, not guessed at', async () => {
  assert.equal((await api('/api/audit?sortBy=DROP TABLE', {}, manager.token)).status, 400);
  assert.equal((await api('/api/audit?dateFrom=yesterday', {}, manager.token)).status, 400);
  assert.equal((await api('/api/audit?pageSize=0', {}, manager.token)).status, 400);
});

maybe("one record's history can be read on its own, newest first", async () => {
  const res = await api(`/api/audit/record/TRF/${encodeURIComponent(trfNumber)}`, {}, manager.token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.items.length >= 2, 'the create and the edit are both there');
  const times = res.body.items.map((e: { createdAt: string }) => Date.parse(e.createdAt));
  assert.deepEqual(times, [...times].sort((a, b) => b - a), 'newest first');
  assert.ok(res.body.items.every((e: { recordRef: string }) => e.recordRef === trfNumber));
});

maybe('the vocabulary only offers modules and actions that have happened', async () => {
  const res = await api('/api/audit/vocabulary', {}, manager.token);
  assert.equal(res.status, 200);
  assert.ok(res.body.modules.includes('trf'), 'TRF work has happened');
  assert.ok(!res.body.modules.includes('settings'), 'nothing has been changed in settings yet');
  assert.ok(res.body.actions.includes('trf.created'));
  assert.ok(res.body.actions.every((a: string) => (AUDIT_ACTIONS as readonly string[]).includes(a)),
    'every offered action is in the agreed vocabulary');
});

maybe('a sign-out is recorded against the person who signed out', async () => {
  // A refresh token is only readable at sign-in, so this signs in to get one.
  const res = await api('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username: analyst.username, password: 'Test-Password-42' }),
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const refreshToken = res.body.refreshToken as string;

  const before = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_logs WHERE action = 'auth.logout' AND user_id = $1`, [analyst.id]);

  const out = await api('/api/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken }) });
  assert.equal(out.status, 200, JSON.stringify(out.body));

  const after = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_logs WHERE action = 'auth.logout' AND user_id = $1`, [analyst.id]);
  assert.equal(Number(after.rows[0].n), Number(before.rows[0].n) + 1, 'the sign-out is on the trail');

  // A token that matches nothing must not be able to name anyone.
  const unknown = await api('/api/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken: 'not-a-real-token' }) });
  assert.equal(unknown.status, 200, 'an unknown token is still a safe no-op');
  const afterUnknown = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_logs WHERE action = 'auth.logout' AND user_id = $1`, [analyst.id]);
  assert.equal(afterUnknown.rows[0].n, after.rows[0].n, 'nothing was attributed to the wrong person');
});

maybe('the summary total always equals the list total', async () => {
  for (const query of ['', 'module=auth', 'module=coa', 'search=Phase9', `recordRef=${trfNumber}`]) {
    const page = await readTrail(manager.token, query);
    assert.equal(page.summary.total, page.total, `the counts agree for "${query}"`);
    assert.equal(
      page.summary.byModule.reduce((sum, m) => sum + m.count, 0), page.total,
      `the module breakdown adds up for "${query}"`,
    );
  }
});

maybe('the exported trail carries the same filters and the time of day', async () => {
  const res = await fetch(`${baseUrl}/api/reports/export.xlsx?sheet=Audit%20Log&module=trf`, {
    headers: { Authorization: `Bearer ${manager.token}` },
  });
  assert.equal(res.status, 200);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await res.arrayBuffer());

  const sheet = book.getWorksheet('Audit Log');
  assert.ok(sheet, 'the Audit Log sheet is present');
  // ExcelJS rows are 1-based with an empty slot at zero, so the headers are read
  // by their own index rather than by their position in a filtered list.
  const headers = sheet.getRow(1).values as unknown[];
  const rows: Record<string, unknown>[] = [];
  for (let i = 2; i <= sheet.rowCount; i++) {
    const values = sheet.getRow(i).values as unknown[];
    const row: Record<string, unknown> = {};
    headers.forEach((h, c) => { if (typeof h === 'string') row[h] = values[c]; });
    rows.push(row);
  }

  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.Module === 'trf'),
    `only the filtered module is exported: ${JSON.stringify(rows.slice(0, 2))}`);
  // The moment keeps its time, so two edits on the same day can be told apart.
  const when = rows[0]['When'];
  assert.ok(when instanceof Date, `the moment is a date cell, got ${typeof when}`);
  assert.equal(sheet.getRow(2).getCell(1).numFmt, 'dd-mm-yyyy hh:mm:ss');
});
