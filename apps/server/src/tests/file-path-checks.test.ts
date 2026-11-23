import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import { pool } from '../db';
import { runMigrations } from '../migrate';

/**
 * The file-path CHECK constraints must reject every form of directory traversal
 * and accept a plain file name. The old constraints used NOT LIKE '%\%%', which
 * (because backslash is the LIKE escape character) actually meant "contains a
 * percent sign": a backslash passed and a percent sign was refused.
 */

before(async () => {
  await runMigrations();
});

after(async () => {
  await pool.end();
});

const BAD_PATHS = [
  'ard-results/1-abc.pdf',
  'ard-results\\1-abc.pdf',
  '..\\x.pdf',
  '../x.pdf',
  'a..b.pdf',
];

test('ard_assignment_results rejects every traversal form and accepts a plain name', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const bad of BAD_PATHS) {
      // A failed INSERT aborts the transaction, so each one gets a savepoint.
      await client.query('SAVEPOINT sp');
      await assert.rejects(
        client.query(
          `INSERT INTO ard_assignment_results (assignment_id, file_relative_path) VALUES (-1, $1)`,
          [bad],
        ),
        (err: { code?: string; constraint?: string }) => {
          assert.equal(err.code, '23514', `${JSON.stringify(bad)} should fail the CHECK`);
          assert.equal(err.constraint, 'ard_assignment_results_file_path_check');
          return true;
        },
      );
      await client.query('ROLLBACK TO SAVEPOINT sp');
    }

    // A plain name passes the CHECK; the only failure is the foreign key.
    await client.query('SAVEPOINT sp');
    await assert.rejects(
      client.query(
        `INSERT INTO ard_assignment_results (assignment_id, file_relative_path) VALUES (-1, $1)`,
        ['12-0a1b2c3d4e5f6a7b.pdf'],
      ),
      (err: { code?: string }) => {
        assert.equal(err.code, '23503', 'a plain name should fail only the foreign key');
        return true;
      },
    );
    await client.query('ROLLBACK TO SAVEPOINT sp');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});