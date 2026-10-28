import { roleHasPermission } from './permissions';
import type { Role } from './permissions';

/**
 * Export is reporting, not backup. The workbook is meant to be read by people in
 * Finance and QA, so column names are the words those people use and no internal
 * identifier, version number or timestamp ever appears in it.
 */

export const EXPORT_SHEETS = [
  'TRF Master',
  'ARD Tracking',
  'Analysis',
  'Assignments',
  'Employees',
  'COA',
  'Dashboard Data',
  'Audit Log',
] as const;

export type ExportSheetName = (typeof EXPORT_SHEETS)[number];

/** Sheets that carry data beyond what a Viewer is allowed to read. */
export const RESTRICTED_SHEETS = ['Employees', 'Audit Log'] as const;

/**
 * A hard ceiling on rows per sheet. Beyond this the export is refused with an
 * instruction to narrow the filters, rather than quietly truncating a report
 * someone will act on.
 */
export const EXPORT_ROW_LIMIT = 50_000;

export type ExportScope = 'all' | 'own';

export interface ExportFilterSet {
  search: string;
  status: string;
  employeeId?: number;
  trfNumber: string;
  /** Read by the Audit Log sheet, where the reference is not a TRF number. */
  recordRef: string;
  module: string;
  action: string;
  dateFrom?: string;
  dateTo?: string;
  dueFrom?: string;
  dueTo?: string;
  delayedOnly: boolean;
  overdueOnly: boolean;
}

/**
 * Which sheets the caller's role is allowed to receive. Scope answers "whose rows",
 * so it alone is not enough: a Viewer reads every TRF but may not read the employee
 * directory or the audit log, and an export must not hand over what the rest of the
 * application refuses. The restricted sheets are therefore gated on the same
 * permissions their pages use.
 */
export function sheetsFor(scope: ExportScope, role?: Role): ExportSheetName[] {
  const base: ExportSheetName[] = scope === 'all'
    ? [...EXPORT_SHEETS]
    // A scoped caller (an Analyst) gets their own work only: no employee directory,
    // no audit log, and no other person's rows in any sheet.
     : ['TRF Master', 'ARD Tracking', 'Analysis', 'Assignments', 'COA', 'Dashboard Data'];
  if (!role) return base;
  return base.filter((name) => {
    if (name === 'Employees') return roleHasPermission(role, 'employees.view');
    if (name === 'Audit Log') return roleHasPermission(role, 'audit.view');
    return true;
  });
}

export interface ExportMeta {
  sheetNames: ExportSheetName[];
  rowCounts: Record<string, number>;
  scope: ExportScope;
  filters: string;
  truncated: boolean;
  generatedAt: string;
  generatedBy: string;
}