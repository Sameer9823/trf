import { Router } from 'express';
import { z } from 'zod';
import type {
  AuditAction, AuditChange, AuditEntry, AuditPage, AuditSortField, AuditSummary,
} from '@trf/shared';
import {
  AUDIT_ACTION_LABELS, AUDIT_ACTIONS, AUDIT_MODULES, AUDIT_SORT_FIELDS, auditTone,
} from '@trf/shared';
import { pool } from '../db';
import { badRequest } from '../lib/errors';
import { authenticate, requirePermission } from '../middleware/auth';

export const auditRouter = Router();
auditRouter.use(authenticate);

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format yyyy-mm-dd.');

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  search: z.string().trim().max(120).default(''),
  module: z.string().trim().max(40).default(''),
  action: z.string().trim().max(60).default(''),
  userId: z.coerce.number().int().positive().optional(),
  recordRef: z.string().trim().max(60).default(''),
  dateFrom: ISO_DATE.optional(),
  dateTo: ISO_DATE.optional(),
  sortBy: z.enum(AUDIT_SORT_FIELDS).default('createdAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

/** Sort keys are looked up, never interpolated from the request. */
const SORT_COLUMNS: Record<AuditSortField, string> = {
  createdAt: 'a.created_at',
  userName: 'a.user_name',
  action: 'a.action',
  module: 'a.module',
  recordRef: 'a.record_ref',
};

interface AuditRow {
  id: number;
  user_id: number | null;
  user_name: string | null;
  action: string;
  module: string;
  record_type: string | null;
  record_ref: string | null;
  old_value: unknown;
  new_value: unknown;
  created_at: Date | string;
}

/**
 * Turns the stored pair of JSON objects into the field-by-field differences a
 * reader can scan. Keys are compared by name, so a row that only carries a
 * `new_value` (a create, or a result recorded with no previous state) reads as a
 * summary instead of a list of changes from nothing.
 *
 * A single-field edit is stored as `{ field: 'remarks', value: ... }` on both
 * sides, because one audit row covers one field. That shape is recognised here so
 * the entry reads "remarks: nothing → text" rather than a field called "value".
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toChanges(oldValue: unknown, newValue: unknown):
{ changes: AuditChange[]; summary: Record<string, string> | null } {
  // Audit JSON values are usually objects, but some entries (e.g. employee field
  // changes) store raw values such as a name string. node-postgres returns those
  // as their primitive type, not an object, so Object.keys / `in` would crash.
  // Treat any non-object as a summary fact rather than a field-by-field diff.
  const before = isPlainObject(oldValue) ? oldValue : {};
  const after = isPlainObject(newValue) ? newValue : {};

  if (typeof after.field === 'string' && 'value' in after) {
    return { changes: [{ field: after.field, old: before.value ?? null, new: after.value ?? null }], summary: null };
  }

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);

  const changes: AuditChange[] = [];
  for (const field of keys) {
    if (!(field in after)) continue;
    const old = before[field] ?? null;
    const next = after[field] ?? null;
    if (String(old) !== String(next)) changes.push({ field, old, new: next });
  }

  // Nothing in common means this was not an edit but a new fact, such as a result
  // being recorded or a note being added.
  if (changes.length === 0 && Object.keys(before).length === 0) {
    const summary: Record<string, string> = {};
    for (const [key, value] of Object.entries(after)) {
      if (value === null || value === undefined) continue;
      summary[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
    return { changes, summary: Object.keys(summary).length ? summary : null };
  }
  return { changes, summary: null };
}

function toEntry(row: AuditRow): AuditEntry {
  const { changes, summary } = toChanges(row.old_value, row.new_value);
  const action = row.action;
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    action,
    module: row.module,
    recordType: row.record_type,
    recordRef: row.record_ref,
    changes,
    summary,
    createdAt: new Date(row.created_at).toISOString(),
    tone: auditTone(action),
    label: AUDIT_ACTION_LABELS[action as AuditAction] ?? action,
  };
}

/**
 * One place builds the WHERE clause, so the count, the page, the summary and the
 * user list can never be describing different sets of rows.
 */
function buildWhere(q: z.infer<typeof listQuerySchema>, extra: string[] = []): {
  sql: string; params: unknown[];
} {
  const where: string[] = [...extra];
  const params: unknown[] = [];

  if (q.search) {
    params.push(`%${q.search.toLowerCase()}%`);
    where.push(`(lower(COALESCE(a.user_name, '')) LIKE $${params.length}
                 OR lower(a.action) LIKE $${params.length}
                 OR lower(COALESCE(a.record_ref, '')) LIKE $${params.length}
                 OR lower(COALESCE(a.record_type, '')) LIKE $${params.length})`);
  }
  if (q.module) { params.push(q.module); where.push(`a.module = $${params.length}`); }
  if (q.action) { params.push(q.action); where.push(`a.action = $${params.length}`); }
  if (q.userId) { params.push(q.userId); where.push(`a.user_id = $${params.length}`); }
  if (q.recordRef) {
    params.push(`%${q.recordRef.toLowerCase()}%`);
    where.push(`lower(COALESCE(a.record_ref, '')) LIKE $${params.length}`);
  }
  // Half-open on the way out, so "up to and including" means the whole day.
  if (q.dateFrom) { params.push(q.dateFrom); where.push(`a.created_at >= $${params.length}::date`); }
  if (q.dateTo) {
    params.push(q.dateTo);
    where.push(`a.created_at < ($${params.length}::date + INTERVAL '1 day')`);
  }

  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/**
 * Read-only. The trail is written in the same transaction as the change it
 * describes, so there is nothing here to correct and nothing a Manager may edit
 * or delete: a gap in the record would be indistinguishable from a change nobody
 * made.
 */
auditRouter.get('/', requirePermission('audit.view'), async (req, res, next) => {
  try {
    const q = listQuerySchema.parse(req.query);

    /**
     * The security figure is one of several readings of the same filter set, so it
     * is an extra condition on the shared clause rather than a second query with
     * its own idea of what "the current filters" means.
     */
    const SECURITY_SQL = `(a.action LIKE 'auth.login%'
                          OR a.action LIKE '%deactivated%'
                          OR a.action LIKE '%password%')`;
    const { sql: whereSql, params } = buildWhere(q);
    const { sql: securityWhereSql } = buildWhere(q, [SECURITY_SQL]);
    // Also built through the shared clause, so an unfiltered request does not end
    // up with a dangling AND.
    const { sql: signedInWhereSql, params: signedInParams } = buildWhere(q, ['a.user_id IS NOT NULL']);

    const countResult = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_logs a ${whereSql}`, params);
    const total = Number(countResult.rows[0].count);

    const sortColumn = SORT_COLUMNS[q.sortBy];
    const dir = q.sortDir === 'desc' ? 'DESC' : 'ASC';
    // The id tiebreak keeps paging stable when many rows share a timestamp.
    const rows = await pool.query<AuditRow>(
      `SELECT a.id, a.user_id, a.user_name, a.action, a.module, a.record_type, a.record_ref,
              a.old_value, a.new_value, a.created_at
       FROM audit_logs a ${whereSql}
       ORDER BY ${sortColumn} ${dir}, a.id ${dir}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, q.pageSize, (q.page - 1) * q.pageSize],
    );

    // The summary and the user list both run over the same filters as the page,
    // so the counts beside a filter describe what selecting it would show.
    const [byModule, byUser, byDay, security, users] = await Promise.all([
      pool.query<{ module: string; count: string }>(
        `SELECT a.module, count(*)::text AS count FROM audit_logs a ${whereSql}
         GROUP BY a.module ORDER BY count(*) DESC, a.module ASC`, params),
      pool.query<{ user_id: number | null; user_name: string | null; count: string }>(
        `SELECT a.user_id, a.user_name, count(*)::text AS count FROM audit_logs a ${whereSql}
         GROUP BY a.user_id, a.user_name ORDER BY count(*) DESC, a.user_name ASC LIMIT 25`, params),
      pool.query<{ day: string; count: string }>(
        `SELECT to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::text AS count
         FROM audit_logs a ${whereSql}
         GROUP BY day ORDER BY day DESC LIMIT 7`, params),
      pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_logs a ${securityWhereSql}`, params),
      pool.query<{ id: number; full_name: string }>(
        `SELECT DISTINCT a.user_id AS id, a.user_name AS full_name
         FROM audit_logs a ${signedInWhereSql}
         ORDER BY a.user_name ASC`, signedInParams),
    ]);

    const summary: AuditSummary = {
      total,
      byModule: byModule.rows.map((r) => ({ module: r.module, count: Number(r.count) })),
      byUser: byUser.rows.map((r) => ({ userId: r.user_id, userName: r.user_name, count: Number(r.count) })),
      securityEvents: Number(security.rows[0]?.count ?? 0),
      byDay: byDay.rows.map((r) => ({ day: r.day, count: Number(r.count) })),
    };

    const body: AuditPage = {
      items: rows.rows.map(toEntry),
      total,
      page: q.page,
      pageSize: q.pageSize,
      pageCount: Math.max(1, Math.ceil(total / q.pageSize)),
      summary,
      users: users.rows.map((r) => ({ id: r.id, fullName: r.full_name })),
    };
    res.json(body);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(badRequest('Some filters are not valid.', { filters: err.issues[0].message }));
    }
    next(err);
  }
});

/**
 * What a given record has been through, newest first. This is the view that
 * answers "why is this TRF like this?" without reading the whole trail.
 */
auditRouter.get('/record/:type/:ref', requirePermission('audit.view'), async (req, res, next) => {
  try {
    const type = z.string().trim().min(1).max(60).parse(req.params.type);
    const ref = z.string().trim().min(1).max(80).parse(req.params.ref);
    const limit = z.coerce.number().int().min(1).max(200).default(100).parse(req.query.limit);

    const rows = await pool.query<AuditRow>(
      `SELECT a.id, a.user_id, a.user_name, a.action, a.module, a.record_type, a.record_ref,
              a.old_value, a.new_value, a.created_at
       FROM audit_logs a
       WHERE a.record_type = $1 AND a.record_ref = $2
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT $3`,
      [type, ref, limit],
    );
    res.json({ items: rows.rows.map(toEntry) });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(badRequest('That record reference is not valid.', { filters: err.issues[0].message }));
    }
    next(err);
  }
});

/** The vocabulary the filter bar offers, so it never lists a value nothing wrote. */
auditRouter.get('/vocabulary', requirePermission('audit.view'), async (_req, res, next) => {
  try {
    // Only actions and modules that actually appear, so the filter is honest about
    // what this installation has done. The full lists stay the fallback.
    const used = await pool.query<{ module: string; action: string }>(
      `SELECT DISTINCT module, action FROM audit_logs ORDER BY module, action`);
    const present = new Set(used.rows.map((r) => r.action));
    const modules = new Set(used.rows.map((r) => r.module));

    res.json({
      modules: AUDIT_MODULES.filter((m) => modules.has(m)),
      actions: AUDIT_ACTIONS.filter((a) => present.has(a)),
      recordTypes: await distinctRecordTypes(),
    });
  } catch (err) {
    next(err);
  }
});

async function distinctRecordTypes(): Promise<string[]> {
  const rows = await pool.query<{ record_type: string }>(
    `SELECT DISTINCT record_type FROM audit_logs WHERE record_type IS NOT NULL ORDER BY record_type`);
  return rows.rows.map((r) => r.record_type);
}
