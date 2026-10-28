import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import type { Logger } from 'pino';
import pino from 'pino';
import { config } from '../config';

/**
 * A small rotating file for the API log.
 *
 * This is written by hand rather than pulled in as a dependency because the
 * requirement is narrow: keep a bounded number of days of log on the server's
 * disk, and never lose the file a support engineer is looking at. Rotating on
 * date rather than on size means "yesterday's log" is always one file, whatever
 * the traffic was.
 */

const MAX_FILES = 30;

export interface RotatingFileOptions {
  /** Absolute path of the current log file, without the date suffix. */
  filePath: string;
  /** How many dated copies to keep behind the current one. */
  keep?: number;
  /** Injected so the rotation can be tested without waiting for midnight. */
  now?: () => Date;
}

function stamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The dated file a given day's lines belong in. */
export function logFileFor(options: RotatingFileOptions, date: Date): string {
  const dir = path.dirname(options.filePath);
  const ext = path.extname(options.filePath);
  const base = path.basename(options.filePath, ext);
  return path.join(dir, `${base}-${stamp(date)}${ext}`);
}

/**
 * Removes the oldest dated files once there are more than `keep` of them. The
 * current file is never a candidate, so a running server cannot delete the file
 * it is writing to.
 */
export function pruneOldLogs(options: RotatingFileOptions, at?: Date): string[] {
  const now = at ?? (options.now ? options.now() : new Date());
  const keep = options.keep ?? MAX_FILES;
  const dir = path.dirname(options.filePath);
  const ext = path.extname(options.filePath);
  const base = path.basename(options.filePath, ext);
  if (!fs.existsSync(dir)) return [];

  const pattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{4}-\\d{2}-\\d{2}${ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  const dated = fs.readdirSync(dir).filter((f) => pattern.test(f)).sort();

  // Newest first, then drop whatever is past the limit.
  const excess = dated.slice().reverse().slice(keep);
  for (const name of excess) {
    try { fs.unlinkSync(path.join(dir, name)); } catch { /* another process got there first */ }
  }
  return excess;
}

/**
 * A writable stream that sends each day's lines to that day's file. It re-opens
 * the file when the date changes, which is what makes the log readable a week
 * later without any rotation daemon.
 */
class DailyFile extends Writable {
  private stream: fs.WriteStream | null = null;
  private current: string | null = null;

  constructor(private readonly options: RotatingFileOptions) {
    super();
  }

  private target(): string {
    const now = this.options.now ? this.options.now() : new Date();
    const wanted = logFileFor(this.options, now);
    if (this.current !== wanted) {
      this.stream?.end();
      fs.mkdirSync(path.dirname(wanted), { recursive: true });
      this.stream = fs.createWriteStream(wanted, { flags: 'a' });
      this.current = wanted;
      // Only prune once a day, when a new file is opened.
      pruneOldLogs(this.options, now);
    }
    return wanted;
  }

  override _write(chunk: Buffer | string, _enc: string, done: (err?: Error | null) => void): void {
    const target = this.target();
    fs.appendFile(target, chunk, (err) => done(err ?? null));
  }

  override _final(done: (err?: Error | null) => void): void {
    this.stream?.end(() => done());
  }
}

/**
 * Writes to the console and to a dated file. Development keeps the console
 * output; a deployed server needs the file, because nobody is watching stdout.
 */
export function buildLogger(): Logger {
  const filePath = path.resolve(config.LOG_DIR, 'api.log');
  const file = new DailyFile({ filePath, keep: MAX_FILES });

  return pino(
    {
      level: process.env.LOG_LEVEL ?? 'info',
      // The request body may carry a password or a token, so it is never logged.
      redact: {
        paths: ['req.headers.authorization', 'req.body.password', 'req.body.newPassword',
          'req.body.refreshToken', 'res.headers["set-cookie"]'],
        censor: '[redacted]',
      },
      // A timestamp a support engineer can read beats an epoch number.
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream([{ stream: process.stdout }, { stream: file }]),
  );
}
