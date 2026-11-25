import type { ArdWorkflowStatus, CoaStatus } from './core.js';
import type { ArdTestAssignmentStatus } from './trf.js';

/**
 * Dashboard figures are counted in SQL on the server. Nothing here is derived by
 * the client, so a card can never disagree with the list it links to.
 */

export interface StatusSlice<T extends string> {
  status: T;
  count: number;
}

/** The headline numbers across the top of the dashboard. */
export interface DashboardTotals {
  trfTotal: number;
  /** TRFs whose ARD Final Status (workflow_status) is Completed. */
  trfCompleted: number;
  /** Due date passed and the ARD Final Status is not terminal. Computed, never stored. */
  trfOverdue: number;
  /** ARD test assignments that are not finished, across every analyst. */
  analysisOpenTests: number;
  /** ARD test assignments past their due date and still open. */
  analysisDelayedTests: number;
  /** Certificates drafted but not yet issued (always 0 while SHOW_COA is false). */
  coaAwaitingIssue: number;
  coaIssued: number;
}

export interface MonthlyPoint {
  /** `YYYY-MM`, always twelve entries, oldest first, months with no TRFs included. */
  month: string;
  label: string;
  count: number;
}

/**
 * One analyst's ARD results for the chart. The chart draws the five open-work
 * series (assigned, inProgress, delayed, passed, failed); submitted/approved/
 * rejected are carried for the payload and tests. Passed and failed count only
 * results the AGM approved.
 */
export interface AnalystResultRow {
  employeeId: number;
  employeeName: string;
  assigned: number;
  inProgress: number;
  submitted: number;
  approved: number;
  rejected: number;
  /** Approved result whose Outcome is Pass. */
  passed: number;
  /** Approved result whose Outcome is Fail. */
  failed: number;
  /** Due date passed and the test is still open. */
  delayed: number;
}

/**
 * One employee's TRF completion, for the "completed by employee" breakdown.
 * `total` is the distinct non-cancelled TRFs the analyst is assigned to (through
 * ard_test_assignment_analysts); `completed` is those whose ARD Final Status is
 * Completed.
 */
export interface TrfEmployeeRow {
  employeeId: number;
  employeeName: string;
  completed: number;
  total: number;
}

export interface DashboardPayload {
  /** What the numbers actually mean for this role, so the UI can label them honestly. */
  scope: 'all' | 'own';
  totals: DashboardTotals;
  /** ARD Final Status mix (workflow_status), the same stages the pipeline shows. */
  trfStatus: StatusSlice<ArdWorkflowStatus>[];
  /** ARD test-assignment status mix. */
  analysisStatus: StatusSlice<ArdTestAssignmentStatus>[];
  /** Certificate mix; empty while SHOW_COA is false. */
  coaStatus: StatusSlice<CoaStatus>[];
  /** When false the client hides the Certificates card, panel and COA stage. */
  showCoa: boolean;
  monthlyTrfs: MonthlyPoint[];
  workload: AnalystResultRow[];
  trfByEmployee: TrfEmployeeRow[];
  generatedAt: string;
}

export type DashboardResult =
  | { ok: true; data: DashboardPayload }
  | { ok: false; message: string };

/** Cards that read as an actionable list rather than a number with no way in. */
export interface DashboardCard {
  label: string;
  total: number;
  tone: 'neutral' | 'info' | 'warn' | 'danger' | 'ok';
  /** Where the card links to. Overridden or hidden when the role may not see it. */
  to?: string;
  hint?: string;
}