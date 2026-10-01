import type { Paginated, AnalysisStatus, TrfStatus } from './core';
import type { Priority } from './trf';

/**
 * How a measured value compares with its specification. Computed in SQL, never
 * stored, so it can never disagree with the value and limits that produced it.
 */
export const OUTCOMES = ['Pass', 'Fail', 'Not Specified', 'Not Tested'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface AnalysisResult {
  id: number;
  analysisTestId: number;
  /** Numeric result, sent as a string so a 14-digit value loses nothing. */
  resultValue: string | null;
  resultText: string | null;
  unit: string | null;
  methodUsed: string | null;
  lowerLimit: string | null;
  upperLimit: string | null;
  remarks: string | null;
  enteredById: number | null;
  enteredByName: string | null;
  enteredAt: string | null;
  version: number;
  updatedAt: string;
}

/** One assigned test as the Analysis screen sees it: assignment plus result plus dates. */
export interface AnalysisItem {
  id: number;
  trfId: number;
  trfNumber: string;
  productName: string | null;
  batchNumber: string | null;
  customerName: string | null;
  trfStatus: TrfStatus;
  trfVersion: number;
  priority: Priority;
  requiredCompletionDate: string | null;
  testName: string;
  testMethod: string | null;
  specification: string | null;
  assignedEmployeeId: number | null;
  assignedEmployeeName: string | null;
  assignedDate: string | null;
  dueDate: string | null;
  status: AnalysisStatus;
  isDelayed: boolean;
  startDate: string | null;
  completionDate: string | null;
  remarks: string | null;
  outcome: Outcome;
  result: AnalysisResult | null;
  version: number;
  updatedAt: string;
}

/** What an analyst saves for one test. */
export interface AnalysisResultInput {
  resultValue?: string | null;
  resultText?: string | null;
  unit?: string | null;
  methodUsed?: string | null;
  lowerLimit?: string | null;
  upperLimit?: string | null;
  remarks?: string | null;
}

export interface AnalysisFilters {
  page: number;
  pageSize: number;
  search: string;
  status: (AnalysisStatus | 'Delayed')[];
  outcome: Outcome[];
  employeeId?: number;
  trfId?: number;
  trfNumber: string;
  dueFrom?: string;
  dueTo?: string;
  delayedOnly: boolean;
  mineOnly: boolean;
  sortBy: AnalysisSortField;
  sortDir: 'asc' | 'desc';
}

export const ANALYSIS_SORT_FIELDS = [
  'trfNumber', 'testName', 'assignedEmployeeName', 'dueDate', 'status',
  'outcome', 'startDate', 'completionDate',
] as const;
export type AnalysisSortField = (typeof ANALYSIS_SORT_FIELDS)[number];

export const DEFAULT_ANALYSIS_FILTERS: Partial<AnalysisFilters> = {
  search: '', trfNumber: '', delayedOnly: false, mineOnly: true,
  sortBy: 'dueDate', sortDir: 'asc',
};

export type AnalysisPage = Paginated<AnalysisItem>;

/** Counts for the Analysis header: how much is open, late and finished. */
export interface AnalysisSummary {
  total: number;
  inProgress: number;
  completed: number;
  reTestRequired: number;
  delayed: number;
  passed: number;
  failed: number;
}
