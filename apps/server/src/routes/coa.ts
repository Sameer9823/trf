import { Router } from 'express';
import { z } from 'zod';
import type { Coa, CoaPage, CoaStatus, CoaSummary, EmployeeProfile, TrfStatus } from '@trf/shared';
import { COA_STATUS_TRANSITIONS, canTransitionCoa, canTransitionTrf } from '@trf/shared';
import { pool, withTransaction } from '../db';
import { badRequest, conflict, notFound, versionConflict } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { nextNumber } from '../lib/numbers';
import {
  COA_FROM, COA_SELECT, COA_SORT_SQL, CoaLineRow, CoaRow, buildCoaWhere,
  coaListQuerySchema, toCoa, toCoaFilters,
} from '../lib/coa-query';
import { authenticate, currentEmployee, requirePermission, validateBody } from '../middleware/auth';

export const coaRouter = Router();
coaRouter.use(authenticate);

const createSchema = z.object({
  trfId: z.number().int().positive(),
  remarks: z.string().trim().max(2000).nullable().optional(),
});

const actionSchema = z.object({
  version: z.number().int().positive(),
  note: z.string().trim().max(1000).nullable().optional(),
});

/** A send-back must say what is wrong, or the same draft goes round again. */
const returnSchema = z.object({
  version: z.number().int().positive(),
  note: z.string().trim().min(3, 'Say what needs changing.').max(1000),
});

coaRouter.get('/', requirePermission('coa.view'), async (req, res, next) => {
  try {
    const viewer = currentEmployee(req);
    const q = coaListQuerySchema.parse(req.query);
    const filters = toCoaFilters(q);
    // "Mine" is a filter, not a permission change: it only ever narrows.
    const scope = filters.mineOnly ? { employeeId: viewer.id } : null;

    const params: unknown[] = [];
    const whereSql = buildCoaWhere(filters, params, scope);

    const countResult = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count ${COA_FROM} ${whereSql}`, params);
    const total = Number(countResult.rows[0].count);

    const sortColumn = COA_SORT_SQL[filters.sortBy];
    const dir = filters.sortDir === 'asc' ? 'ASC' : 'DESC';
    const rows = await pool.query<CoaRow>(
      `SELECT ${COA_SELECT} ${COA_FROM} ${whereSql}
       ORDER BY ${sortColumn} ${dir} NULLS LAST, c.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filters.pageSize, (filters.page - 1) * filters.pageSize],
    );

    const lines = rows.rows.length ? await loadLines(rows.rows.map((r) => r.id)) : new Map<number, CoaLineRow[]>();
    const body: CoaPage = {
      items: rows.rows.map((row) => toCoa(row, lines.get(row.id) ?? [])),
      total, page: filters.page, pageSize: filters.pageSize,
      pageCount: Math.max(1, Math.ceil(total / filters.pageSize)),
    };
    res.json(body);
  } catch (err) {
    if (err instanceof z.ZodError) return next(badRequest('Some filters are not valid.', { filters: err.issues[0].message }));
    next(err);
  }
});

/** One round trip for every certificate on the page, keyed by COA id. */
async function loadLines(coaIds: number[]): Promise<Map<number, CoaLineRow[]>> {
  const grouped = await pool.query<CoaLineRow & { coa_id: number }>(
    `SELECT coa_id, id, analysis_test_id, test_name, test_method, specification, result_value,
            result_text, unit, lower_limit, upper_limit, outcome
     FROM coa_lines WHERE coa_id = ANY($1::int[]) ORDER BY coa_id, sort_order ASC, test_name ASC`, [coaIds]);
  const map = new Map<number, CoaLineRow[]>();
  for (const row of grouped.rows) {
    const list = map.get(row.coa_id) ?? [];
    list.push(row);
    map.set(row.coa_id, list);
  }
  return map;
}

coaRouter.get('/summary', requirePermission('coa.view'), async (req, res, next) => {
  try {
    const viewer = currentEmployee(req);
    const q = coaListQuerySchema.parse(req.query);
    const filters = toCoaFilters(q);
    const params: unknown[] = [];
    const whereSql = buildCoaWhere(filters, params, filters.mineOnly ? { employeeId: viewer.id } : null);
    const result = await pool.query<Record<string, string>>(
      `SELECT count(*)::text AS total,
         count(*) FILTER (WHERE c.status = 'Pending')::text AS pending,
         count(*) FILTER (WHERE c.status = 'Draft')::text AS draft,
         count(*) FILTER (WHERE c.status = 'Under Review')::text AS under_review,
         count(*) FILTER (WHERE c.status = 'Approved')::text AS approved,
         count(*) FILTER (WHERE c.status = 'Issued')::text AS issued
       ${COA_FROM} ${whereSql}`, params);
    const row = result.rows[0];
    const summary: CoaSummary = {
      total: Number(row.total), pending: Number(row.pending), draft: Number(row.draft),
      underReview: Number(row.under_review), approved: Number(row.approved), issued: Number(row.issued),
    };
    res.json(summary);
  } catch (err) {
    if (err instanceof z.ZodError) return next(badRequest('Some filters are not valid.', { filters: err.issues[0].message }));
    next(err);
  }
});

async function loadCoa(id: number): Promise<Coa> {
  const result = await pool.query<CoaRow>(`SELECT ${COA_SELECT} ${COA_FROM} WHERE c.id = $1`, [id]);
  const row = result.rows[0];
  if (!row) throw notFound();
  const lines = await loadLines([id]);
  return toCoa(row, lines.get(id) ?? []);
}

coaRouter.get('/:id', requirePermission('coa.view'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    res.json(await loadCoa(id));
  } catch (err) {
    next(err);
  }
});

coaRouter.get('/trfs/:trfId', requirePermission('coa.view'), async (req, res, next) => {
  try {
    const trfId = Number(req.params.trfId);
    if (!Number.isInteger(trfId) || trfId <= 0) throw notFound();
    const result = await pool.query<{ id: number }>(`SELECT id FROM coas WHERE trf_id = $1`, [trfId]);
    if (!result.rows[0]) return res.json({ coa: null });
    res.json({ coa: await loadCoa(result.rows[0].id) });
  } catch (err) {
    next(err);
  }
});

/**
 * Drafts a certificate from a TRF whose analysis is complete. The lines are a
 * snapshot: an issued certificate must keep showing what was measured on the day,
 * even if the live result is later corrected by a re-test.
 */
coaRouter.post('/', requirePermission('coa.prepare'), validateBody(createSchema), async (req, res, next) => {
  const user = currentEmployee(req);
  try {
    const { trfId, remarks } = req.body as z.infer<typeof createSchema>;

    const created = await withTransaction(async (client) => {
      const trf = await client.query<{
        id: number; trf_number: string; status: TrfStatus; version: number; trf_date: string;
      }>(`SELECT id, trf_number, status, version, trf_date FROM trfs WHERE id = $1 FOR UPDATE`, [trfId]);
      const record = trf.rows[0];
      if (!record) throw notFound();

      const existing = await client.query<{ id: number; status: CoaStatus }>(
        `SELECT id, status FROM coas WHERE trf_id = $1`, [trfId]);
      if (existing.rows[0]) {
        throw conflict(`A certificate already exists for ${record.trf_number} (${existing.rows[0].status}).`);
      }
      // A certificate states results, so every test must be finished first.
      // Assigned and In Progress both mean the work is still open on the bench.
      if (!canTransitionTrf(record.status, 'COA Pending')) {
        const inProgress = record.status === 'Assigned' || record.status === 'In Progress';
        throw conflict(inProgress
          ? `${record.trf_number} is ${record.status}. Complete all its tests before drafting a certificate.`
          : `${record.trf_number} is ${record.status} and cannot have a certificate.`);
      }

      const open = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM analysis_tests
         WHERE trf_id = $1 AND status <> 'Completed'`, [trfId]);
      if (Number(open.rows[0].count) > 0) {
        throw conflict(`${open.rows[0].count} test(s) on ${record.trf_number} are not completed yet.`);
      }

      const inserted = await client.query<{ id: number }>(
        `INSERT INTO coas (trf_id, status, remarks, prepared_by, prepared_at)
         VALUES ($1, 'Draft', $2, $3, now()) RETURNING id`,
        [trfId, remarks ?? null, user.id]);
      const coaId = inserted.rows[0].id;

      // Copy each result onto the certificate. The outcome is recomputed here
      // rather than read from the test, so the certificate judges what it prints.
      const lines = await client.query<{
        test_name: string; test_method: string | null; specification: string | null;
        result_value: string | number | null; result_text: string | null; unit: string | null;
        lower_limit: string | number | null; upper_limit: string | number | null;
        outcome: string; analysis_test_id: number;
      }>(
        `SELECT a.id AS analysis_test_id, a.test_name, a.test_method, a.specification,
                r.result_value, r.result_text, r.unit, r.lower_limit, r.upper_limit,
                CASE
                  WHEN r.id IS NULL THEN 'Not Tested'
                  WHEN (r.lower_limit IS NULL AND r.upper_limit IS NULL) OR r.result_value IS NULL THEN 'Not Specified'
                  WHEN r.result_value BETWEEN r.lower_limit AND r.upper_limit THEN 'Pass'
                  ELSE 'Fail'
                END AS outcome
         FROM analysis_tests a LEFT JOIN analysis_results r ON r.analysis_test_id = a.id
         WHERE a.trf_id = $1 ORDER BY a.test_name ASC`,
        [trfId]);

      for (const [index, line] of lines.rows.entries()) {
        await client.query(
          `INSERT INTO coa_lines (coa_id, analysis_test_id, test_name, test_method, specification,
              result_value, result_text, unit, lower_limit, upper_limit, outcome, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [coaId, line.analysis_test_id, line.test_name, line.test_method, line.specification,
            line.result_value, line.result_text, line.unit, line.lower_limit, line.upper_limit,
            line.outcome, index],
        );
      }

      await moveTrf(client, record.id, record.status, 'COA Pending', user,
        `Certificate drafted for ${record.trf_number}`);

      await writeAudit(client, {
        userId: user.id, userName: user.fullName, action: 'coa.drafted', module: 'coa',
        recordType: 'Coa', recordRef: record.trf_number,
        newValue: { trfNumber: record.trf_number, tests: lines.rows.length, remarks: remarks ?? null },
      });
      return coaId;
    });

    res.status(201).json(await loadCoa(created));
  } catch (err) {
    next(err);
  }
});

/** Moves the TRF alongside the certificate, writing its status history. */
async function moveTrf(
  client: import('pg').PoolClient,
  trfId: number,
  from: TrfStatus,
  to: TrfStatus,
  user: EmployeeProfile,
  note: string,
): Promise<void> {
  if (!canTransitionTrf(from, to)) return;
  const updated = await client.query(
    `UPDATE trfs SET status = $2, version = version + 1 WHERE id = $1 AND status = $3`,
    [trfId, to, from]);
  if (updated.rowCount === 0) return;
  await client.query(
    `INSERT INTO trf_status_history (trf_id, old_status, new_status, changed_by, note)
     VALUES ($1, $2, $3, $4, $5)`,
    [trfId, from, to, user.id, note],
  );
  await writeAudit(client, {
    userId: user.id, userName: user.fullName, action: 'trf.status_changed', module: 'trf',
    recordType: 'TRF', recordRef: String(trfId),
    oldValue: { status: from }, newValue: { status: to, reason: note },
  });
}

/**
 * One place for every status step: locks the certificate, checks the version,
 * refuses a move the transition table does not allow, stamps the person and the
 * time, and writes the audit row in the same transaction.
 */
async function step(
  id: number,
  version: number,
  to: CoaStatus,
  user: EmployeeProfile,
  stamp: { column: 'prepared' | 'reviewed' | 'approved' | 'issued'; action: string; note?: string | null },
  extra?: (client: import('pg').PoolClient, current: { trf_number: string; reviewed_by: number | null }) => Promise<void>,
): Promise<void> {
  await withTransaction(async (client) => {
    const locked = await client.query<{
      status: CoaStatus; version: number; trf_number: string; trf_id: number;
      trf_status: TrfStatus; reviewed_by: number | null; prepared_by: number | null;
    }>(
      `SELECT c.status, c.version, c.trf_id, c.reviewed_by, c.prepared_by, t.trf_number, t.status AS trf_status
       FROM coas c JOIN trfs t ON t.id = c.trf_id
       WHERE c.id = $1 FOR UPDATE OF c`, [id],
    );
    const current = locked.rows[0];
    if (!current) throw notFound();
    if (current.version !== version) throw versionConflict();

    // A certificate is checked by someone other than the person who wrote it.
    if (to === 'Approved' && current.prepared_by === user.id) {
      throw conflict('You prepared this certificate, so someone else must approve it.');
    }

    if (!canTransitionCoa(current.status, to)) {
      const allowed = COA_STATUS_TRANSITIONS[current.status];
      throw conflict(allowed.length
        ? `A certificate that is ${current.status} can only change to: ${allowed.join(', ')}.`
        : `A certificate that is ${current.status} cannot change status any further.`);
    }

    // The number is minted on issue, inside the same transaction, so a withdrawn
    // draft never burns one and two clerks cannot collide. It has to exist before
    // the status moves: an Issued certificate is never allowed to be unnumbered.
    const coaNumber = to === 'Issued'
      ? await nextNumber(client, 'COA', new Date().getFullYear())
      : null;

    // An Issued certificate is final: nothing about it may be edited afterwards.
    const updated = await client.query(
      `UPDATE coas SET status = $2,
         ${stamp.column}_by = $3, ${stamp.column}_at = now(), version = version + 1
         ${coaNumber ? ', coa_number = $5' : ''}
       WHERE id = $1 AND version = $4`,
      coaNumber ? [id, to, user.id, version, coaNumber] : [id, to, user.id, version],
    );
    if (updated.rowCount === 0) throw versionConflict();

    if (to === 'Issued' && coaNumber) {
      await moveTrf(client, current.trf_id, current.trf_status, 'Completed', user,
        `Certificate ${coaNumber} issued`);
      await writeAudit(client, {
        userId: user.id, userName: user.fullName, action: 'coa.issued', module: 'coa',
        recordType: 'Coa', recordRef: coaNumber,
        newValue: { coaNumber, trfNumber: current.trf_number, note: stamp.note ?? null },
      });
      return;
    }

    await writeAudit(client, {
      userId: user.id, userName: user.fullName, action: stamp.action, module: 'coa',
      recordType: 'Coa', recordRef: current.trf_number,
      oldValue: { status: current.status }, newValue: { status: to, note: stamp.note ?? null },
    });
    if (extra) await extra(client, current);
  });
}

coaRouter.post('/:id/submit', requirePermission('coa.prepare'), validateBody(actionSchema), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    const { version, note } = req.body as z.infer<typeof actionSchema>;
    await step(id, version, 'Under Review', currentEmployee(req),
      { column: 'reviewed', action: 'coa.submitted_for_review', note });
    res.json(await loadCoa(id));
  } catch (err) {
    next(err);
  }
});

coaRouter.post('/:id/approve', requirePermission('coa.approve'), validateBody(actionSchema), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    const { version, note } = req.body as z.infer<typeof actionSchema>;
    await step(id, version, 'Approved', currentEmployee(req),
      { column: 'approved', action: 'coa.approved', note });
    res.json(await loadCoa(id));
  } catch (err) {
    next(err);
  }
});

coaRouter.post('/:id/return', requirePermission('coa.prepare'), validateBody(returnSchema), async (req, res, next) => {
  const user = currentEmployee(req);
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    const { version, note } = req.body as z.infer<typeof returnSchema>;
    // Sending it back clears the review stamp: it has to be looked at again.
    await step(id, version, 'Draft', user,
      { column: 'reviewed', action: 'coa.returned', note },
      async (client, current: { trf_number: string; reviewed_by: number | null }) => {
        await client.query(
          `UPDATE coas SET reviewed_by = NULL, reviewed_at = NULL WHERE id = $1`, [id]);
        await writeAudit(client, {
          userId: user.id, userName: user.fullName,
          action: 'coa.review_cleared', module: 'coa', recordType: 'Coa', recordRef: current.trf_number,
          oldValue: { reviewedBy: current.reviewed_by },
        });
      });
    res.json(await loadCoa(id));
  } catch (err) {
    next(err);
  }
});

coaRouter.post('/:id/issue', requirePermission('coa.issue'), validateBody(actionSchema), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    const { version, note } = req.body as z.infer<typeof actionSchema>;
    await step(id, version, 'Issued', currentEmployee(req),
      { column: 'issued', action: 'coa.issued', note });
    res.json(await loadCoa(id));
  } catch (err) {
    next(err);
  }
});

/** Refuses any change to a certificate that has already been issued. */
coaRouter.patch('/:id', requirePermission('coa.prepare'), validateBody(z.object({
  version: z.number().int().positive(),
  remarks: z.string().trim().max(2000).nullable().optional(),
})), async (req, res, next) => {
  const user = currentEmployee(req);
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    const body = req.body as { version: number; remarks?: string | null };
    if (body.remarks === undefined) throw badRequest('There is nothing to update.');

    await withTransaction(async (client) => {
      const locked = await client.query<{ status: CoaStatus; version: number; trf_number: string; remarks: string | null }>(
        `SELECT c.status, c.version, c.remarks, t.trf_number
         FROM coas c JOIN trfs t ON t.id = c.trf_id WHERE c.id = $1 FOR UPDATE OF c`, [id]);
      const current = locked.rows[0];
      if (!current) throw notFound();
      if (current.version !== body.version) throw versionConflict();
      if (current.status === 'Issued') {
        throw conflict('An issued certificate cannot be changed.');
      }
      await client.query(
        `UPDATE coas SET remarks = $2, version = version + 1 WHERE id = $1 AND version = $3`,
        [id, body.remarks ?? null, body.version],
      );
      await writeAudit(client, {
        userId: user.id, userName: user.fullName, action: 'coa.remarks_changed', module: 'coa',
        recordType: 'Coa', recordRef: current.trf_number,
        oldValue: { remarks: current.remarks }, newValue: { remarks: body.remarks ?? null },
      });
    });

    res.json(await loadCoa(id));
  } catch (err) {
    next(err);
  }
});

/** Who is waiting on what, for the queue a clerk works through. */
coaRouter.get('/:id/audit', requirePermission('coa.view'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    const exists = await pool.query<{ id: number }>(`SELECT id FROM coas WHERE id = $1`, [id]);
    if (!exists.rows[0]) throw notFound();
    const rows = await pool.query<{ action: string; user_name: string | null; created_at: Date; new_value: unknown }>(
      `SELECT action, user_name, created_at, new_value FROM audit_logs
       WHERE module = 'coa' AND record_ref IN (
         SELECT COALESCE(coa_number, t.trf_number) FROM coas c JOIN trfs t ON t.id = c.trf_id WHERE c.id = $1)
       ORDER BY created_at ASC, id ASC`, [id]);
      res.json({
      items: rows.rows.map((r) => ({
        action: r.action, userName: r.user_name, at: new Date(r.created_at).toISOString(),
      })),
    });
  } catch (err) {
    next(err);
  }
});
