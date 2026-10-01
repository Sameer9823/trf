import type { AnalysisStatus, CoaStatus, TrfStatus } from './core';

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
  trfNew: number;
  trfAssigned: number;
  trfInProgress: number;
  trfAnalysisCompleted: number;
  trfCoaPending: number;
  trfCompleted: number;
  trfCancelled: number;
  /** Due date passed and not finished. Computed, never stored. */
  trfOverdue: number;
  /** Tests that are assigned but not finished, across every analyst. */
  analysisOpenTests: number;
  analysisDelayedTests: number;
  /** Certificates drafted but not yet issued. */
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
 * One analyst's results for the chart. Named apart from the assignment
 * workload view, which counts open work rather than outcomes.
 */
export interface AnalystResultRow {
  employeeId: number;
  employeeName: string;
  assigned: number;
  inProgress: number;
  /** Completed test that passed its specification. */
  passed: number;
  /** Completed test outside its specification. */
  failed: number;
  /** Due date passed and the test is still open. */
  delayed: number;
}

export interface DashboardPayload {
  /** What the numbers actually mean for this role, so the UI can label them honestly. */
  scope: 'all' | 'own';
  totals: DashboardTotals;
  trfStatus: StatusSlice<TrfStatus>[];
  analysisStatus: StatusSlice<AnalysisStatus>[];
  coaStatus: StatusSlice<CoaStatus>[];
  monthlyTrfs: MonthlyPoint[];
  workload: AnalystResultRow[];
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