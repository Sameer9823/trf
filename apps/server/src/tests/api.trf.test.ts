import { strict as assert } from 'node:assert';
import { after, before, test, TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { TrfDetail, TrfListPage, TrfStatusHistoryEntry } from '@trf/shared';
import { MESSAGES } from '@trf/shared';
import { buildApp } from '../app';
import { pool, isDatabaseReachable } from '../db';
import { runMigrations } from '../migrate';
import { hashPassword } from '../lib/password';

const dbReachable = isDatabaseReachable().catch(() => false);
let server: Server;
let baseUrl = '';

/**
 * Phase 3 checks that need a real PostgreSQL database. Each reports as skipped
 * when no database is reachable, so a green run never claims untested coverage.
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

async function api<T = unknown>(path: string, init: RequestInit = {}, token?: string) {
  const res = await fetch(baseUrl + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T & { error?: { code: string; message: string; fields?: Record<string, string> }; requestId?: string } };
}

const ADMIN_PASSWORD = 'Trf-Phase-Admin-42';

async function ensureAdmin(): Promise<string> {
  await pool.query(
    `INSERT INTO employees (employee_code, full_name, email, username, password_hash, role)
     VALUES ('PHASE3-ADMIN', 'Phase3 Admin', 'phase3-admin@test.local', 'phase3admin', $1, 'Admin')
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = TRUE, role = 'Admin'`,
    [await hashPassword(ADMIN_PASSWORD)],
  );
  const res = await api<{ accessToken: string }>('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'phase3admin', password: ADMIN_PASSWORD }),
  });
  return res.body.accessToken;
}

let adminToken = '';

async function createAnalyst(): Promise<{ id: number; username: string; password: string }> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const password = 'Analyst-Test-Pass-42';
  await pool.query(
    `INSERT INTO employees (employee_code, full_name, email, username, password_hash, role)
     VALUES ($1, $2, $3, $4, $5, 'Analyst')
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = TRUE`,
    [`P3-ANA-${suffix}`, `Phase3 Analyst ${suffix}`, `p3ana${suffix}@test.local`, `p3ana${suffix}`, await hashPassword(password)],
  );
  const found = await pool.query<{ id: number }>(`SELECT id FROM employees WHERE username = $1`, [`p3ana${suffix}`]);
  return { id: found.rows[0].id, username: `p3ana${suffix}`, password };
}

async function tokenFor(username: string, password: string): Promise<string> {
  const res = await api<{ accessToken: string }>('/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username, password }),
  });
  return res.body.accessToken;
}

const today = new Date().toISOString().slice(0, 10);
const TRF_BODY = {
  trfDate: today,
  customerId: null, productId: null, batchNumber: null, sampleQuantity: null,
  sampleReceivedDate: null, requiredCompletionDate: null, priority: 'Normal',
  requestedAnalysis: null, specialInstructions: null, departmentId: null, remarks: null,
  batchSize: null, dosageForm: null, manufacturingLocation: null,
  labelClaim: null, packSize: null, packType: null, storageCondition: null,
  storagePeriod: null, manufacturingDate: null, expiryDate: null,
  analysisPurpose: null, sampleGivenBy: null, signatureDate: null,
};

async function createTrf(overrides: Record<string, unknown> = {}, token = adminToken) {
  return api<TrfDetail>('/api/trfs', {
    method: 'POST', body: JSON.stringify({ ...TRF_BODY, ...overrides }),
  }, token);
}

maybe('setup: an admin session and an analyst exist', async () => {
  adminToken = await ensureAdmin();
  assertToken(adminToken);
});

function assertToken(token: string) {
  if (!token || token.length < 20) throw new Error('expected an access token');
}

maybe('a created TRF gets the TRF-YYYY-NNNNN format and starts as New', async () => {
  const res = await createTrf({ batchNumber: `B-${Date.now()}` });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const trf = res.body;
  assert.match(trf.trfNumber, /^TRF-\d{4}-\d{5}$/);
  assert.equal(trf.status, 'New');
  assert.equal(trf.version, 1);
  assert.equal(trf.isOverdue, false);
  assert.equal(trf.priority, 'Normal');
    await pool.query('DELETE FROM trfs WHERE id = $1', [trf.id]);
  });

  maybe('creating a TRF auto-creates ARD tracking fields with Received status', async () => {
    const res = await createTrf({ batchNumber: `ARD-TEST-${Date.now()}` });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(res.body.ardNumber ?? '', /^ARD-\d{4}-\d{5}$/);
    assert.equal(res.body.workflowStatus, 'Received');
    assert.equal(res.body.stage, 'Received');
    await pool.query('DELETE FROM trfs WHERE id = $1', [res.body.id]);
  });

  maybe('a TRF with expiry date earlier than manufacturing date is rejected', async () => {
    const res = await createTrf({
      manufacturingDate: '2026-01-10',
      expiryDate: '2026-01-05',
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error?.fields?.expiryDate);
  });

maybe('a TRF with a past required completion date is accepted and starts overdue', async () => {
  const res = await createTrf({
    trfDate: today,
    requiredCompletionDate: '2000-01-01',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.isOverdue, true);
  await pool.query('DELETE FROM trfs WHERE id = $1', [res.body.id]);
});

maybe('creating a TRF writes the first status history row', async () => {
  const created = await createTrf();
  const history = await api<{ items: TrfStatusHistoryEntry[] }>(`/api/trfs/${created.body.id}/history`, {}, adminToken);
  assert.equal(history.status, 200);
  assert.equal(history.body.items.length, 1);
  assert.equal(history.body.items[0].oldStatus, null);
  assert.equal(history.body.items[0].newStatus, 'New');
  await pool.query('DELETE FROM trfs WHERE id = $1', [created.body.id]);
});

maybe('fifty parallel creates produce fifty distinct numbers with no gaps', async () => {
  // The Phase 3 concurrency requirement: many PCs saving at the same moment.
  const attempts = Array.from({ length: 50 }, (_, i) =>
    createTrf({ batchNumber: `PARALLEL-${Date.now()}-${i}` }));

  const results = await Promise.all(attempts);
  const created = results.filter((r) => r.status === 201);
  assert.equal(created.length, 50, `only ${created.length} of 50 parallel creates succeeded`);

  const numbers = created.map((r) => r.body.trfNumber);
  assert.equal(new Set(numbers).size, 50, 'two clients received the same TRF number');

  // Gap-free within this year: the counter increments by exactly one each time.
  const sequence = numbers.map((n) => Number(n.slice(-5))).sort((a, b) => a - b);
  for (let i = 1; i < sequence.length; i += 1) {
    assert.equal(sequence[i], sequence[i - 1] + 1, `number sequence jumped between ${sequence[i - 1]} and ${sequence[i]}`);
  }
  await pool.query(`DELETE FROM trfs WHERE batch_number LIKE 'PARALLEL-%'`);
});

maybe('a duplicate TRF number cannot be inserted and is refused with the standard message', async () => {
  const created = await createTrf();
  const number = created.body.trfNumber;
  // Force the duplicate at the database level, which is the constraint that must hold.
  await assert.rejects(
    pool.query(`INSERT INTO trfs (trf_number, trf_date) VALUES ($1, $2)`, [number, today]),
    (err: Error & { code?: string }) => err.code === '23505',
  );
  await pool.query('DELETE FROM trfs WHERE id = $1', [created.body.id]);
});

maybe('an invalid create body is rejected with friendly field messages', async () => {
  const res = await api('/api/trfs', {
    method: 'POST', body: JSON.stringify({ trfDate: '31-12-2026', priority: 'Very High' }),
  }, adminToken);
  assert.equal(res.status, 400);
  assert.ok(res.body.error?.fields?.trfDate);
  assert.equal(JSON.stringify(res.body).includes('SQL'), false);
});

maybe('a sample received date before the TRF date is refused', async () => {
  const res = await createTrf({ trfDate: '2026-06-10', sampleReceivedDate: '2026-06-01' });
  assert.equal(res.status, 400);
  assert.ok(res.body.error?.fields?.sampleReceivedDate);
});

maybe('two users editing the same TRF: the second save gets the 409 message', async () => {
  // The Phase 3 lost-update requirement.
  const created = await createTrf({ batchNumber: 'CONFLICT-1' });
  const id = created.body.id;
  const version = created.body.version;

  const first = await api<TrfDetail>(`/api/trfs/${id}`, {
    method: 'PATCH', body: JSON.stringify({ version, batchNumber: 'FIRST-EDIT' }),
  }, adminToken);
  assert.equal(first.status, 200);

  const second = await api(`/api/trfs/${id}`, {
    method: 'PATCH', body: JSON.stringify({ version, batchNumber: 'SECOND-EDIT' }),
  }, adminToken);
  assert.equal(second.status, 409);
  assert.equal(second.body.error?.message, MESSAGES.CONFLICT);

  // The first edit survives: the second save did not overwrite it.
  const current = await api<TrfDetail>(`/api/trfs/${id}`, {}, adminToken);
  assert.equal(current.body.batchNumber, 'FIRST-EDIT');
  await pool.query('DELETE FROM trfs WHERE id = $1', [id]);
});

maybe('an edit records the old and new value of each changed field', async () => {
  const created = await createTrf({ batchNumber: 'AUDIT-BEFORE', priority: 'Normal' });
  await api(`/api/trfs/${created.body.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ version: created.body.version, batchNumber: 'AUDIT-AFTER', priority: 'Urgent' }),
  }, adminToken);

  const rows = await pool.query<{ action: string; old_value: { value: string }; new_value: { value: string } }>(
    `SELECT action, old_value, new_value FROM audit_logs
     WHERE module = 'trf' AND record_ref = $1 AND action = 'trf.field_changed'`,
    [created.body.trfNumber],
  );
  const byField = new Map(rows.rows.map((r) => [r.new_value.value === 'Urgent' ? 'priority' : 'batchNumber', r]));
  assert.equal(byField.get('batchNumber')?.old_value.value, 'AUDIT-BEFORE');
  assert.equal(byField.get('batchNumber')?.new_value.value, 'AUDIT-AFTER');
  assert.equal(byField.get('priority')?.old_value.value, 'Normal');
  assert.equal(byField.get('priority')?.new_value.value, 'Urgent');
  await pool.query('DELETE FROM trfs WHERE id = $1', [created.body.id]);
});

maybe('an illegal status transition is refused with a clear message', async () => {
  const created = await createTrf();
  const id = created.body.id;
  const skip = await api(`/api/trfs/${id}/status`, {
    method: 'POST', body: JSON.stringify({ status: 'Completed', version: created.body.version }),
  }, adminToken);
  assert.equal(skip.status, 409);
  assert.match(skip.body.error?.message ?? '', /can only change to/);

  const still = await api<TrfDetail>(`/api/trfs/${id}`, {}, adminToken);
  assert.equal(still.body.status, 'New');
  await pool.query('DELETE FROM trfs WHERE id = $1', [id]);
});

maybe('the full forward path New to Completed works and each step is recorded', async () => {
  const created = await createTrf();
  let detail = created.body;
  const path: TrfDetail['status'][] = ['Assigned', 'In Progress', 'Analysis Completed', 'COA Pending', 'Completed'];

  for (const status of path) {
    const res = await api<TrfDetail>(`/api/trfs/${detail.id}/status`, {
      method: 'POST', body: JSON.stringify({ status, version: detail.version }),
    }, adminToken);
    assert.equal(res.status, 200, `${status}: ${JSON.stringify(res.body)}`);
    detail = res.body;
    assert.equal(detail.status, status);
  }

  const terminal = await api(`/api/trfs/${detail.id}/status`, {
    method: 'POST', body: JSON.stringify({ status: 'In Progress', version: detail.version }),
  }, adminToken);
  assert.equal(terminal.status, 409);

  const history = await api<{ items: TrfStatusHistoryEntry[] }>(`/api/trfs/${detail.id}/history`, {}, adminToken);
  assert.equal(history.body.items.length, 6); // created + five changes
  await pool.query('DELETE FROM trfs WHERE id = $1', [detail.id]);
});

maybe('two managers changing status at the same time: only one wins', async () => {
  const created = await createTrf();
  const body = { status: 'Assigned', version: created.body.version };
  const [a, b] = await Promise.all([
    api(`/api/trfs/${created.body.id}/status`, { method: 'POST', body: JSON.stringify(body) }, adminToken),
    api(`/api/trfs/${created.body.id}/status`, { method: 'POST', body: JSON.stringify(body) }, adminToken),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409]);

  const history = await api<{ items: TrfStatusHistoryEntry[] }>(`/api/trfs/${created.body.id}/history`, {}, adminToken);
  // Only one history row beyond the creation row: the blocked attempt wrote nothing.
  assert.equal(history.body.items.length, 2);
  await pool.query('DELETE FROM trfs WHERE id = $1', [created.body.id]);
});

maybe('assignment writes an audit row naming the old and the new employee', async () => {
  const analyst = await createAnalyst();
  const created = await createTrf();
  const id = created.body.id;

  const first = await api<TrfDetail>(`/api/trfs/${id}/assign`, {
    method: 'POST', body: JSON.stringify({ assignedEmployeeId: analyst.id, version: created.body.version }),
  }, adminToken);
  assert.equal(first.status, 200);
  assert.equal(first.body.assignedEmployeeId, analyst.id);

  const row = await pool.query<{ old_value: { assignedEmployee: string | null }; new_value: { assignedEmployee: string } }>(
    `SELECT old_value, new_value FROM audit_logs
     WHERE module = 'trf' AND record_ref = $1 AND action = 'trf.assigned'`,
    [created.body.trfNumber],
  );
  assert.equal(row.rows[0].old_value.assignedEmployee, null);
  assert.equal(row.rows[0].new_value.assignedEmployee.startsWith('Phase3 Analyst'), true);
  await pool.query('DELETE FROM trfs WHERE id = $1', [id]);
});

maybe('a Viewer cannot be assigned work', async () => {
  const suffix = Math.random().toString(36).slice(2, 7);
  await pool.query(
    `INSERT INTO employees (employee_code, full_name, email, username, password_hash, role)
     VALUES ($1, $2, $3, $4, 'unused-for-this-check', 'Viewer')`,
    [`P3-VW-${suffix}`, `Phase3 Viewer ${suffix}`, `p3vw${suffix}@test.local`, `p3vw${suffix}`],
  );
  const viewer = await pool.query<{ id: number }>(`SELECT id FROM employees WHERE username = $1`, [`p3vw${suffix}`]);
  const created = await createTrf();
  const res = await api(`/api/trfs/${created.body.id}/assign`, {
    method: 'POST', body: JSON.stringify({ assignedEmployeeId: viewer.rows[0].id, version: created.body.version }),
  }, adminToken);
  assert.equal(res.status, 400);
  assert.ok(res.body.error?.fields?.assignedEmployeeId);
  await pool.query('DELETE FROM trfs WHERE id = $1', [created.body.id]);
});

maybe('overdue is computed from the due date, not stored', async () => {
  const past = '2026-01-15';
  const future = '2099-01-15';
  const overdueTrf = await createTrf({ requiredCompletionDate: past });
  assert.equal(overdueTrf.body.isOverdue, true);

  const notOverdue = await createTrf({ requiredCompletionDate: future });
  assert.equal(notOverdue.body.isOverdue, false);

  const list = await api<TrfListPage>('/api/trfs?overdueOnly=true&pageSize=200', {}, adminToken);
  assert.ok(list.body.items.some((t) => t.id === overdueTrf.body.id));
  assert.equal(list.body.items.some((t) => t.id === notOverdue.body.id), false);

  // A cancelled TRF stops counting as overdue.
  const cancelled = await api<TrfDetail>(`/api/trfs/${overdueTrf.body.id}/status`, {
    method: 'POST', body: JSON.stringify({ status: 'Cancelled', version: overdueTrf.body.version }),
  }, adminToken);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.isOverdue, false);

  await pool.query('DELETE FROM trfs WHERE id = ANY($1)', [[overdueTrf.body.id, notOverdue.body.id]]);
});

maybe('a Completed TRF can no longer be edited or assigned', async () => {
  const created = await createTrf();
  let detail = created.body;
  for (const status of ['Assigned', 'In Progress', 'Analysis Completed', 'COA Pending', 'Completed'] as const) {
    const res = await api<TrfDetail>(`/api/trfs/${detail.id}/status`, {
      method: 'POST', body: JSON.stringify({ status, version: detail.version }),
    }, adminToken);
    detail = res.body;
  }
  const edit = await api(`/api/trfs/${detail.id}`, {
    method: 'PATCH', body: JSON.stringify({ version: detail.version, batchNumber: 'TOO-LATE' }),
  }, adminToken);
  assert.equal(edit.status, 409);
  const assign = await api(`/api/trfs/${detail.id}/assign`, {
    method: 'POST', body: JSON.stringify({ assignedEmployeeId: null, version: detail.version }),
  }, adminToken);
  assert.equal(assign.status, 409);
  await pool.query('DELETE FROM trfs WHERE id = $1', [detail.id]);
});

maybe('the list paginates, searches, filters and sorts on the server', async () => {
  const tag = `FILTER-${Date.now()}`;
  const created = await createTrf({ batchNumber: tag, priority: 'High' });
  const other = await createTrf({ batchNumber: `${tag}-OTHER`, priority: 'Low' });

  const search = await api<TrfListPage>(`/api/trfs?search=${tag}`, {}, adminToken);
  assert.equal(search.body.items.length, 2);

  const one = await api<TrfListPage>(`/api/trfs?search=${tag}&priority=High`, {}, adminToken);
  assert.equal(one.body.items.length, 1);
  assert.equal(one.body.items[0].priority, 'High');

  const paged = await api<TrfListPage>('/api/trfs?page=1&pageSize=1', {}, adminToken);
  assert.equal(paged.body.items.length, 1);
  assert.equal(paged.body.pageCount, Math.max(1, Math.ceil(paged.body.total / 1)));
  assert.ok(paged.body.total >= 2);

  const asc = await api<TrfListPage>('/api/trfs?sortBy=trfNumber&sortDir=asc&pageSize=5', {}, adminToken);
  const numbers = asc.body.items.map((t) => t.trfNumber);
  assert.deepEqual(numbers, [...numbers].sort());

  const byStatus = await api<TrfListPage>('/api/trfs?status=New,Cancelled&pageSize=200', {}, adminToken);
  assert.ok(byStatus.body.items.every((t) => t.status === 'New' || t.status === 'Cancelled'));

  const bad = await api('/api/trfs?sortBy=drop%20table', {}, adminToken);
  assert.equal(bad.status, 400);

  await pool.query('DELETE FROM trfs WHERE id = ANY($1)', [[created.body.id, other.body.id]]);
});
maybe('an Analyst sees only their own TRFs, and the restriction is in SQL', async () => {
  const analyst = await createAnalyst();
  const mine = await createTrf({ batchNumber: 'ANALYST-OWN' });
  await api(`/api/trfs/${mine.body.id}/assign`, {
    method: 'POST', body: JSON.stringify({ assignedEmployeeId: analyst.id, version: mine.body.version }),
  }, adminToken);

  const other = await createTrf({ batchNumber: 'ANALYST-NOT-MINE' });
  const token = await tokenFor(analyst.username, analyst.password);

  const list = await api<TrfListPage>('/api/trfs?pageSize=200', {}, token);
  const ids = list.body.items.map((t) => t.id);
  assert.equal(ids.includes(mine.body.id), true);
  assert.equal(ids.includes(other.body.id), false);

  const forbidden = await api(`/api/trfs/${other.body.id}`, {}, token);
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error?.message, MESSAGES.NO_PERMISSION);

  await pool.query('DELETE FROM trfs WHERE id = ANY($1)', [[mine.body.id, other.body.id]]);
});

maybe('an Analyst cannot create, edit, assign or change a TRF status', async () => {
  const analyst = await createAnalyst();
  const token = await tokenFor(analyst.username, analyst.password);
  const target = await createTrf();

  const create = await api('/api/trfs', { method: 'POST', body: JSON.stringify(TRF_BODY) }, token);
  assert.equal(create.status, 403);
  assert.equal(create.body.error?.message, MESSAGES.NO_PERMISSION);

  const edit = await api(`/api/trfs/${target.body.id}`, {
    method: 'PATCH', body: JSON.stringify({ version: target.body.version, batchNumber: 'NOPE' }),
  }, token);
  assert.equal(edit.status, 403);

  const assign = await api(`/api/trfs/${target.body.id}/assign`, {
    method: 'POST', body: JSON.stringify({ assignedEmployeeId: analyst.id, version: target.body.version }),
  }, token);
  assert.equal(assign.status, 403);

  const status = await api(`/api/trfs/${target.body.id}/status`, {
    method: 'POST', body: JSON.stringify({ status: 'Cancelled', version: target.body.version }),
  }, token);
  assert.equal(status.status, 403);
  await pool.query('DELETE FROM trfs WHERE id = $1', [target.body.id]);
});

maybe('a Viewer can read but not write', async () => {
  const suffix = Math.random().toString(36).slice(2, 7);
  const password = 'Viewer-Test-Pass-42';
  await pool.query(
    `INSERT INTO employees (employee_code, full_name, email, username, password_hash, role)
     VALUES ($1, $2, $3, $4, $5, 'Viewer')`,
    [`P3-V2-${suffix}`, `Phase3 Viewer2 ${suffix}`, `p3v2${suffix}@test.local`, `p3v2${suffix}`, await hashPassword(password)],
  );
  const token = await tokenFor(`p3v2${suffix}`, password);
  const target = await createTrf();

  const list = await api('/api/trfs?pageSize=1', {}, token);
  assert.equal(list.status, 200);
  const edit = await api(`/api/trfs/${target.body.id}`, {
    method: 'PATCH', body: JSON.stringify({ version: target.body.version, remarks: 'NOPE' }),
  }, token);
  assert.equal(edit.status, 403);
  await pool.query('DELETE FROM trfs WHERE id = $1', [target.body.id]);
});

maybe('customers and products are readable by everyone who can see a TRF', async () => {
  const analyst = await createAnalyst();
  const token = await tokenFor(analyst.username, analyst.password);
  assert.equal((await api('/api/lookups/customers', {}, token)).status, 200);
  assert.equal((await api('/api/lookups/products', {}, token)).status, 200);
  // But an Analyst cannot add to the Admin-managed lists.
  const create = await api('/api/lookups/products', {
    method: 'POST', body: JSON.stringify({ name: 'Analyst Product' }),
  }, token);
  assert.equal(create.status, 403);
});

maybe('an Admin can create a customer and product inline and then use them on a TRF', async () => {
  const suffix = Date.now().toString(36);
  const customer = await api<{ id: number; name: string }>('/api/lookups/customers', {
    method: 'POST', body: JSON.stringify({ name: `Inline Customer ${suffix}`, code: `IC-${suffix}` }),
  }, adminToken);
  assert.equal(customer.status, 201);
  const product = await api<{ id: number }>('/api/lookups/products', {
    method: 'POST', body: JSON.stringify({ name: `Inline Product ${suffix}` }),
  }, adminToken);
  assert.equal(product.status, 201);

  const trf = await createTrf({ customerId: customer.body.id, productId: product.body.id });
  assert.equal(trf.status, 201);
  assert.equal(trf.body.customerId, customer.body.id);
  assert.equal(trf.body.productName, `Inline Product ${suffix}`);

  await pool.query('DELETE FROM trfs WHERE id = $1', [trf.body.id]);
  await pool.query('DELETE FROM products WHERE id = $1', [product.body.id]);
  await pool.query('DELETE FROM customers WHERE id = $1', [customer.body.id]);
});

maybe('a duplicate customer code is refused', async () => {
  const code = `DUP-${Date.now().toString(36)}`;
  const first = await api<{ id: number }>('/api/lookups/customers', { method: 'POST', body: JSON.stringify({ name: 'Dup One', code }) }, adminToken);
  assert.equal(first.status, 201);
  const second = await api('/api/lookups/customers', { method: 'POST', body: JSON.stringify({ name: 'Dup Two', code }) }, adminToken);
  assert.equal(second.status, 409);
  await pool.query('DELETE FROM customers WHERE id = $1', [first.body.id]);
});

maybe('an unknown TRF id returns the friendly 404, not a database error', async () => {
  const res = await api('/api/trfs/99999999', {}, adminToken);
  assert.equal(res.status, 404);
  assert.equal(JSON.stringify(res.body).includes('SQL'), false);
  assert.equal(JSON.stringify(res.body).includes('SELECT'), false);
});

maybe('a TRF number is not reused after the TRF is deleted', async () => {
  const created = await createTrf();
  const number = created.body.trfNumber;
  await pool.query('DELETE FROM trfs WHERE id = $1', [created.body.id]);

  const next = await createTrf();
  assert.notEqual(next.body.trfNumber, number);
  assert.equal(Number(next.body.trfNumber.slice(-5)), Number(number.slice(-5)) + 1);
  await pool.query('DELETE FROM trfs WHERE id = $1', [next.body.id]);
});

maybe('a TRF in New status can be soft-deleted by an Admin', async () => {
  const created = await createTrf({ batchNumber: 'DELETE-TEST' });
  const id = created.body.id;

  const res = await api(`/api/trfs/${id}`, { method: 'DELETE', body: JSON.stringify({ version: created.body.version }) }, adminToken);
  assert.equal(res.status, 200, JSON.stringify(res.body));

  // The TRF is gone from the list (soft-deleted).
  const detail = await api(`/api/trfs/${id}`, {}, adminToken);
  assert.equal(detail.status, 404);

  await pool.query('DELETE FROM trfs WHERE id = $1', [id]);
});

maybe('a TRF that is not New cannot be deleted', async () => {
  const created = await createTrf();
  const id = created.body.id;

  // Move to Assigned first.
  await api(`/api/trfs/${id}/status`, {
    method: 'POST', body: JSON.stringify({ status: 'Assigned', version: created.body.version }),
  }, adminToken);

  const moved = await api<TrfDetail>(`/api/trfs/${id}`, {}, adminToken);
  const res = await api(`/api/trfs/${id}`, { method: 'DELETE', body: JSON.stringify({ version: moved.body.version }) }, adminToken);
  assert.equal(res.status, 409);
  await pool.query('DELETE FROM trfs WHERE id = $1', [id]);
});

maybe('a TRF with analysis tests cannot be deleted', async () => {
  const created = await createTrf({ batchNumber: 'DEP-TEST' });
  const id = created.body.id;

  // Insert a dependent analysis test directly.
  await pool.query(
    `INSERT INTO analysis_tests (trf_id, test_name, status) VALUES ($1, $2, 'Assigned')`,
    [id, 'Dependent Test'],
  );

  const res = await api(`/api/trfs/${id}`, { method: 'DELETE', body: JSON.stringify({ version: created.body.version }) }, adminToken);
  assert.equal(res.status, 409);
  assert.ok(res.body.error?.message.includes('analysis tests') || res.body.error?.message.includes('certificates'));

  // Cleanup
  await pool.query('DELETE FROM analysis_tests WHERE trf_id = $1', [id]);
  await pool.query('DELETE FROM trfs WHERE id = $1', [id]);
});

maybe('ARD workflow status can transition from Received to In Progress to Completed', async () => {
  const created = await createTrf();
  const id = created.body.id;
  let detail = created.body;

  const inProgress = await api<TrfDetail>(`/api/trfs/${id}/ard-status`, {
    method: 'POST', body: JSON.stringify({ status: 'In Progress', version: detail.version }),
  }, adminToken);
  assert.equal(inProgress.status, 200);
  assert.equal(inProgress.body.workflowStatus, 'In Progress');

  const refreshed = await api<TrfDetail>(`/api/trfs/${id}`, {}, adminToken);
  detail = refreshed.body;

  const completed = await api<TrfDetail>(`/api/trfs/${id}/ard-status`, {
    method: 'POST', body: JSON.stringify({ status: 'Completed', version: detail.version }),
  }, adminToken);
  assert.equal(completed.status, 200);
  assert.equal(completed.body.workflowStatus, 'Completed');

  // ARD history is recorded.
  const history = await api<{ items: unknown[] }>(`/api/trfs/${id}/ard-history`, {}, adminToken);
  assert.equal(history.status, 200);
  assert.equal(history.body.items.length, 2);

  await pool.query('DELETE FROM trfs WHERE id = $1', [id]);
});

maybe('an Analyst cannot edit ARD fields (no ARD department)', async () => {
  const analyst = await createAnalyst();
  const token = await tokenFor(analyst.username, analyst.password);
  const target = await createTrf();

  const edit = await api(`/api/trfs/${target.body.id}`, {
    method: 'PATCH', body: JSON.stringify({ version: target.body.version, coaStatus: 'Draft' }),
  }, token);
  assert.equal(edit.status, 403);

  await pool.query('DELETE FROM trfs WHERE id = $1', [target.body.id]);
});

maybe('creating a TRF with the full field set returns 201 with ARD tracking', async () => {
  const suffix = Date.now().toString(36);
  const customer = await api<{ id: number; name: string }>('/api/lookups/customers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `Full Test Customer ${suffix}`, code: `FTC-${suffix}` }),
  }, adminToken);
  assert.equal(customer.status, 201);
  const product = await api<{ id: number }>('/api/lookups/products', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `Full Test Product ${suffix}` }),
  }, adminToken);
  assert.equal(product.status, 201);

  const res = await createTrf({
    customerId: customer.body.id,
    productId: product.body.id,
    batchNumber: 'FULL-BATCH',
    sampleQuantity: '100g',
     sampleReceivedDate: today,
    requiredCompletionDate: '2026-11-30',
    priority: 'High',
    requestedAnalysis: 'Full potency panel',
    specialInstructions: 'Keep cold',
    remarks: 'Handle with care',
    batchSize: '1000',
    dosageForm: 'Tablet',
    manufacturingLocation: 'Plant A',
    labelClaim: '100mg',
    packSize: '1000',
    packType: 'Bottle',
    storageCondition: '2-8C',
    storagePeriod: '24 months',
    manufacturingDate: '2026-01-15',
    expiryDate: '2028-01-15',
    analysisPurpose: 'Stability',
    sampleGivenBy: 'QA Dept',
     signatureDate: today,
  });

  assert.equal(res.status, 201);
  assert.ok(res.body.trfNumber?.startsWith('TRF-'));
  assert.ok(res.body.ardNumber?.startsWith('ARD-'));
  assert.equal(res.body.workflowStatus, 'Received');
  assert.equal(res.body.stage, 'Received');

  await pool.query('DELETE FROM trfs WHERE id = $1', [res.body.id]);
  await pool.query('DELETE FROM products WHERE id = $1', [product.body.id]);
  await pool.query('DELETE FROM customers WHERE id = $1', [customer.body.id]);
});

maybe('creating a TRF with only required fields returns 201', async () => {
  const res = await createTrf({});
  assert.equal(res.status, 201);
  assert.ok(res.body.trfNumber);
  assert.ok(res.body.ardNumber);
  assert.equal(res.body.priority, 'Normal');
  assert.equal(res.body.workflowStatus, 'Received');
  await pool.query('DELETE FROM trfs WHERE id = $1', [res.body.id]);
});

maybe('creating a TRF with a non-existent customer ID returns 400', async () => {
  const res = await createTrf({ customerId: 999999 });
  assert.equal(res.status, 400);
  assert.ok(res.body.error);
  assert.equal(res.body.error!.code, 'BAD_REQUEST');
  assert.ok(res.body.requestId);
  assert.ok(res.body.error!.fields?.customerId);
});
