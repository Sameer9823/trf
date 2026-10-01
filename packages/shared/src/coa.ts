import type { CoaStatus, Paginated, TrfStatus } from './core';
import type { Priority } from './trf';
import type { Outcome } from './analysis';

export type { CoaStatus } from './core';

/** Who did each step, and when. Null means the step has not happened yet. */
export interface CoaSignOff {
  id: number | null;
  name: string | null;
  at: string | null;
}

/** One test on the certificate, copied from the result at the moment of drafting. */
export interface CoaLine {
  id: number;
  analysisTestId: number | null;
  testName: string;
  testMethod: string | null;
  specification: string | null;
  resultValue: string | null;
  resultText: string | null;
  unit: string | null;
  lowerLimit: string | null;
  upperLimit: string | null;
  outcome: Outcome;
}

export interface CoaSummaryCounts {
  total: number;
  passed: number;
  failed: number;
}

/** A certificate as the list and the printable view see it. */
export interface Coa {
  id: number;
  trfId: number;
  trfNumber: string;
  coaNumber: string | null;
  status: CoaStatus;
  trfStatus: TrfStatus;
  productName: string | null;
  batchNumber: string | null;
  customerName: string | null;
  customerAddress: string | null;
  trfDate: string;
  requiredCompletionDate: string | null;
  priority: Priority;
  sampleQuantity: string | null;
  requestedAnalysis: string | null;
  remarks: string | null;
  preparedBy: CoaSignOff;
  reviewedBy: CoaSignOff;
  approvedBy: CoaSignOff;
  issuedBy: CoaSignOff;
  lines: CoaLine[];
  counts: CoaSummaryCounts;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type CoaPage = Paginated<Coa>;

export interface CoaFilters {
  page: number;
  pageSize: number;
  search: string;
  status: CoaStatus[];
  trfId?: number;
  trfNumber: string;
  dateFrom?: string;
  dateTo?: string;
  mineOnly: boolean;
  sortBy: CoaSortField;
  sortDir: 'asc' | 'desc';
}

export const COA_SORT_FIELDS = ['coaNumber', 'trfNumber', 'customerName', 'status', 'createdAt', 'issuedAt'] as const;
export type CoaSortField = (typeof COA_SORT_FIELDS)[number];

export const DEFAULT_COA_FILTERS: Partial<CoaFilters> = {
  search: '', trfNumber: '', mineOnly: false, sortBy: 'createdAt', sortDir: 'desc',
};

/** Counts for the COA header, over whatever the list is showing. */
export interface CoaSummary {
  total: number;
  pending: number;
  draft: number;
  underReview: number;
  approved: number;
  issued: number;
}

/** What the list screen needs to decide which buttons to offer. */
export function allowedNextCoaStatuses(status: CoaStatus): CoaStatus[] {
  const all: CoaStatus[] = ['Pending', 'Draft', 'Under Review', 'Approved', 'Issued'];
  const map: Record<CoaStatus, CoaStatus[]> = {
    Pending: ['Draft'],
    Draft: ['Under Review'],
    'Under Review': ['Approved', 'Draft'],
    Approved: ['Issued'],
    Issued: [],
  };
  return all.filter((candidate) => (map[status] ?? []).includes(candidate));
}
