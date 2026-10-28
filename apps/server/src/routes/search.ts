import { Router } from 'express';
import { z } from 'zod';
import type { AnalysisStatus, CoaStatus, Priority, TrfStatus } from '@trf/shared';
import { roleHasPermission } from '@trf/shared';
import { pool } from '../db';
import { badRequest } from '../lib/errors';
import { authenticate, currentEmployee } from '../middleware/auth';

export const searchRouter = Router();
searchRouter.use(authenticate);

const searchQuerySchema = z.object({
  q: z.string().trim().min(2, 'Type at least 2 characters.').max(120),
  limit: z.coerce.number().int().min(1).max(20).default(6),
});

/**
 * One search box for the three record types a user actually looks things up by:
 * the TRF number, the analysis test, and the certificate number. Each branch
 * applies the same scope rule the matching list uses, so search can never reveal
 * a record the list would refuse to show.
 */
searchRouter.get('/', async (req, res, next) => {
  try {
    const viewer = currentEmployee(req);
    const { q, limit } = searchQuerySchema.parse(req.query);
    const pattern = `%${q.toLowerCase()}%`;

    const canSeeAllTrfs = roleHasPermission(viewer.role, 'trf.viewAll');
    const canSeeAllTests = roleHasPermission(viewer.role, 'analysis.viewAll');

    // TRF: the number, plus the product, batch and customer people search by.
    const trfResult = await pool.query<{
      id: number; trf_number: string; status: TrfStatus; priority: Priority;
      trf_date: Date | string; product_name: string | null; batch_number: string | null; customer_name: string | null;
    }>(
      `SELECT t.id, t.trf_number, t.status, t.priority, t.trf_date,
              p.name AS product_name, t.batch_number, cu.name AS customer_name
         FROM trfs t
         LEFT JOIN products p ON p.id = t.product_id
         LEFT JOIN customers cu ON cu.id = t.customer_id
        WHERE (lower(t.trf_number) LIKE $1
               OR lower(COALESCE(t.batch_number, '')) LIKE $1
               OR lower(COALESCE(p.name, '')) LIKE $1
               OR lower(COALESCE(cu.name, '')) LIKE $1)
          ${canSeeAllTrfs ? '' : 'AND (t.assigned_employee_id = $2 OR t.created_by = $2)'}
        ORDER BY t.trf_date DESC, t.id DESC
        LIMIT $${canSeeAllTrfs ? 2 : 3}`,
      canSeeAllTrfs ? [pattern, limit] : [pattern, viewer.id, limit],
    );

    // Analysis test: the test name, the parent TRF number, or a result value.
    const analysisResult = await pool.query<{
      id: number; trf_id: number; trf_number: string; test_name: string; status: AnalysisStatus;
      due_date: Date | string | null; result_text: string | null;
    }>(
      `SELECT a.id, a.trf_id, t.trf_number, a.test_name, a.status, a.due_date, r.result_text
         FROM analysis_tests a
         JOIN trfs t ON t.id = a.trf_id
         LEFT JOIN analysis_results r ON r.analysis_test_id = a.id
        WHERE (lower(a.test_name) LIKE $1
               OR lower(t.trf_number) LIKE $1
               OR lower(COALESCE(r.result_text, '')) LIKE $1)
          ${canSeeAllTests ? '' : 'AND a.assigned_employee_id = $2'}
        ORDER BY a.due_date NULLS LAST, a.id DESC
        LIMIT $${canSeeAllTests ? 2 : 3}`,
      canSeeAllTests ? [pattern, limit] : [pattern, viewer.id, limit],
    );

    // Certificate: the issued number, or the TRF it belongs to. A draft has no
    // number yet, so it is found through its TRF number instead.
    const coaResult = await pool.query<{
      id: number; trf_id: number; coa_number: string | null; status: CoaStatus; trf_number: string; product_name: string | null;
    }>(
      `SELECT c.id, c.trf_id, c.coa_number, c.status, t.trf_number, p.name AS product_name
         FROM coas c
         JOIN trfs t ON t.id = c.trf_id
         LEFT JOIN products p ON p.id = t.product_id
        WHERE (lower(COALESCE(c.coa_number, '')) LIKE $1 OR lower(t.trf_number) LIKE $1)
        ORDER BY c.id DESC
        LIMIT $2`,
      [pattern, limit],
    );

    const iso = (value: Date | string | null): string | null => {
      if (!value) return null;
      return typeof value === 'string' ? value : value.toISOString();
    };

    res.json({
      trfs: trfResult.rows.map((r) => ({
        id: r.id,
        trfNumber: r.trf_number,
        status: r.status,
        priority: r.priority,
        trfDate: iso(r.trf_date)?.slice(0, 10) ?? null,
        productName: r.product_name,
        batchNumber: r.batch_number,
        customerName: r.customer_name,
      })),
      analysis: analysisResult.rows.map((r) => ({
        id: r.id,
        trfId: r.trf_id,
        trfNumber: r.trf_number,
        testName: r.test_name,
        status: r.status,
        dueDate: iso(r.due_date)?.slice(0, 10) ?? null,
        resultText: r.result_text,
      })),
      coas: coaResult.rows.map((r) => ({
        id: r.id,
        trfId: r.trf_id,
        coaNumber: r.coa_number,
        status: r.status,
        trfNumber: r.trf_number,
        productName: r.product_name,
      })),
    });
  } catch (err) {
    // A malformed query is the caller's problem and gets a readable message;
    // everything else is a server fault and is sanitised by the error handler.
    if (err instanceof z.ZodError) {
      next(badRequest(err.issues[0]?.message ?? 'That search is not valid.'));
      return;
    }
    next(err);
  }
});
