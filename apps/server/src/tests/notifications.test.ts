import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createNotification, notifyEmployee } from '../lib/notifications';

class FakeClient {
  queries: { text: string; values: unknown[] }[] = [];
  constructor(private readonly existingUnread = 0) {}
  async query(text: string, values: unknown[]) {
    this.queries.push({ text, values });
    const rowCount = text.includes('INSERT INTO notifications') ? 1 : this.existingUnread;
    return { rowCount };
  }
}

function insertQuery(client: FakeClient) {
  const query = client.queries.find((q) => q.text.includes('INSERT INTO notifications'));
  assert.ok(query, 'expected an INSERT INTO notifications');
  return query;
}

test('createNotification inserts an EMPLOYEE-scoped row', async () => {
  const client = new FakeClient();
  await createNotification(client as never, {
    recipientEmployeeId: 5,
    type: 'trf.awaiting_approval',
    title: 'New TRF',
    body: 'Please review.',
    trfId: 42,
  });

  const { text, values } = insertQuery(client);
  assert.ok(text.includes('recipient_type'));
  assert.deepEqual(values, ['EMPLOYEE', 5, null, 'trf.awaiting_approval', 'New TRF', 'Please review.', 42, '/trfs/42']);
});

test('createNotification inserts a TEAM-scoped row when recipientTeam is set', async () => {
  const client = new FakeClient();
  await createNotification(client as never, {
    recipientTeam: 'FRD',
    type: 'broadcast',
    title: 'Heads up',
    body: 'System maintenance.',
    trfId: null,
  });

  const { text, values } = insertQuery(client);
  assert.ok(text.includes('INSERT INTO notifications'));
  assert.deepEqual(values, ['TEAM', null, 'FRD', 'broadcast', 'Heads up', 'System maintenance.', null, null]);
});

test('notifyEmployee builds a link from the trfId', async () => {
  const client = new FakeClient();
  await notifyEmployee(client as never, 7, 'trf.approved', 'Approved', 'Your TRF was approved.', 99);

  const { values } = insertQuery(client);
  assert.equal(values[1], 7);
  assert.equal(values[7], '/trfs/99');
});

test('createNotification suppresses a second unread alert of the same kind for the same TRF', async () => {
  const client = new FakeClient(1);
  await createNotification(client as never, {
    recipientEmployeeId: 5,
    type: 'final_approval_needed',
    title: 'TRF ready for final approval',
    body: 'TRF 42 is ready for final approval.',
    trfId: 42,
  });

  assert.equal(client.queries.length, 1, 'only the duplicate check should run');
  assert.ok(client.queries[0].text.includes('is_read = FALSE'));
  assert.equal(client.queries.some((q) => q.text.includes('INSERT INTO notifications')), false);
});

test('createNotification still inserts when the TRF has no earlier unread alert', async () => {
  const client = new FakeClient(0);
  await createNotification(client as never, {
    recipientEmployeeId: 5,
    type: 'final_approval_needed',
    title: 'TRF ready for final approval',
    body: 'TRF 42 is ready for final approval.',
    trfId: 42,
  });

  assert.ok(client.queries.some((q) => q.text.includes('is_read = FALSE')), 'the duplicate check runs first');
  insertQuery(client);
});

test('createNotification does not dedupe a notification that has no TRF', async () => {
  const client = new FakeClient(1);
  await createNotification(client as never, {
    recipientEmployeeId: 5,
    type: 'system',
    title: 'Heads up',
    body: 'No TRF attached.',
  });

  assert.equal(client.queries.length, 1, 'no duplicate check without a TRF');
  insertQuery(client);
});