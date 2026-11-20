import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test, TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildApp } from '../app';
import { pool, isDatabaseReachable } from '../db';
import { runMigrations } from '../migrate';
import { logFileFor, pruneOldLogs } from '../lib/logger';
import { backupFileName, chooseDumpTool, dumpToolMajor } from '../backup';

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

let tmp = '';

test('a temp directory is available for the file tests', () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trf-logs-'));
  assert.ok(fs.existsSync(tmp));
});

test('each day of the log goes to its own file', () => {
  const options = { filePath: path.join(tmp, 'api.log'), keep: 3 };
  assert.equal(
    logFileFor(options, new Date('2026-10-01T09:00:00Z')),
    path.join(tmp, 'api-2026-10-01.log'),
  );
  assert.equal(
    logFileFor(options, new Date('2026-10-02T23:59:00Z')),
    path.join(tmp, 'api-2026-10-02.log'),
  );
  // Two hours either side of midnight are still the same file name, because the
  // date is the UTC day the line belongs to.
  assert.equal(logFileFor(options, new Date('2026-10-01T23:00:00Z')), logFileFor(options, new Date('2026-10-01T00:00:00Z')));
});

test('old log files are pruned and the newest ones are kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trf-prune-'));
  const options = { filePath: path.join(dir, 'api.log'), keep: 2 };
  for (const day of ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']) {
    fs.writeFileSync(logFileFor(options, new Date(`${day}T12:00:00Z`)), 'line');
  }
  // An unrelated file must never be touched by pruning.
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep me');
  fs.writeFileSync(path.join(dir, 'api.log'), 'not dated');

  const removed = pruneOldLogs(options, new Date('2026-10-01T12:00:00Z'));
  assert.deepEqual(removed.sort(), ['api-2026-09-28.log', 'api-2026-09-29.log']);

  const left = fs.readdirSync(dir).sort();
  assert.deepEqual(left, ['api-2026-09-30.log', 'api-2026-10-01.log', 'api.log', 'notes.txt']);
});

test('pruning a directory that does not exist is not an error', () => {
  const options = { filePath: path.join(tmp, 'missing', 'api.log'), keep: 2 };
  assert.deepEqual(pruneOldLogs(options, new Date('2026-10-01T00:00:00Z')), []);
});

test('a backup file is named for its database and its moment', () => {
  const name = backupFileName(new Date('2026-10-01T09:05:00Z'));
  assert.match(name, /^trf_test-2026-10-01-09-05\.dump$/, `got ${name}`);
  // Two backups on the same day must not collide, or the second overwrites the first.
  assert.notEqual(backupFileName(new Date('2026-10-01T09:05:00Z')), backupFileName(new Date('2026-10-01T09:06:00Z')));
  // Nothing in a filename may need escaping on Windows.
  assert.doesNotMatch(name, /[:*?"<>|]/);
});

test('the major version is read out of what pg_dump prints', () => {
  assert.equal(dumpToolMajor('pg_dump (PostgreSQL) 16.15'), 16);
  assert.equal(dumpToolMajor('pg_dump (PostgreSQL) 17.11'), 17);
  assert.equal(dumpToolMajor('pg_dump (PostgreSQL) 9.6.24'), 9);
  assert.equal(dumpToolMajor('not a version at all'), null);
  assert.equal(dumpToolMajor(''), null);
});

test('the dump tool matches the server, or the backup cannot be restored', () => {
  const tools = [
    { path: 'pg17', major: 17 },
    { path: 'pg16', major: 16 },
    { path: 'pg15', major: 15 },
  ];
  // Exact match wins even though a newer one is listed first: a newer pg_dump
  // writes an archive the server's own pg_restore refuses.
  assert.equal(chooseDumpTool(tools, 16)?.path, 'pg16');
  assert.equal(chooseDumpTool(tools, 17)?.path, 'pg17');
  // An older pg_dump is used rather than a newer one, so the archive stays readable.
  assert.equal(chooseDumpTool(tools, 18)?.path, 'pg17');
  // With nothing old enough there is no safe tool at all.
  assert.equal(chooseDumpTool([{ path: 'pg17', major: 17 }], 14), null);
  assert.equal(chooseDumpTool([], 16), null);
});

maybe('liveness answers even when the database cannot be used', async () => {
  const res = await fetch(`${baseUrl}/api/health/live`);
  // The body is read once: a fetch body can only be consumed a single time, so it
  // is never passed as an assertion message.
  const body = await res.json() as { status: string };
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.status, 'live', 'the process is up, whatever the database is doing');
});

maybe('readiness says the database is connected and migrated', async () => {
  const res = await fetch(`${baseUrl}/api/health/ready`);
  const body = await res.json() as { status: string; database: string; migrations: string };
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.status, 'ready');
  assert.equal(body.database, 'connected');
  // A server whose migrations have not been applied must not claim to be ready.
  assert.equal(body.migrations, 'applied');
});

maybe('readiness needs no token, because a monitor has none', async () => {
  assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/health/live`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/health/ready`)).status, 200);
});

maybe('the version on the health endpoints matches the one the client is told', async () => {
  const health = await fetch(`${baseUrl}/api/health`).then((r) => r.json()) as { version: string };
  const meta = await fetch(`${baseUrl}/api/meta`).then((r) => r.json()) as { version: string };
  assert.equal(health.version, meta.version, 'an administrator can tell which build a PC is talking to');
  assert.match(health.version, /^\d+\.\d+\.\d+$/, 'the version is a real one, not a placeholder');
});
