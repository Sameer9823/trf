import { Paginated, TrfStatus, ArdWorkflowStatus, ArdReportingStatus, ArdCoaStatus, TERMINAL_ARD_STATUSES, RemarksStatus, ArdRemarksStatus } from './core';

export const PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface TrfListItem {
  id: number;
  trfNumber: string;
  trfDate: string;
  customerId: number | null;
  customerName: string | null;
  productId: number | null;
  productName: string | null;
  batchNumber: string | null;
  priority: Priority;
  status: TrfStatus;
  requiredCompletionDate: string | null;
  assignedEmployeeId: number | null;
  assignedEmployeeName: string | null;
  departmentId: number | null;
  departmentName: string | null;
  isOverdue: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
  /** Part A — Formulation Team fields. */
  sampleQuantity: string | null;
  sampleReceivedDate: string | null;
  requestedAnalysis: string | null;
  specialInstructions: string | null;
  remarks: string | null;
  createdBy: number | null;
  createdByName: string | null;
  batchSize: string | null;
  dosageForm: string | null;
  manufacturingLocation: string | null;
  labelClaim: string | null;
  packSize: string | null;
  packType: string | null;
  storageCondition: string | null;
  storagePeriod: string | null;
  manufacturingDate: string | null;
  expiryDate: string | null;
  analysisPurpose: string | null;
  sampleGivenBy: string | null;
  signatureDate: string | null;
  /** Part B — ARD Analysis Details. */
  ardNumber: string | null;
  ardAnalystId: number | null;
  stage: ArdWorkflowStatus;
  analystName: string | null;
  analysisStartDate: string | null;
  reportingStatus: ArdReportingStatus;
  coaStatus: ArdCoaStatus;
  tat: number | null;
  workflowStatus: ArdWorkflowStatus;
  remarksStatus: RemarksStatus;
  sampleReceivedBy: number | null;
  sampleReceivedByName: string | null;
  /** ARD remarks status dropdown. */
  ardRemarksStatus: ArdRemarksStatus;
  ardRemarks: string | null;
  finalizedAt: string | null;
  deletedAt: string | null;
}

export interface TrfDetail extends TrfListItem {
}

export interface ArdStatusHistoryEntry {
  id: number;
  oldStatus: ArdWorkflowStatus | null;
  newStatus: ArdWorkflowStatus;
  changedByName: string | null;
  changedAt: string;
  note: string | null;
}

export interface TrfStatusHistoryEntry {
  id: number;
  oldStatus: TrfStatus | null;
  newStatus: TrfStatus;
  changedByName: string | null;
  changedAt: string;
  note: string | null;
}

export interface Customer {
  id: number;
  name: string;
  code: string | null;
  contactPerson: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  isActive: boolean;
}

export interface Product {
  id: number;
  name: string;
  code: string | null;
  description: string | null;
  isActive: boolean;
}

export type TrfListPage = Paginated<TrfListItem>;

export interface TrfFilters { page: number;
  pageSize: number;
  search: string;
  status: TrfStatus[];
  priority: Priority[];
  customerId?: number;
  productId?: number;
  assignedEmployeeId?: number;
  departmentId?: number;
  dateFrom?: string;
  dateTo?: string;
  dueFrom?: string;
  dueTo?: string;
  workflowStatus?: ArdWorkflowStatus[];
  analystId?: number;
  overdueOnly: boolean;
  sortBy: TrfSortField;
  sortDir: 'asc' | 'desc';
}

export const TRF_SORT_FIELDS = [
   'trfNumber', 'trfDate', 'customerName', 'productName', 'batchNumber',
   'priority', 'status', 'requiredCompletionDate', 'workflowStatus', 'tat',
   'createdBy', 'createdAt', 'ardRemarksStatus', 'remarksStatus', 'assignedEmployeeName',
   'batchSize', 'dosageForm', 'manufacturingLocation', 'labelClaim', 'packSize',
   'packType', 'storageCondition', 'storagePeriod', 'manufacturingDate', 'expiryDate',
   'sampleQuantity', 'requestedAnalysis', 'specialInstructions', 'analysisPurpose',
   'remarks', 'sampleGivenBy', 'signatureDate', 'ardNumber', 'analystName',
   'analysisStartDate', 'reportingStatus', 'coaStatus', 'ardRemarks', 'sampleReceivedByName',
 ] as const;
export type TrfSortField = (typeof TRF_SORT_FIELDS)[number];

export const DEFAULT_TRF_FILTERS: TrfFilters = {
  page: 1, pageSize: 25, search: '', status: [], priority: [], overdueOnly: false,
  sortBy: 'trfDate', sortDir: 'desc',
};

/** Statuses that can never change again, whatever the role. */
export const TERMINAL_TRF_STATUSES: readonly TrfStatus[] = ['Completed', 'Cancelled'];
