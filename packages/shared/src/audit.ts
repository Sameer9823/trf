/**
 * The audit trail answers one question: who changed what, and when. These types
 * are the vocabulary for that, shared by the server that writes the rows and the
 * screen that reads them.
 *
 * A module is a part of the application. An action is one thing that happened to
 * one record, written as `module.verb` so an action is never ambiguous about
 * where it belongs. Actions are listed here rather than in the database because
 * a filter that offers a value nothing has ever written is a small lie.
 */

export const AUDIT_MODULES = [
  'auth',
  'employees',
  'trf',
  'assignments',
  'analysis',
  'coa',
  'reports',
  'settings',
] as const;
export type AuditModule = (typeof AUDIT_MODULES)[number];

export const AUDIT_ACTIONS = [
  'auth.login',
  'auth.login_failed',
  'auth.login_locked',
  'auth.logout',
  'auth.password_changed',
  'auth.password_reset_admin',
  'auth.session_expired',
  'employee.created',
  'employee.updated',
  'employee.activated',
  'employee.deactivated',
  'employee.password_reset',
  'department.created',
  'department.updated',
  'customer.created',
  'customer.updated',
  'product.created',
  'product.updated',
  'trf.created',
  'trf.field_changed',
  'trf.status_changed',
  'trf.assigned',
  'trf.assignment_note',
  'trf.ard_changed',
  'trf.ard_status_changed',
  'trf.deleted',
  'assignment.created',
  'assignment.reassigned',
  'assignment.cancelled',
  'assignment.due_date_changed',
  'assignment.note',
  'test_catalog.created',
  'test_catalog.updated',
  'analysis.started',
  'analysis.result_recorded',
  'analysis.completed',
  'analysis.re_test_requested',
  'coa.drafted',
  'coa.submitted_for_review',
  'coa.returned',
  'coa.approved',
  'coa.issued',
  'coa.remarks_changed',
  'coa.review_cleared',
  'report.exported',
  'settings.updated',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Actions that mean something went wrong rather than something was done. */
export const FAILURE_ACTIONS = [
  'auth.login_failed',
  'auth.login_locked',
  'auth.session_expired',
] as const;

/** Actions that remove or revoke access, called out because they matter most. */
export const SECURITY_ACTIONS = [
  'auth.login_locked',
  'auth.password_changed',
  'auth.password_reset_admin',
  'employee.activated',
  'employee.deactivated',
  'employee.password_reset',
] as const;

/**
 * How a row reads at a glance. Derived from the action rather than stored, so the
 * colour can never disagree with what was actually written.
 */
export type AuditTone = 'ok' | 'info' | 'warn' | 'danger';

export function auditTone(action: string): AuditTone {
  if ((FAILURE_ACTIONS as readonly string[]).includes(action)) return 'danger';
  if ((SECURITY_ACTIONS as readonly string[]).includes(action)) return 'warn';
  if (action.endsWith('.created') || action.endsWith('.completed') || action.endsWith('.approved')
    || action.endsWith('.issued') || action.endsWith('.activated')) return 'ok';
  return 'info';
}

/** Plain-English description of an action, for the screen and for exports. */
export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  'auth.login': 'Signed in',
  'auth.login_failed': 'Sign-in attempt failed',
  'auth.login_locked': 'Account locked after repeated failures',
  'auth.logout': 'Signed out',
  'auth.password_changed': 'Changed own password',
  'auth.password_reset_admin': 'Password reset by an administrator',
  'auth.session_expired': 'Session ended',
  'employee.created': 'Employee added',
  'employee.updated': 'Employee edited',
  'employee.activated': 'Employee reactivated',
  'employee.deactivated': 'Employee deactivated',
  'employee.password_reset': 'Employee password reset',
  'department.created': 'Department added',
  'department.updated': 'Department edited',
  'customer.created': 'Customer added',
  'customer.updated': 'Customer edited',
  'product.created': 'Product added',
  'product.updated': 'Product edited',
  'trf.created': 'TRF created',
  'trf.field_changed': 'TRF field changed',
  'trf.status_changed': 'TRF status changed',
  'trf.assigned': 'TRF assigned',
  'trf.assignment_note': 'TRF assignment note',
  'assignment.created': 'Test assigned',
  'assignment.reassigned': 'Test reassigned',
  'assignment.cancelled': 'Test cancelled',
  'assignment.due_date_changed': 'Due date changed',
  'assignment.note': 'Assignment note',
  'test_catalog.created': 'Test catalogue entry added',
  'test_catalog.updated': 'Test catalogue entry edited',
  'analysis.started': 'Analysis started',
  'analysis.result_recorded': 'Result recorded',
  'analysis.completed': 'Analysis completed',
  'analysis.re_test_requested': 'Re-test requested',
  'coa.drafted': 'Certificate drafted',
  'coa.submitted_for_review': 'Sent for review',
  'coa.returned': 'Sent back for correction',
  'coa.approved': 'Certificate approved',
  'coa.issued': 'Certificate issued',
  'coa.remarks_changed': 'Certificate remarks changed',
  'coa.review_cleared': 'Review cleared',
  'report.exported': 'Report exported',
  'settings.updated': 'Settings changed',
  'trf.ard_changed': 'ARD field changed',
  'trf.ard_status_changed': 'ARD status changed',
  'trf.deleted': 'TRF deleted',
};

/** What a value looked like before and after, one entry per changed field. */
export interface AuditChange {
  field: string;
  old: unknown;
  new: unknown;
}

export interface AuditEntry {
  id: number;
  /** Null for an action with no signed-in person, such as a failed unknown sign-in. */
  userId: number | null;
  userName: string | null;
  action: string;
  module: string;
  recordType: string | null;
  recordRef: string | null;
  /** Field-by-field differences, parsed for reading. Empty for a create. */
  changes: AuditChange[];
  /** The whole new state, for rows that are not a field-by-field change. */
  summary: Record<string, string> | null;
  createdAt: string;
  tone: AuditTone;
  label: string;
}

export const AUDIT_SORT_FIELDS = ['createdAt', 'userName', 'action', 'module', 'recordRef'] as const;
export type AuditSortField = (typeof AUDIT_SORT_FIELDS)[number];

/**
 * Counts for the filter bar. Always taken over the same filter set as the list,
 * so the numbers beside a filter describe what selecting it would show.
 */
export interface AuditSummary {
  total: number;
  byModule: { module: string; count: number }[];
  byUser: { userId: number | null; userName: string | null; count: number }[];
  /** Failures and lockouts within the current filters, called out on purpose. */
  securityEvents: number;
  /** Busiest days in the current range, newest first, at most seven. */
  byDay: { day: string; count: number }[];
}

export interface AuditPage {
  items: AuditEntry[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  summary: AuditSummary;
  /** The people who appear in the filtered range, for the user filter. */
  users: { id: number; fullName: string }[];
}
