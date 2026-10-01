import { Router } from 'express';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import type { ExportMeta, ExportScope, ExportSheetName } from '@trf/shared';
import { EXPORT_ROW_LIMIT, EXPORT_SHEETS, roleHasPermission, sheetsFor } from '@trf/shared';
import { badRequest } from '../lib/errors';
import { auditExport, buildExportWorkbook } from '../lib/excel-export';
import { authenticate, currentEmployee, requirePermission } from '../middleware/auth';

export const reportsRouter = Router();
reportsRouter.use(authenticate);

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format yyyy-mm-dd.');

/**
 * The filters here are the same names the list endpoints use, so "export" on a
 * filtered list produces exactly the rows the user was looking at.
 */
const exportQuerySchema = z.object({
  sheet: z.enum(EXPORT_SHEETS).optional(),
  search: z.string().trim().max(120).default(''),
  status: z.string().max(200).default(''),
  employeeId: z.coerce.number().int().positive().optional(),
  trfNumber: z.string().trim().max(40).default(''),
  recordRef: z.string().trim().max(60).default(''),
  module: z.string().max(40).default(''),
  action: z.string().max(60).default(''),
  dateFrom: ISO_DATE.optional(),
  dateTo: ISO_DATE.optional(),
  dueFrom: ISO_DATE.optional(),
  dueTo: ISO_DATE.optional(),
  delayedOnly: z.enum(['true', 'false']).default('false'),
  overdueOnly: z.enum(['true', 'false']).default('false'),
});

/** Human-readable summary of the filters, stored in the audit row. */
function describeFilters(f: z.infer<typeof exportQuerySchema>): string {
  const parts: string[] = [];
  if (f.sheet) parts.push(`sheet=${f.sheet}`);
  if (f.search) parts.push(`search="${f.search}"`);
  if (f.status) parts.push(`status=${f.status}`);
  if (f.trfNumber) parts.push(`trfNumber=${f.trfNumber}`);
  if (f.recordRef) parts.push(`recordRef=${f.recordRef}`);
  if (f.module) parts.push(`module=${f.module}`);
  if (f.action) parts.push(`action=${f.action}`);
  if (f.employeeId) parts.push(`employeeId=${f.employeeId}`);
  if (f.dateFrom) parts.push(`from=${f.dateFrom}`);
  if (f.dateTo) parts.push(`to=${f.dateTo}`);
  if (f.dueFrom) parts.push(`dueFrom=${f.dueFrom}`);
  if (f.dueTo) parts.push(`dueTo=${f.dueTo}`);
  if (f.delayedOnly === 'true') parts.push('delayedOnly');
  if (f.overdueOnly === 'true') parts.push('overdueOnly');
  return parts.length ? parts.join(', ') : 'no filters';
}

reportsRouter.get('/export.xlsx', requirePermission('reports.export'), async (req, res, next) => {
  const employee = currentEmployee(req);
  try {
    const q = exportQuerySchema.parse(req.query);
    const scope: ExportScope = roleHasPermission(employee.role, 'trf.viewAll') ? 'all' : 'own';
    const allowed = sheetsFor(scope, employee.role);

    // A single-sheet export still has to be a sheet this role may have.
    const requested: ExportSheetName[] = q.sheet ? [q.sheet] : allowed;
    const sheets = requested.filter((name) => allowed.includes(name));
    if (sheets.length === 0) {
      return next(badRequest('Your role cannot export that sheet.'));
    }

    const book = new ExcelJS.Workbook();
    book.creator = 'TRF Management System';
    book.created = new Date();

    const results = await buildExportWorkbook(
      book, sheets,
      { employee, scope, filters: {
        search: q.search, status: q.status, trfNumber: q.trfNumber, employeeId: q.employeeId,
        recordRef: q.recordRef, module: q.module, action: q.action,
        dateFrom: q.dateFrom, dateTo: q.dateTo, dueFrom: q.dueFrom, dueTo: q.dueTo,
        delayedOnly: q.delayedOnly === 'true', overdueOnly: q.overdueOnly === 'true',
      } },
      EXPORT_ROW_LIMIT,
    );

    // Each query asks for one row more than the cap. Overflowing is refused rather
    // than truncated: a report someone acts on must not quietly lose its tail.
    const overflow = results.find((r) => r.rowCount > EXPORT_ROW_LIMIT);
    if (overflow) {
      return next(badRequest(
        `The ${overflow.name} sheet has more than ${EXPORT_ROW_LIMIT.toLocaleString('en-GB')} rows. Narrow the filters and export again.`));
    }

    const described = describeFilters(q);
    const rowCounts = Object.fromEntries(results.map((r) => [r.name, r.rowCount]));

    const meta: ExportMeta = {
      sheetNames: results.map((r) => r.name),
      rowCounts,
      scope,
      filters: described,
      truncated: false,
      generatedAt: new Date().toISOString(),
      generatedBy: employee.fullName,
    };

    const buffer = await book.xlsx.writeBuffer();
    await auditExport(employee, results.map((r) => r.name), described, rowCounts);

    const stamp = new Date().toISOString().slice(0, 10);
    const suffix = q.sheet ? `-${q.sheet.replace(/\s+/g, '-').toLowerCase()}` : '';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="TRF-Report-${stamp}${suffix}.xlsx"`);
    // The sidecar header lets the client report what was included without
    // having to open the workbook.
    res.setHeader('X-Export-Meta', JSON.stringify(meta));
    res.setHeader('Content-Length', String((buffer as ArrayBuffer).byteLength));
    res.status(200).end(Buffer.from(buffer));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(badRequest('Some filters are not valid.', { filters: err.issues[0].message }));
    }
    next(err);
  }
});

/** What this role may export, so the client does not offer a sheet it cannot have. */
reportsRouter.get('/export-options', requirePermission('reports.view'), async (req, res, next) => {
  const employee = currentEmployee(req);
  try {
    const scope: ExportScope = roleHasPermission(employee.role, 'trf.viewAll') ? 'all' : 'own';
    res.json({ sheets: sheetsFor(scope, employee.role), scope, rowLimit: EXPORT_ROW_LIMIT });
  } catch (err) {
    next(err);
  }
});