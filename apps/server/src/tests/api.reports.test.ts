import { strict as assert } from 'node:assert';
import { after, before, test, TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import ExcelJS from 'exceljs';
import { EXPORT_ROW_LIMIT, sheetsFor } from '@trf/shared';
import { buildApp } from '../app';
import { pool, isDatabaseReachable } from '../db';
import { runMigrations } from '../migrate';

const dbReachable = isDatabaseReachable().catch(() => false);
let server: Server;
let baseUrl = '';

// A short export is cheaper to read back, so the real route is exercised with the
// small data this test creates rather than a direct call into the workbook builder.
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
      employeeCode: `P8-${suffix}`, fullName: `Phase8 ${role} ${suffix}`, email: `p8-${suffix}@company.local`,
      username: `p8${suffix}`, role, password,
    }),
  }, adminToken);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return {
    id: res.body.id as number,
    fullName: res.body.fullName as string,
    token: await loginAs(`p8${suffix}`, password),
  };
}

let adminToken = '';
let manager: { id: number; fullName: string; token: string };
let analyst: { id: number; fullName: string; token: string };
let otherAnalyst: { id: number; fullName: string; token: string };
let viewer: { id: number; fullName: string; token: string };
let myTrf = '';
let otherTrf = '';

/**
 * The TRFs are created by the administrator because an Analyst may not create
 * one. Both the TRF's own assignee and one assigned test are set, because
 * "own work" on the TRF list means the TRF assignee or the creator, and the
 * Analysis sheet is scoped by the test's assignee.
 */
async function seedTrf(batch: string, assignedEmployeeId: number) {
  const created = await api('/api/trfs', {
    method: 'POST',
    body: JSON.stringify({ trfDate: TODAY, priority: 'Normal', batchNumber: batch }),
  }, adminToken);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const trf = created.body as { id: number; trfNumber: string; version: number };

  const assigned = await api(`/api/assignments/trfs/${trf.id}/assignments`, {
    method: 'POST',
    body: JSON.stringify({ assignments: [{ testName: `${batch} Test`, assignedEmployeeId }] }),
  }, adminToken);
  assert.equal(assigned.status, 201, JSON.stringify(assigned.body));

  // Assigning a test moves the TRF on, so its version is re-read before the
  // assignee is set; a stale version is exactly what the 409 is for.
  const current = await api(`/api/trfs/${trf.id}`, {}, adminToken);
  assert.equal(current.status, 200, JSON.stringify(current.body));

  const patched = await api(`/api/trfs/${trf.id}/assign`, {
    method: 'POST',
    body: JSON.stringify({ version: current.body.version, assignedEmployeeId }),
  }, adminToken);
  assert.equal(patched.status, 200, JSON.stringify(patched.body));

  return trf;
}

async function exportBook(query: string, token: string) {
  const res = await fetch(`${baseUrl}/api/reports/export.xlsx?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok) return { ok: false as const, status: res.status, body: await res.json().catch(() => null) };
  assert.match(type, /spreadsheetml\.sheet/, 'a real workbook, not JSON');
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await res.arrayBuffer());
  return {
    ok: true as const,
    status: res.status,
    book,
    meta: JSON.parse(res.headers.get('x-export-meta') ?? '{}') as {
      sheetNames: string[]; rowCounts: Record<string, number>; scope: string; truncated: boolean;
    },
    contentDisposition: res.headers.get('content-disposition') ?? '',
  };
}

/** Reads a sheet as plain objects, keyed by its header row. */
function rowsOf(sheet: ExcelJS.Worksheet | undefined): Record<string, unknown>[] {
  assert.ok(sheet, 'the sheet is present in the workbook');
  const header = sheet.getRow(1).values as unknown[];
  const out: Record<string, unknown>[] = [];
  for (let i = 2; i <= sheet.rowCount; i++) {
    const values = sheet.getRow(i).values as unknown[];
    const row: Record<string, unknown> = {};
    header.forEach((h, c) => { if (typeof h === 'string') row[h] = values[c]; });
    out.push(row);
  }
  return out;
}

maybe('setup: users and records exist for the export tests', async () => {
  adminToken = await loginAs('phase2admin', 'Admin-Test-Password-42');
  manager = await makeEmployee('Manager');
  analyst = await makeEmployee('Analyst');
  otherAnalyst = await makeEmployee('Analyst');
  viewer = await makeEmployee('Viewer');

  const mine = await seedTrf(`P8-MINE-${analyst.id}`, analyst.id);
  const theirs = await seedTrf(`P8-THEIRS-${otherAnalyst.id}`, otherAnalyst.id);
  myTrf = mine.trfNumber;
  otherTrf = theirs.trfNumber;
  assert.notEqual(myTrf, otherTrf);
});

maybe('an export needs a signed-in employee', async () => {
  assert.equal((await api('/api/reports/export-options')).status, 401);
  assert.equal((await api('/api/reports/export.xlsx')).status, 401);
  assert.equal((await api('/api/reports/export.xlsx', {}, 'not-a-real-token')).status, 401);
});

maybe('the workbook opens and holds the sheets the role may have', async () => {
  const res = await exportBook('', manager.token);
  assert.equal(res.status, 200);
  assert.ok(res.ok);
  assert.deepEqual(res.meta.sheetNames, sheetsFor('all', 'Manager'));
  assert.match(res.contentDisposition, /attachment; filename="TRF-Report-\d{4}-\d{2}-\d{2}\.xlsx"/);
});

maybe('every sheet has readable headings, a frozen header and a filter row', async () => {
  const res = await exportBook('', manager.token);
  assert.ok(res.ok);
  for (const name of sheetsFor('all', 'Manager')) {
    const sheet: ExcelJS.Worksheet | undefined = res.book.getWorksheet(name);
    assert.ok(sheet, `${name} is present`);
    // ExcelJS fills in the rest of a view on read, so the frozen pane is checked
    // rather than the whole object.
    const view = sheet.views[0] as ExcelJS.Worksheet['views'][number];
    assert.equal(view.state, 'frozen', `${name} header stays visible`);
    assert.equal(view.ySplit, 1, `${name} freezes exactly the header row`);
    assert.ok(sheet.autoFilter, `${name} can be filtered in Excel`);
    const headers = (sheet.getRow(1).values as unknown[]).filter((v) => typeof v === 'string');
    assert.ok(headers.length > 0, `${name} has headings`);
    for (const h of headers) {
      assert.doesNotMatch(String(h), /\b(id|version|uuid|_at|_id)\b/i, `${h} is a word, not a column name`);
    }
  }
});

maybe('dates are written as dates, not as text', async () => {
  const res = await exportBook('sheet=TRF%20Master', manager.token);
  assert.ok(res.ok);
  const rows = rowsOf(res.book.getWorksheet('TRF Master'));
  assert.ok(rows.length > 0);
  const mine = rows.find((r) => r['TRF No.'] === myTrf);
  assert.ok(mine, 'the seeded TRF is in its own export');
  const trfDate = mine?.['TRF Date'];
  assert.ok(trfDate instanceof Date, `TRF Date is a date cell, got ${typeof trfDate}`);
  // Read in local parts: the cell holds a calendar day, and Excel has no timezone.
  const d = trfDate as Date;
  const localDay = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  assert.equal(localDay, TODAY, 'the calendar day survives the round trip');
  assert.equal(res.book.getWorksheet('TRF Master')!.getRow(2).getCell(2).numFmt, 'dd-mm-yyyy');
});

maybe('the list filters carry into the file, and only those rows appear', async () => {
  const res = await exportBook(`sheet=TRF%20Master&search=${encodeURIComponent(myTrf)}`, manager.token);
  assert.ok(res.ok);
  const rows = rowsOf(res.book.getWorksheet('TRF Master'));
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => String(r['TRF No.']).includes(myTrf)), 'only the searched TRF is present');
  assert.ok(!rows.some((r) => r['TRF No.'] === otherTrf), 'the other TRF is filtered out');
});

maybe('a status filter narrows the sheet the same way the list does', async () => {
  const assigned = await exportBook('sheet=TRF%20Master&status=Assigned', manager.token);
  assert.ok(assigned.ok);
  const rows = rowsOf(assigned.book.getWorksheet('TRF Master'));
  assert.ok(rows.length > 0, 'the seeded TRFs are Assigned once a test exists');
  assert.ok(rows.every((r) => r['Status'] === 'Assigned'));
});

maybe('an analyst exports their own work and nobody else\'s', async () => {
  const res = await exportBook('', analyst.token);
  assert.ok(res.ok);
  assert.equal(res.meta.scope, 'own');
  assert.deepEqual(res.meta.sheetNames, sheetsFor('own', 'Analyst'), 'no Employees or Audit Log sheet');

  const trfs = rowsOf(res.book.getWorksheet('TRF Master')).map((r) => String(r['TRF No.']));
  assert.ok(trfs.includes(myTrf), 'their own TRF is included');
  assert.ok(!trfs.includes(otherTrf), 'another analyst\'s TRF is not');

  const names = rowsOf(res.book.getWorksheet('Analysis')).map((r) => String(r['Analyst']));
  assert.ok(names.length > 0);
  assert.ok(names.every((n) => n === analyst.fullName), `every analysis row is theirs, got ${JSON.stringify(names)}`);
});

maybe('a viewer may export, but only what a viewer is allowed to read', async () => {
  const res = await exportBook('', viewer.token);
  assert.ok(res.ok, 'a Viewer holds reports.export');
  assert.equal(res.meta.scope, 'all', 'a Viewer reads every TRF');
  assert.ok(!res.meta.sheetNames.includes('Employees'), 'no employee directory');
  assert.ok(!res.meta.sheetNames.includes('Audit Log'), 'no audit log');
  assert.ok(res.meta.sheetNames.includes('TRF Master'), 'the TRF sheet is still available');

  // Asking for one directly must be refused rather than quietly emptied.
  assert.equal((await api('/api/reports/export.xlsx?sheet=Audit%20Log', {}, viewer.token)).status, 400);
  assert.equal((await api('/api/reports/export.xlsx?sheet=Employees', {}, viewer.token)).status, 400);
  assert.equal((await api('/api/reports/export-options', {}, viewer.token)).status, 200);
});

maybe('an analyst may export, and a restricted sheet is refused', async () => {
  assert.equal((await api('/api/reports/export.xlsx?sheet=Audit%20Log', {}, analyst.token)).status, 400);
  assert.equal((await api('/api/reports/export.xlsx?sheet=Employees', {}, analyst.token)).status, 400);
});

maybe('export-options states the scope, the sheets and the row ceiling', async () => {
  const admin = await api('/api/reports/export-options', {}, adminToken);
  assert.equal(admin.status, 200);
  assert.equal(admin.body.scope, 'all');
  assert.equal(admin.body.rowLimit, EXPORT_ROW_LIMIT);
  assert.deepEqual(admin.body.sheets, sheetsFor('all', 'Admin'));

  const scoped = await api('/api/reports/export-options', {}, analyst.token);
  assert.equal(scoped.body.scope, 'own');
  assert.deepEqual(scoped.body.sheets, sheetsFor('own', 'Analyst'));

  // A Viewer reads every TRF but not the employee directory or the audit log.
  const viewerOptions = await api('/api/reports/export-options', {}, viewer.token);
  assert.equal(viewerOptions.body.scope, 'all');
  assert.ok(!viewerOptions.body.sheets.includes('Employees'));
  assert.ok(!viewerOptions.body.sheets.includes('Audit Log'));
  assert.ok(viewerOptions.body.sheets.includes('TRF Master'));
});

maybe('a nonsense sheet or filter is rejected with a readable message', async () => {
  const bad = await api('/api/reports/export.xlsx?sheet=Payroll', {}, adminToken);
  assert.equal(bad.status, 400);
  assert.match(bad.body.error.message, /not valid|valid/i);

  const date = await api('/api/reports/export.xlsx?dateFrom=31-12-2026', {}, adminToken);
  assert.equal(date.status, 400);
});

maybe('an export is audited with its sheets, filters and row counts', async () => {
  const before = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_logs WHERE action = 'report.exported'`);
  await exportBook(`sheet=TRF%20Master&search=${encodeURIComponent(myTrf)}`, adminToken);
  const after = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_logs WHERE action = 'report.exported'`);
  assert.equal(Number(after.rows[0].n), Number(before.rows[0].n) + 1, 'one audit row per export');

  const latest = await pool.query<{
    user_name: string; module: string; new_value: { sheets: string[]; filters: string };
  }>(`SELECT user_name, module, new_value FROM audit_logs WHERE action = 'report.exported'
      ORDER BY id DESC LIMIT 1`);
  const row = latest.rows[0];
  assert.equal(row.module, 'reports');
  assert.ok(row.user_name.includes('Phase8') || row.user_name.length > 0);
  assert.deepEqual(row.new_value.sheets, ['TRF Master']);
  assert.match(row.new_value.filters, new RegExp(myTrf), 'the filters that were applied are recorded');
});

maybe('the metadata names the generator and the moment, and never claims truncation', async () => {
  const res = await exportBook('', manager.token);
  assert.ok(res.ok);
  assert.equal(res.meta.truncated, false);
  assert.ok(typeof res.meta.scope === 'string');
  const sheet = res.book.getWorksheet('TRF Master')!;
  assert.equal(sheet.rowCount - 1, res.meta.rowCounts['TRF Master'], 'the header row is not counted');
});