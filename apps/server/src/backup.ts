import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, DOCUMENT_DIR } from './config.js';
import { pool } from './db.js';

/**
 * Makes a restorable copy of the database with `pg_dump`, then keeps a bounded
 * number of them. The alternative — telling an administrator to remember a
 * pg_dump command — is how a company ends up discovering it has no backup on the
 * day it needs one.
 *
 * The password is passed through the environment rather than on the command
 * line, because a command line is visible to every process on the machine.
 */

/** Backups older than this are removed after a new one succeeds. */
const KEEP_DAYS = 30;

/** Expired or revoked tokens older than this are deleted after a backup. */
const TOKEN_KEEP_DAYS = 30;

function backupDir(): string {
  return path.resolve(process.env.BACKUP_DIR ?? './backups');
}

/** `trf_system-2026-10-01-0900.dump`, so a restore needs no guessing. */
export function backupFileName(date: Date): string {
  const stamp = date.toISOString().replace(/[:T]/g, '-').slice(0, 16);
  return `${config.DATABASE_NAME}-${stamp}.dump`;
}

/**
 * The documents folder beside the dump: uploaded result PDFs and generated TRF
 * PDFs live on disk, not in the database, so a database-only backup would lose
 * them. Same stamp as the dump, so a dump and its documents sort together.
 */
export function documentsBackupName(date: Date): string {
  const stamp = date.toISOString().replace(/[:T]/g, '-').slice(0, 16);
  return `${config.DATABASE_NAME}-${stamp}-documents`;
}

interface RunResult { code: number; stdout: string; stderr: string }

/** Runs a PostgreSQL tool with the database password in the environment. */
function run(tool: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(tool, args, {
      // No shell: a path or a password can never be read as a command.
      shell: false,
      env: { ...process.env, PGPASSWORD: config.DATABASE_PASSWORD },
    });
    let stdout = '';
    let stderr = '';
    // `--version` writes to stdout while errors write to stderr, so both are kept.
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * Where pg_dump may live on a Windows workstation, newest install first. The list
 * is only a place to start: the tool actually used is chosen by matching the
 * server's major version, because that is the difference between a backup that
 * restores and one that does not.
 */
export const PGDUMP_CANDIDATES = [
  'pg_dump',
  path.join('C:', 'Program Files', 'PostgreSQL', '17', 'bin', 'pg_dump.exe'),
  path.join('C:', 'Program Files', 'PostgreSQL', '16', 'bin', 'pg_dump.exe'),
  path.join('C:', 'Program Files', 'PostgreSQL', '15', 'bin', 'pg_dump.exe'),
];

export interface DumpTool { path: string; major: number }

/** "pg_dump (PostgreSQL) 16.15" -> 16. Anything unparseable is skipped. */
export function dumpToolMajor(versionOutput: string): number | null {
  const match = /(\d+)(?:\.\d+)?/.exec(versionOutput);
  return match ? Number(match[1]) : null;
}

/** Every pg_dump on this machine that answers, newest first. */
async function findDumpTools(candidates: string[]): Promise<DumpTool[]> {
  const found: DumpTool[] = [];
  for (const candidate of candidates) {
    const probe = await run(candidate, ['--version']);
    if (probe.code !== 0) continue;
    const major = dumpToolMajor(probe.stdout.trim());
    if (major === null) continue;
    found.push({ path: candidate, major });
  }
  return found.sort((a, b) => b.major - a.major);
}

/**
 * Picks the pg_dump whose major version matches the server.
 *
 * This matters more than it looks. A dump written by a newer pg_dump uses a
 * newer archive format, and the server's own pg_restore refuses it outright
 * ("unsupported version in file header"). On a machine with two PostgreSQL
 * installations that means picking the wrong one produces backups that look
 * fine on disk and cannot be restored on the day they are needed.
 */
export function chooseDumpTool(tools: DumpTool[], serverMajor: number): DumpTool | null {
  return tools.find((t) => t.major === serverMajor)
    ?? tools.find((t) => t.major < serverMajor)
    ?? null;
}

async function serverMajorVersion(): Promise<number | null> {
  try {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT current_setting('server_version_num') AS n`,
    );
    // server_version_num is a single number: 160015 means 16.15, so the major
    // version is everything but the last four digits.
    const num = Number(rows[0]?.n ?? 0);
    return num > 0 ? Math.floor(num / 10000) : null;
  } catch {
    return null;
  }
}

async function pickDumpTool(): Promise<DumpTool> {
  const tried = PGDUMP_CANDIDATES.join('\n  ');
  const tools = await findDumpTools(PGDUMP_CANDIDATES);
  if (tools.length === 0) {
    throw new Error(`pg_dump was not found. Install the PostgreSQL client tools, or set PATH.\nTried:\n  ${tried}`);
  }

  const serverMajor = await serverMajorVersion();
  const chosen = serverMajor === null ? tools[tools.length - 1] : chooseDumpTool(tools, serverMajor);

  if (!chosen) {
    throw new Error(
      `No pg_dump matches this server (PostgreSQL ${serverMajor}).\n`
      + `Installed: ${tools.map((t) => `${t.path} (${t.major})`).join(', ')}\n`
      + 'Install the client tools for the server version, or run the backup from that installation.',
    );
  }

  // A newer pg_dump would still dump the data, but its archive cannot be read by
  // the server's own pg_restore, so it is called out rather than used quietly.
  if (serverMajor !== null && chosen.major > serverMajor) {
    console.warn(
      `Warning: using pg_dump ${chosen.major} against a PostgreSQL ${serverMajor} server. `
      + `The dump may not be restorable by this server's pg_restore.`,
    );
  }
  console.log(`Using ${chosen.path} (PostgreSQL ${chosen.major}) against server ${serverMajor ?? 'unknown'}.`);
  return chosen;
}

function prune(dir: string, keepDays: number, keep: Set<string>): string[] {
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  const removed: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    // A file this run just wrote is never a candidate for deletion.
    if (keep.has(name)) continue;
    if (!name.startsWith(`${config.DATABASE_NAME}-`)) continue;
    const full = path.join(dir, name);
    try {
      // Both the .dump files and the -documents folders are pruned the same way;
      // rmSync removes either, and force ignores an entry that vanished already.
      if (fs.statSync(full).mtimeMs < cutoff) { fs.rmSync(full, { recursive: true, force: true }); removed.push(name); }
    } catch { /* already gone */ }
  }
  return removed;
}

async function backup(): Promise<void> {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });

  const tool = await pickDumpTool();
  const target = path.join(dir, backupFileName(new Date()));
  const args = [
    // Custom format, so a restore can rebuild indexes and be selective.
    '--format=custom', '--no-owner', '--no-privileges',
    '--host', config.DATABASE_HOST, '--port', String(config.DATABASE_PORT),
    '--username', config.DATABASE_USER,
    '--file', target,
    config.DATABASE_NAME,
  ];

  console.log(`Backing up ${config.DATABASE_NAME} to ${target}`);
  const result = await run(tool.path, args);
  if (result.code !== 0) {
    console.error(`The backup failed: ${result.stderr.trim()}`);
    process.exitCode = 1;
    return;
  }

  // A zero-byte dump is not a backup, and it would look like one on disk.
  const bytes = fs.statSync(target).size;
  if (bytes === 0) {
    console.error(`The backup produced an empty file and has been discarded: ${target}`);
    fs.unlinkSync(target);
    process.exitCode = 1;
    return;
  }

  console.log(`Backup complete: ${target} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);

  // The dump holds the database; the documents on disk are the other half. Copy
  // DOCUMENT_DIR beside the dump so a restore brings back the PDFs too. Skipped
  // silently when the folder does not exist (nothing has been generated yet).
  const keep = new Set([path.basename(target)]);
  if (fs.existsSync(DOCUMENT_DIR)) {
    const docsTarget = path.join(dir, documentsBackupName(new Date()));
    try {
      fs.cpSync(DOCUMENT_DIR, docsTarget, { recursive: true });
      keep.add(path.basename(docsTarget));
      console.log(`Documents copied: ${docsTarget}`);
    } catch (err) {
      // The dump is intact, but the backup is incomplete without the documents,
      // so the run is marked failed rather than reported as a clean backup.
      console.error(`Could not copy documents from ${DOCUMENT_DIR}: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  }

  const removed = prune(dir, KEEP_DAYS, keep);
  if (removed.length) console.log(`Removed ${removed.length} backup(s) older than ${KEEP_DAYS} days.`);

  await pruneExpiredTokens();
}

/**
 * Deletes tokens that expired or were revoked/used more than TOKEN_KEEP_DAYS ago.
 * Old rows are dead weight and a needless liability; the backup is a natural
 * once-a-day moment to clear them.
 */
async function pruneExpiredTokens(): Promise<void> {
  const cutoff = new Date(Date.now() - TOKEN_KEEP_DAYS * 24 * 60 * 60 * 1000);
  const refresh = await pool.query(
    `DELETE FROM refresh_tokens WHERE expires_at < $1 OR revoked_at < $1`,
    [cutoff],
  );
  const reset = await pool.query(
    `DELETE FROM password_reset_tokens WHERE expires_at < $1 OR used_at < $1`,
    [cutoff],
  );
  const total = (refresh.rowCount ?? 0) + (reset.rowCount ?? 0);
  if (total) console.log(`Removed ${total} expired/revoked token(s) older than ${TOKEN_KEEP_DAYS} days.`);
}

/** Counts, so a restore can be checked without trusting the file alone. */
export async function rowCounts(): Promise<Record<string, string>> {
  const tables = ['trfs', 'analysis_tests', 'analysis_results', 'coas', 'coa_lines',
    'employees', 'audit_logs', 'customers', 'products'];
  const result = await pool.query<{ table_name: string; n: string }>(
    `SELECT table_name, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I', table_name), false, true, '')))[1]::text AS n
     FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)
     ORDER BY table_name`,
    [tables],
  );
  return Object.fromEntries(result.rows.map((r) => [r.table_name, r.n]));
}

async function main() {
  const mode = process.argv[2] ?? 'backup';
  if (mode === 'counts') {
    console.log(JSON.stringify(await rowCounts(), null, 2));
    return;
  }
  if (mode !== 'backup') {
    console.error('Usage: npm run backup -w @trf/server -- [backup|counts]');
    process.exitCode = 1;
    return;
  }
  await backup();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch((err) => {
      console.error((err as Error).message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
