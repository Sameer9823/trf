import ExcelJS from 'exceljs';
import type { EmployeeProfile, ExportFilterSet, ExportScope, ExportSheetName } from '@trf/shared';
import { pool } from '../db';
import { writeAudit } from './audit';
import { OUTCOME_SQL } from './analysis-query';
import { OVERDUE_SQL } from './trf-query';
import { DELAYED_SQL } from './assignment-query';

/**
 * Every sheet here is a report for a human reader: readable column headings, real
 * date cells, a filter row and frozen headers. No database id, version number or
 * internal timestamp is ever written, because a reader would only wonder what it
 * means and an export must never be mistaken for a backup.
 */

const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3B4D' },
};
const HEADER_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
const BODY_FONT: Partial<ExcelJS.Font> = { size: 10 };
const DATE_FORMAT = 'dd-mm-yyyy';
const MOMENT_FORMAT = 'dd-mm-yyyy hh:mm:ss';

/** Status colours mirror the application's badges so a sheet reads like a screen. */
const STATUS_FILL: Record<string, string> = {
  New: 'FFEFF2F4', Assigned: 'FFE4EEF4', 'In Progress': 'FFD6E8F0',
  'Analysis Completed': 'FFD6E8F0', 'COA Pending': 'FFFCE9D4',
  Completed: 'FFDDEEE3', Issued: 'FFDDEEE3', Approved: 'FFFCE9D4',
  Draft: 'FFE4EEF4', 'Under Review': 'FFD6E8F0', Pending: 'FFEFF2F4',
  'Re-test Required': 'FFFCE9D4', Cancelled: 'FFEFF2F4',
  Pass: 'FFDDEEE3', Fail: 'FFF7DEDC', 'Not Specified': 'FFEFF2F4', 'Not Tested': 'FFEFF2F4',
  Delayed: 'FFFCE9D4', Yes: 'FFF7DEDC', No: 'FFDDEEE3',
};

type Row = Record<string, unknown>;

/**
 * Builds a WHERE clause and its bound values together. Parameters are numbered as
 * they are added, so a clause and its `$n` can never drift apart, and the cap
 * below is interpolated as a literal because it is a validated server constant
 * and not user input.
 */
class Clauses {
  private readonly parts: string[] = [];
  private readonly values: unknown[] = [];

  /**
   * `?` marks where a value goes. Every `?` in one fragment takes the same value,
   * which is why a clause like `(a = ? OR b = ?)` is written with one argument.
   */
  bind(sql: string, value: unknown): this {
    this.values.push(value);
    const n = this.values.length;
    this.parts.push(sql.replaceAll('?', `$${n}`));
    return this;
  }

  /** `col = value`, skipped when the value is absent. */
  eq(column: string, value: string | number | undefined | null): this {
    if (value === undefined || value === null || value === '') return this;
    return this.bind(`${column} = ?`, value);
  }

  /** Case-insensitive "contains" across several columns, as the lists search does. */
  contains(columns: string[], value: string): this {
    if (!value.trim()) return this;
    const pattern = `%${value.trim().toLowerCase()}%`;
    this.values.push(pattern);
    const n = this.values.length;
    this.parts.push(`(${columns.map((c) => `lower(COALESCE(${c}, '')) LIKE $${n}`).join(' OR ')})`);
    return this;
  }

  anyOf(column: string, csv: string): this {
    const values = csv.split(',').map((v) => v.trim()).filter(Boolean);
    if (values.length === 0) return this;
    this.values.push(values);
    this.parts.push(`${column} = ANY($${this.values.length})`);
    return this;
  }

  /** Turns a raw boolean expression into `(<expr>)` so it can join an AND chain. */
  flag(condition: boolean, sql: string): this {
    if (condition) this.parts.push(`(${sql})`);
    return this;
  }

  get where(): string {
    return this.parts.length ? `WHERE ${this.parts.join(' AND ')}` : '';
  }

  get params(): unknown[] {
    return this.values;
  }
}

/**
 * Writes one sheet: header row, then data. Column widths follow the header text,
 * so a sheet is readable without manual resizing.
 */
function addSheet(
  book: ExcelJS.Workbook,
  name: string,
  columns: { header: string; key: string; width?: number }[],
  rows: Row[],
  options: { statusKey?: string; momentKey?: string } = {},
): number {
  const sheet = book.addWorksheet(name, {
    views: [{ state: 'frozen', ySplit: 1 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  sheet.columns = columns.map((c) => ({
    header: c.header, key: c.key, width: c.width ?? Math.max(12, c.header.length + 4),
  }));

  const header = sheet.getRow(1);
  header.font = HEADER_FONT;
  header.fill = HEADER_FILL;
  header.alignment = { vertical: 'middle' };
  header.height = 20;

  for (const row of rows) sheet.addRow(row);

  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };

  const statusColumn = options.statusKey
    ? columns.findIndex((c) => c.key === options.statusKey) + 1
    : 0;
  const momentColumn = options.momentKey
    ? columns.findIndex((c) => c.key === options.momentKey) + 1
    : 0;

  for (let i = 2; i <= sheet.rowCount; i++) {
    const line = sheet.getRow(i);
    line.font = BODY_FONT;
    for (let c = 1; c <= columns.length; c++) {
      const cell = line.getCell(c);
      cell.alignment = { vertical: 'top' };
      if (cell.value instanceof Date) cell.numFmt = DATE_FORMAT;
      else if (typeof cell.value === 'number') cell.numFmt = '#,##0.####';
    }
    if (momentColumn > 0) line.getCell(momentColumn).numFmt = MOMENT_FORMAT;
    if (statusColumn > 0) {
      const status = String(line.getCell(statusColumn).value ?? '');
      const fill = STATUS_FILL[status];
      if (fill) line.getCell(statusColumn).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    }
  }

  return rows.length;
}

/** A DATE column arrives as a Date or an ISO string depending on driver settings. */
function asDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

/** A TIMESTAMPTZ keeps its time of day, unlike a DATE column. */
function asMoment(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Half-open date range on `column`. `to` is inclusive of the whole day, which is
 * what "up to and including" means to someone reading a report.
 */
function dateRange(c: Clauses, column: string, from: string | undefined, to: string | undefined): void {
  if (from) c.bind(`${column} >= ?`, from);
  if (to) c.bind(`${column} < (?::date + INTERVAL '1 day')`, to);
}

export interface SheetResult { name: ExportSheetName; rowCount: number }

/**
 * Builds the whole workbook. Each sheet applies the caller's scope and the
 * caller's filters in SQL, so an export is the list the user was looking at,
 * narrowed by the server rather than by the client.
 */
export async function buildExportWorkbook(
  book: ExcelJS.Workbook,
  sheets: ExportSheetName[],
  ctx: { employee: EmployeeProfile; scope: ExportScope; filters: ExportFilterSet },
  cap: number,
): Promise<SheetResult[]> {
  const { employee, scope, filters } = ctx;
  const self = scope === 'own' ? employee.id : null;
  const results: SheetResult[] = [];

  if (sheets.includes('TRF Master')) {
    const where = new Clauses();
    if (self) where.bind('(t.assigned_employee_id = ? OR t.created_by = ?)', self);
    where.contains(['t.trf_number', 'cu.name', 'p.name', 't.batch_number', 'e.full_name'], filters.search);
    where.anyOf('t.status', filters.status);
    where.eq('t.assigned_employee_id', filters.employeeId);
    where.contains(['t.trf_number'], filters.trfNumber);
    dateRange(where, 't.trf_date', filters.dateFrom, filters.dateTo);
    where.flag(filters.overdueOnly, OVERDUE_SQL);

    const { rows } = await pool.query(
      `SELECT t.trf_number, t.trf_date, cu.name AS customer_name, p.name AS product_name,
              t.batch_number, t.sample_quantity, t.required_completion_date, t.priority,
              t.status, t.requested_analysis, e.full_name AS assigned_name,
              (${OVERDUE_SQL}) AS is_overdue
       FROM trfs t
       LEFT JOIN customers cu ON cu.id = t.customer_id
       LEFT JOIN products p ON p.id = t.product_id
       LEFT JOIN employees e ON e.id = t.assigned_employee_id
       ${where.where}
       ORDER BY t.trf_number ASC
       LIMIT ${cap + 1}`, where.params);

    results.push({ name: 'TRF Master', rowCount: addSheet(book, 'TRF Master', [
      { header: 'TRF No.', key: 'trf_number', width: 18 },
      { header: 'TRF Date', key: 'trf_date' },
      { header: 'Customer', key: 'customer_name', width: 26 },
      { header: 'Product', key: 'product_name', width: 26 },
      { header: 'Batch No.', key: 'batch_number', width: 18 },
      { header: 'Sample Quantity', key: 'sample_quantity' },
      { header: 'Required Completion Date', key: 'required_completion_date' },
      { header: 'Priority', key: 'priority' },
      { header: 'Status', key: 'status', width: 20 },
      { header: 'Assigned Employee', key: 'assigned_name', width: 24 },
      { header: 'Overdue', key: 'is_overdue' },
      { header: 'Requested Analysis', key: 'requested_analysis', width: 34 },
    ], rows.map((r) => ({
      trf_number: r.trf_number,
      trf_date: asDate(r.trf_date),
      customer_name: text(r.customer_name),
      product_name: text(r.product_name),
      batch_number: text(r.batch_number),
      sample_quantity: text(r.sample_quantity),
      required_completion_date: asDate(r.required_completion_date),
      priority: text(r.priority),
      status: text(r.status),
      assigned_name: text(r.assigned_name),
      is_overdue: r.is_overdue ? 'Yes' : 'No',
      requested_analysis: text(r.requested_analysis),
    })), { statusKey: 'status' }) });
  }

  if (sheets.includes('Analysis')) {
    const where = new Clauses();
    if (self) where.bind('a.assigned_employee_id = ?', self);
    where.contains(['t.trf_number', 'a.test_name', 'p.name', 't.batch_number', 'e.full_name'], filters.search);
    where.anyOf('a.status', filters.status);
    where.eq('a.assigned_employee_id', filters.employeeId);
    where.contains(['t.trf_number'], filters.trfNumber);
    dateRange(where, 'a.due_date', filters.dueFrom, filters.dueTo);
    where.flag(filters.delayedOnly, DELAYED_SQL);

    const { rows } = await pool.query(
      `SELECT t.trf_number, p.name AS product_name, t.batch_number, a.test_name,
              a.test_method, a.specification, r.result_value, r.result_text, r.unit,
              r.lower_limit, r.upper_limit, (${OUTCOME_SQL}) AS outcome,
              e.full_name AS analyst_name, a.assigned_date, a.due_date,
              a.start_date, a.completion_date, a.status, (${DELAYED_SQL}) AS is_delayed,
              a.remarks
       FROM analysis_tests a
       JOIN trfs t ON t.id = a.trf_id
       LEFT JOIN products p ON p.id = t.product_id
       LEFT JOIN employees e ON e.id = a.assigned_employee_id
       LEFT JOIN analysis_results r ON r.analysis_test_id = a.id
       ${where.where}
       ORDER BY t.trf_number ASC, a.test_name ASC
       LIMIT ${cap + 1}`, where.params);

    results.push({ name: 'Analysis', rowCount: addSheet(book, 'Analysis', [
      { header: 'TRF No.', key: 'trf_number', width: 18 },
      { header: 'Product', key: 'product_name', width: 26 },
      { header: 'Batch No.', key: 'batch_number', width: 18 },
      { header: 'Test', key: 'test_name', width: 24 },
      { header: 'Method', key: 'test_method', width: 20 },
      { header: 'Specification', key: 'specification', width: 24 },
      { header: 'Result', key: 'result', width: 14 },
      { header: 'Unit', key: 'unit' },
      { header: 'Lower Limit', key: 'lower_limit' },
      { header: 'Upper Limit', key: 'upper_limit' },
      { header: 'Outcome', key: 'outcome', width: 16 },
      { header: 'Analyst', key: 'analyst_name', width: 24 },
      { header: 'Assigned Date', key: 'assigned_date' },
      { header: 'Due Date', key: 'due_date' },
      { header: 'Start Date', key: 'start_date' },
      { header: 'Completion Date', key: 'completion_date' },
      { header: 'Status', key: 'status', width: 18 },
      { header: 'Delayed', key: 'is_delayed' },
      { header: 'Remarks', key: 'remarks', width: 30 },
    ], rows.map((r) => ({
      trf_number: r.trf_number,
      product_name: text(r.product_name),
      batch_number: text(r.batch_number),
      test_name: text(r.test_name),
      test_method: text(r.test_method),
      specification: text(r.specification),
      // A result is either a number or a reading in words, so they share one column.
      result: r.result_value !== null && r.result_value !== undefined
        ? String(r.result_value)
        : (text(r.result_text) ?? 'â€”'),
      unit: text(r.unit),
      lower_limit: text(r.lower_limit),
      upper_limit: text(r.upper_limit),
      outcome: text(r.outcome),
      analyst_name: text(r.analyst_name),
      assigned_date: asDate(r.assigned_date),
      due_date: asDate(r.due_date),
      start_date: asDate(r.start_date),
      completion_date: asDate(r.completion_date),
      status: text(r.status),
      is_delayed: r.is_delayed ? 'Yes' : 'No',
      remarks: text(r.remarks),
    })), { statusKey: 'status' }) });
  }

  if (sheets.includes('Assignments')) {
    const where = new Clauses();
    if (self) where.bind('a.assigned_employee_id = ?', self);
    where.contains(['t.trf_number', 'a.test_name', 'cu.name', 'p.name', 't.batch_number', 'e.full_name'], filters.search);
    where.anyOf('a.status', filters.status);
    where.eq('a.assigned_employee_id', filters.employeeId);
    where.contains(['t.trf_number'], filters.trfNumber);
    dateRange(where, 'a.due_date', filters.dueFrom, filters.dueTo);
    where.flag(filters.delayedOnly, DELAYED_SQL);

    const { rows } = await pool.query(
      `SELECT t.trf_number, cu.name AS customer_name, p.name AS product_name, t.batch_number,
              a.test_name, a.test_method, a.specification, e.full_name AS assigned_name,
              a.assigned_date, a.due_date, a.status, (${DELAYED_SQL}) AS is_delayed
       FROM analysis_tests a
       JOIN trfs t ON t.id = a.trf_id
       LEFT JOIN customers cu ON cu.id = t.customer_id
       LEFT JOIN products p ON p.id = t.product_id
       LEFT JOIN employees e ON e.id = a.assigned_employee_id
       ${where.where}
       ORDER BY t.trf_number ASC, a.test_name ASC
       LIMIT ${cap + 1}`, where.params);

    results.push({ name: 'Assignments', rowCount: addSheet(book, 'Assignments', [
      { header: 'TRF No.', key: 'trf_number', width: 18 },
      { header: 'Customer', key: 'customer_name', width: 26 },
      { header: 'Product', key: 'product_name', width: 26 },
      { header: 'Batch No.', key: 'batch_number', width: 18 },
      { header: 'Test', key: 'test_name', width: 24 },
      { header: 'Method', key: 'test_method', width: 20 },
      { header: 'Specification', key: 'specification', width: 24 },
      { header: 'Assigned Employee', key: 'assigned_name', width: 24 },
      { header: 'Assigned Date', key: 'assigned_date' },
      { header: 'Due Date', key: 'due_date' },
      { header: 'Status', key: 'status', width: 18 },
      { header: 'Delayed', key: 'is_delayed' },
    ], rows.map((r) => ({
      trf_number: r.trf_number,
      customer_name: text(r.customer_name),
      product_name: text(r.product_name),
      batch_number: text(r.batch_number),
      test_name: text(r.test_name),
      test_method: text(r.test_method),
      specification: text(r.specification),
      assigned_name: text(r.assigned_name),
      assigned_date: asDate(r.assigned_date),
      due_date: asDate(r.due_date),
      status: text(r.status),
      is_delayed: r.is_delayed ? 'Yes' : 'No',
    })), { statusKey: 'status' }) });
  }

  // Employees and the audit log are directory-wide, so they never appear for a
  // scoped caller and their queries are simply not run.
  if (sheets.includes('Employees')) {
    const { rows } = await pool.query(
      `SELECT e.employee_code, e.full_name, d.name AS department_name, e.designation,
              e.email, e.phone, e.role, e.is_active, e.must_change_password, e.locked_until
       FROM employees e LEFT JOIN departments d ON d.id = e.department_id
       ORDER BY e.full_name ASC
       LIMIT ${cap + 1}`);
    results.push({ name: 'Employees', rowCount: addSheet(book, 'Employees', [
      { header: 'Employee Code', key: 'employee_code', width: 16 },
      { header: 'Name', key: 'full_name', width: 26 },
      { header: 'Department', key: 'department_name', width: 22 },
      { header: 'Designation', key: 'designation', width: 22 },
      { header: 'Email', key: 'email', width: 28 },
      { header: 'Phone', key: 'phone', width: 16 },
      { header: 'Role', key: 'role', width: 14 },
      { header: 'Active', key: 'is_active' },
      { header: 'Must Change Password', key: 'must_change_password' },
      { header: 'Locked Until', key: 'locked_until' },
    ], rows.map((r) => ({
      employee_code: text(r.employee_code),
      full_name: text(r.full_name),
      department_name: text(r.department_name),
      designation: text(r.designation),
      email: text(r.email),
      phone: text(r.phone),
      role: text(r.role),
      is_active: r.is_active ? 'Yes' : 'No',
      must_change_password: r.must_change_password ? 'Yes' : 'No',
      locked_until: asDate(r.locked_until),
    }))) });
  }

  if (sheets.includes('COA')) {
    const where = new Clauses();
    if (self) where.bind('(c.prepared_by = ? OR c.approved_by = ?)', self);
    where.contains(['c.coa_number', 't.trf_number', 'cu.name', 'p.name', 't.batch_number'], filters.search);
    where.anyOf('c.status', filters.status);
    where.contains(['t.trf_number'], filters.trfNumber);
    dateRange(where, 't.trf_date', filters.dateFrom, filters.dateTo);

    const { rows } = await pool.query(
      `SELECT c.coa_number, t.trf_number, cu.name AS customer_name, p.name AS product_name,
              t.batch_number, t.trf_date, c.status, c.remarks,
              prep.full_name AS prepared_name, rev.full_name AS reviewed_name,
              appr.full_name AS approved_name, iss.full_name AS issued_name,
              c.issued_at,
              (SELECT count(*)::int FROM coa_lines l WHERE l.coa_id = c.id) AS line_count,
              (SELECT count(*)::int FROM coa_lines l WHERE l.coa_id = c.id AND l.outcome = 'Fail') AS failed_count
       FROM coas c
       JOIN trfs t ON t.id = c.trf_id
       LEFT JOIN customers cu ON cu.id = t.customer_id
       LEFT JOIN products p ON p.id = t.product_id
       LEFT JOIN employees prep ON prep.id = c.prepared_by
       LEFT JOIN employees rev ON rev.id = c.reviewed_by
       LEFT JOIN employees appr ON appr.id = c.approved_by
       LEFT JOIN employees iss ON iss.id = c.issued_by
       ${where.where}
       ORDER BY COALESCE(c.coa_number, t.trf_number) ASC
       LIMIT ${cap + 1}`, where.params);

    results.push({ name: 'COA', rowCount: addSheet(book, 'COA', [
      { header: 'COA No.', key: 'coa_number', width: 20 },
      { header: 'TRF No.', key: 'trf_number', width: 18 },
      { header: 'Customer', key: 'customer_name', width: 26 },
      { header: 'Product', key: 'product_name', width: 26 },
      { header: 'Batch No.', key: 'batch_number', width: 18 },
      { header: 'TRF Date', key: 'trf_date' },
      { header: 'Status', key: 'status', width: 16 },
      { header: 'Tests', key: 'line_count' },
      { header: 'Failed Tests', key: 'failed_count' },
      { header: 'Prepared By', key: 'prepared_name', width: 22 },
      { header: 'Reviewed By', key: 'reviewed_name', width: 22 },
      { header: 'Approved By', key: 'approved_name', width: 22 },
      { header: 'Issued By', key: 'issued_name', width: 22 },
      { header: 'Issued Date', key: 'issued_at' },
      { header: 'Remarks', key: 'remarks', width: 30 },
    ], rows.map((r) => ({
      coa_number: text(r.coa_number) ?? '(not issued)',
      trf_number: r.trf_number,
      customer_name: text(r.customer_name),
      product_name: text(r.product_name),
      batch_number: text(r.batch_number),
      trf_date: asDate(r.trf_date),
      status: text(r.status),
      line_count: r.line_count,
      failed_count: r.failed_count,
      prepared_name: text(r.prepared_name),
      reviewed_name: text(r.reviewed_name),
      approved_name: text(r.approved_name),
      issued_name: text(r.issued_name),
      issued_at: asDate(r.issued_at),
      remarks: text(r.remarks),
    })), { statusKey: 'status' }) });
  }

  if (sheets.includes('Dashboard Data')) {
    const trfWhere = new Clauses();
    if (self) trfWhere.bind('(t.assigned_employee_id = ? OR t.created_by = ?)', self);
    const testWhere = new Clauses();
    if (self) testWhere.bind('a.assigned_employee_id = ?', self);
    const coaWhere = new Clauses();
    if (self) coaWhere.bind('(c.prepared_by = ? OR c.approved_by = ?)', self);

    const [trfCounts, testCounts, coaCounts, overdue] = await Promise.all([
      pool.query<{ status: string; count: string }>(
        `SELECT t.status, count(*)::text AS count FROM trfs t ${trfWhere.where} GROUP BY t.status`,
        trfWhere.params),
      pool.query<{ status: string; count: string }>(
        `SELECT a.status, count(*)::text AS count FROM analysis_tests a ${testWhere.where} GROUP BY a.status`,
        testWhere.params),
      pool.query<{ status: string; count: string }>(
        `SELECT c.status, count(*)::text AS count FROM coas c ${coaWhere.where} GROUP BY c.status`,
        coaWhere.params),
      pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM trfs t WHERE ${OVERDUE_SQL}${
          self ? ' AND (t.assigned_employee_id = $1 OR t.created_by = $1)' : ''}`,
        self ? [self] : []),
    ]);

    const rows: Row[] = [
      { area: 'TRF', item: 'New', count: countOf(trfCounts.rows, 'New') },
      { area: 'TRF', item: 'Assigned', count: countOf(trfCounts.rows, 'Assigned') },
      { area: 'TRF', item: 'In Progress', count: countOf(trfCounts.rows, 'In Progress') },
      { area: 'TRF', item: 'Analysis Completed', count: countOf(trfCounts.rows, 'Analysis Completed') },
      { area: 'TRF', item: 'COA Pending', count: countOf(trfCounts.rows, 'COA Pending') },
      { area: 'TRF', item: 'Completed', count: countOf(trfCounts.rows, 'Completed') },
      { area: 'TRF', item: 'Cancelled', count: countOf(trfCounts.rows, 'Cancelled') },
      { area: 'TRF', item: 'Overdue', count: Number(overdue.rows[0].count) },
      { area: 'Analysis', item: 'Assigned', count: countOf(testCounts.rows, 'Assigned') },
      { area: 'Analysis', item: 'In Progress', count: countOf(testCounts.rows, 'In Progress') },
      { area: 'Analysis', item: 'Completed', count: countOf(testCounts.rows, 'Completed') },
      { area: 'Analysis', item: 'Re-test Required', count: countOf(testCounts.rows, 'Re-test Required') },
      { area: 'Analysis', item: 'Cancelled', count: countOf(testCounts.rows, 'Cancelled') },
      { area: 'COA', item: 'Draft', count: countOf(coaCounts.rows, 'Draft') },
      { area: 'COA', item: 'Under Review', count: countOf(coaCounts.rows, 'Under Review') },
      { area: 'COA', item: 'Approved', count: countOf(coaCounts.rows, 'Approved') },
      { area: 'COA', item: 'Issued', count: countOf(coaCounts.rows, 'Issued') },
    ];

    results.push({ name: 'Dashboard Data', rowCount: addSheet(book, 'Dashboard Data', [
      { header: 'Area', key: 'area', width: 16 },
      { header: 'Item', key: 'item', width: 24 },
      { header: 'Count', key: 'count', width: 12 },
    ], rows) });
  }

  if (sheets.includes('Audit Log')) {
    // The Audit Log screen's filters apply here too, so the file is the trail the
    // person was reading rather than the whole history.
    const where = new Clauses();
    if (filters.search) {
      where.contains(['a.user_name', 'a.action', 'a.record_ref', 'a.record_type'], filters.search);
    }
    where.contains(['a.record_ref'], filters.trfNumber || filters.recordRef || '');
    dateRange(where, 'a.created_at', filters.dateFrom, filters.dateTo);
    // Module and action travel as a comma-separated list, the same way the status
    // filter does, so a single value needs no special handling.
    where.anyOf('a.module', filters.module);
    where.anyOf('a.action', filters.action);

    const { rows } = await pool.query(
      `SELECT a.user_name, a.action, a.module, a.record_type, a.record_ref,
              a.old_value, a.new_value, a.created_at
       FROM audit_logs a
       ${where.where}
       ORDER BY a.created_at DESC
       LIMIT ${cap + 1}`, where.params);
    results.push({ name: 'Audit Log', rowCount: addSheet(book, 'Audit Log', [
      { header: 'When', key: 'created_at', width: 20 },
      { header: 'User', key: 'user_name', width: 24 },
      { header: 'Action', key: 'action', width: 30 },
      { header: 'Module', key: 'module', width: 14 },
      { header: 'Record Type', key: 'record_type', width: 16 },
      { header: 'Record', key: 'record_ref', width: 20 },
      { header: 'Previous', key: 'old_value', width: 34 },
      { header: 'New', key: 'new_value', width: 34 },
    ], rows.map((r) => ({
      // The moment of the change, to the second: "on the 4th" is not enough to
      // order two edits made on the same day.
      created_at: asMoment(r.created_at),
      user_name: text(r.user_name) ?? 'System',
      action: text(r.action),
      module: text(r.module),
      record_type: text(r.record_type),
      record_ref: text(r.record_ref),
      old_value: renderJson(r.old_value),
      new_value: renderJson(r.new_value),
    })), { momentKey: 'created_at' }) });
  }

  return results;
}

function countOf(rows: { status: string; count: string }[], status: string): number {
  return Number(rows.find((r) => r.status === status)?.count ?? 0);
}

/** Audit values are JSONB; a reader wants the pairs, not the braces. */
function renderJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return String(value);
  return Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(', ') || null;
}

/**
 * Records who exported what, because an export is a disclosure of data. This one
 * audit row is not part of the caller's business transaction, so it is written
 * in its own; it must survive even if nothing else did.
 */
export async function auditExport(
  employee: EmployeeProfile,
  sheets: ExportSheetName[],
  filters: string,
  rowCounts: Record<string, number>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await writeAudit(client, {
      userId: employee.id, userName: employee.fullName,
      action: 'report.exported', module: 'reports',
      recordType: 'Export', recordRef: `TRF-EXPORT-${new Date().toISOString().slice(0, 10)}`,
      newValue: { sheets, filters, rowCounts },
    });
  } finally {
    client.release();
  }
}