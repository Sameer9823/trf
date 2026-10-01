import type { Paginated } from './core';
import type { TrfStatus } from './core';

export type { AnalysisStatus } from './core';

/** An assignment row as the list screens see it. TRF fields are read from the TRF, never copied. */
export interface Assignment {
  id: number;
  trfId: number;
  trfNumber: string;
  productName: string | null;
  batchNumber: string | null;
  customerName: string | null;
  trfStatus: TrfStatus;
  priority: import('./trf').Priority;
  testName: string;
  testMethod: string | null;
  specification: string | null;
  assignedEmployeeId: number | null;
  assignedEmployeeName: string | null;
  assignedDate: string | null;
  dueDate: string | null;
  status: import('./core').AnalysisStatus;
  /** Computed: due date passed and the test is not Completed or Cancelled. Never stored. */
  isDelayed: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AssignmentInput {
  testName: string;
  testMethod?: string | null;
  specification?: string | null;
  assignedEmployeeId: number;
  dueDate?: string | null;
}

export interface AssignmentFilters {
  page: number;
  pageSize: number;
  search: string;
  status: AnalysisStatusView[];
  employeeId?: number;
  trfId?: number;
  trfNumber: string;
  dueFrom?: string;
  dueTo?: string;
  delayedOnly: boolean;
  sortBy: AssignmentSortField;
  sortDir: 'asc' | 'desc';
}

/** "Delayed" is a display state derived from status and due date, not a stored status. */
export type AnalysisStatusView = import('./core').AnalysisStatus | 'Delayed';

export const ASSIGNMENT_STATUS_VIEWS: readonly AnalysisStatusView[] = [
  'Pending', 'Assigned', 'In Progress', 'Completed', 'Re-test Required', 'Cancelled', 'Delayed',
];

export const ASSIGNMENT_SORT_FIELDS = [
  'trfNumber', 'testName', 'assignedEmployeeName', 'dueDate', 'status', 'assignedDate', 'priority',
] as const;
export type AssignmentSortField = (typeof ASSIGNMENT_SORT_FIELDS)[number];

export const DEFAULT_ASSIGNMENT_FILTERS: Partial<AssignmentFilters> = {
  search: '', trfNumber: '', delayedOnly: false, sortBy: 'dueDate', sortDir: 'asc',
};

export type AssignmentListPage = Paginated<Assignment>;

export interface TestCatalogItem {
  id: number;
  name: string;
  defaultMethod: string | null;
  specification: string | null;
  unit: string | null;
  isActive: boolean;
}

/** Open tests per employee, for the workload view. */
export interface WorkloadRow {
  employeeId: number;
  employeeName: string;
  departmentName: string | null;
  pending: number;
  inProgress: number;
  delayed: number;
  completed: number;
  openTotal: number;
}

/** The grouped shape the Manager's by-TRF view renders. */
export interface AssignmentGroup {
  trfId: number;
  trfNumber: string;
  trfStatus: TrfStatus;
  productName: string | null;
  batchNumber: string | null;
  customerName: string | null;
  priority: import('./trf').Priority;
  requiredCompletionDate: string | null;
  trfVersion: number;
  tests: Assignment[];
}

/** Same envelope as the list, but each item is a TRF with its tests. */
export type AssignmentGroupPage = Paginated<AssignmentGroup>;