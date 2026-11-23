import { strict as assert } from 'node:assert';
import { after, before, test, TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Notification } from '@trf/shared';
import { buildApp } from '../app';
import { pool, isDatabaseReachable } from '../db';
import { runMigrations } from '../migrate';
import { hashPassword } from '../lib/password';
import { baseLookups } from './fixtures';
import type { BaseLookups } from './fixtures';

/**
 * Opening a notification clears it: the bell deletes the row and the unread
 * count drops. One employee must never be able to clear another's notifications.
 */
const dbReachable = isDatabaseReachable().catch(() => false);
let server: Server;
let baseUrl = '';

function maybe(name: string, fn: (t: TestContext) => Promise<void>) {
  test(name, async (t) => {
    if (!(await dbReachable)) return t.skip('no PostgreSQL database available');
    await fn(t);
  });
}

const SUFFIX = Math.random().toString(36).slice(2, 7);
const PASSWORD = 'Notifications-Pass-42';
let gmToken = '';
let gmId = 0;
let agmToken = '';
let agmId = 0;
let trfId = 0;
let lookups: BaseLookups;

async function api<T = any>(path: string, init: RequestInit = {}, token?: string) {
  const res = await fetch(baseUrl + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}
const post = (path: string, body: unknown, token?: string) => api(path, { method: 'POST', body: JSON.stringify(body) }, token);

async function seedEmployee(code: string, username: string, designation: string) {
  const row = await pool.query<{ id: number }>(
    `INSERT INTO employees (employee_code, full_name, email, username, password_hash, role, designation)
     VALUES ($1, $2, $3, $4, $5, 'Admin', $6)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = TRUE,
       role = 'Admin', designation = EXCLUDED.designation, failed_login_count = 0, locked_until = NULL
     RETURNING id`,
    [code, `Notify ${username}`, `${username}@test.local`, username, await hashPassword(PASSWORD), designation],
  );
  const signedIn = await post('/api/auth/login', { username, password: PASSWORD });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  return { id: row.rows[0].id, token: signedIn.body.accessToken as string };
}

before(async () => {
  if (!(await dbReachable)) return;
  await runMigrations();
  server = buildApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  lookups = await baseLookups();
  const gm = await seedEmployee(`NTF-GM-${SUFFIX}`, 'ntfgm', 'GM');
  gmToken = gm.token; gmId = gm.id;
  const agm = await seedEmployee(`NTF-AGM-${SUFFIX}`, 'ntfagm', 'AGM');
  agmToken = agm.token; agmId = agm.id;

  // Creating a TRF notifies the GM that a request is waiting for approval.
  const created = await post('/api/trfs', {
    trfDate: new Date().toISOString().slice(0, 10), customerId: lookups.customerId, productId: lookups.productId,
    priority: 'Normal', batchNumber: `NTF-${SUFFIX}`,
    testRequestedOptionIds: lookups.testRequestedOptionIds, dosageFormOptionIds: lookups.dosageFormOptionIds,
  }, agmToken);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  trfId = (created.body as { id: number }).id;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (trfId) await pool.query('DELETE FROM trfs WHERE id = $1', [trfId]).catch(() => undefined);
  await pool.end();
});

interface NotificationList { items: Notification[]; unreadCount: number }

maybe('opening a notification deletes it and drops the unread count', async () => {
  const beforeRes = await api<NotificationList>('/api/notifications?pageSize=100', {}, gmToken);
  assert.equal(beforeRes.status, 200, JSON.stringify(beforeRes.body));
  const note = beforeRes.body!.items.find((n) => n.relatedTrfId === trfId);
  assert.ok(note, 'the GM was told about the new TRF');
  assert.equal(note!.isRead, false, 'the new notification is unread');

  const removed = await api(`/api/notifications/${note!.id}`, { method: 'DELETE' }, gmToken);
  assert.equal(removed.status, 204);

  const afterRes = await api<NotificationList>('/api/notifications?pageSize=100', {}, gmToken);
  assert.equal(afterRes.body!.items.some((n) => n.id === note!.id), false, 'the notification is gone');
  assert.equal(afterRes.body!.unreadCount, beforeRes.body!.unreadCount - 1, 'the badge drops by one');
});

maybe('one employee cannot clear another employee\'s notification', async () => {
  const inserted = await pool.query<{ id: number }>(
    `INSERT INTO notifications (recipient_type, recipient_employee_id, type, title, body, related_trf_id)
     VALUES ('EMPLOYEE', $1, 'test.private', 'Private', 'Only for the AGM.', $2) RETURNING id`,
    [agmId, trfId],
  );
  const id = inserted.rows[0].id;

  const removed = await api(`/api/notifications/${id}`, { method: 'DELETE' }, gmToken);
  assert.equal(removed.status, 204, 'the route answers 204 even when it matches nothing');

  const still = await pool.query('SELECT 1 FROM notifications WHERE id = $1 AND recipient_employee_id = $2', [id, agmId]);
  assert.equal(still.rowCount, 1, 'the other employee\'s notification survives');
  assert.equal(still.rowCount, 1, 'the row is still there');

  await pool.query('DELETE FROM notifications WHERE id = $1', [id]);
});

maybe('an invalid notification id is rejected', async () => {
  const res = await api('/api/notifications/not-a-number', { method: 'DELETE' }, gmToken);
  assert.equal(res.status, 400);
});

maybe('deleting a notification that is already gone still answers 204', async () => {
  const res = await api('/api/notifications/999999999', { method: 'DELETE' }, gmToken);
  assert.equal(res.status, 204);
});

maybe('the unread count endpoint agrees with the list after a delete', async () => {
  const list = await api<NotificationList>('/api/notifications?pageSize=100', {}, gmToken);
  const count = await api<{ count: number }>('/api/notifications/unread-count', {}, gmToken);
  assert.equal(count.status, 200);
  assert.equal(count.body!.count, list.body!.unreadCount);
  assert.ok(gmId > 0);
});