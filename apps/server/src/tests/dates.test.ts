import { strict as assert } from 'node:assert';
import { after, test, TestContext } from 'node:test';
import { pool, isDatabaseReachable } from '../db';
import { dateOnly, localDay, today } from '../lib/dates';

const dbReachable = isDatabaseReachable().catch(() => false);

function maybe(name: string, fn: (t: TestContext) => Promise<void>) {
  test(name, async (t) => {
    if (!(await dbReachable)) return t.skip('no PostgreSQL database available');
    await fn(t);
  });
}

after(async () => { await pool.end(); });

test('localDay formats a local Date as YYYY-MM-DD', () => {
  assert.equal(localDay(new Date(2026, 10, 23)), '2026-11-23');
  assert.equal(localDay(new Date(2026, 0, 5)), '2026-01-05');
});

test('dateOnly keeps plain text and formats a legacy Date value', () => {
  assert.equal(dateOnly('2026-11-23'), '2026-11-23');
  assert.equal(dateOnly(new Date(2026, 10, 23)), '2026-11-23');
  assert.equal(dateOnly(null), null);
  assert.equal(dateOnly(undefined), null);
});

test('today is a plain YYYY-MM-DD string', () => {
  assert.match(today(), /^\d{4}-\d{2}-\d{2}$/);
});

maybe('a PostgreSQL DATE comes back as plain YYYY-MM-DD text, never a shifted Date', async () => {
  const { rows } = await pool.query<{ d: unknown }>("SELECT DATE '2026-11-23' AS d");
  assert.equal(typeof rows[0].d, 'string', 'the pg type parser must keep DATE as text');
  assert.equal(rows[0].d, '2026-11-23');
});