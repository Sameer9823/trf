import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createNotification, notifyEmployee } from '../lib/notifications';

class FakeClient {
  queries: { text: string; values: unknown[] }[] = [];
  async query(text: string, values: unknown[]) {
    this.queries.push({ text, values });
    return { rowCount: 1 };
  }
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

  assert.equal(client.queries.length, 1);
  const { text, values } = client.queries[0];
  assert.ok(text.includes('INSERT INTO notifications'));
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

  const { text, values } = client.queries[0];
  assert.ok(text.includes('INSERT INTO notifications'));
  assert.deepEqual(values, ['TEAM', null, 'FRD', 'broadcast', 'Heads up', 'System maintenance.', null, null]);
});

test('notifyEmployee builds a link from the trfId', async () => {
  const client = new FakeClient();
  await notifyEmployee(client as never, 7, 'trf.approved', 'Approved', 'Your TRF was approved.', 99);

  const { text, values } = client.queries[0];
  assert.ok(text.includes('INSERT INTO notifications'));
  assert.equal(values[1], 7);
  assert.equal(values[7], '/trfs/99');
});
