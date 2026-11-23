import { Paginated, TrfStatus, ArdWorkflowStatus, ArdStage, ArdReportingStatus, ArdCoaStatus, TERMINAL_ARD_STATUSES, RemarksStatus, ArdRemarksStatus, DEFAULT_ARD_STAGE } from './core.js';
import { APPROVAL_TRACKS, APPROVAL_STATUSES, ApprovalTrack, ApprovalStatus, TrfApproval } from './permissions.js';

export const FINAL_APPROVAL_STATUSES = ['None', 'Pending', 'Approved', 'Rejected'] as const;
export type FinalApprovalStatus = (typeof FINAL_APPROVAL_STATUSES)[number];

export const PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

// New types for ARD Assignment Workflow
export const ARD_TEST_ASSIGNMENT_STATUSES = ['Pending Assignment', 'Assigned', 'In Progress', 'Completed', 'Re-test Required', 'Cancelled'] as const;
export type ArdTestAssignmentStatus = (typeof ARD_TEST_ASSIGNMENT_STATUSES)[number];

/** An AGM reviews each submitted test result: Submitted (waiting for the AGM) -> Approved or Rejected. */
export const ARD_RESULT_REVIEW_STATUSES = ['Submitted', 'Approved', 'Rejected'] as const;
export type ArdResultReviewStatus = (typeof ARD_RESULT_REVIEW_STATUSES)[number];

export const ARD_RESULT_OUTCOMES = ['Pass', 'Fail', 'NA'] as const;
export type ArdResultOutcome = (typeof ARD_RESULT_OUTCOMES)[number];

/** What the assigned employee sends when they submit the result of a test. */
export interface SubmitAssignmentResultRequest {
  /** The assignment's version, so a result is never submitted over a newer change. */
  version: number;
  resultValue?: string | null;
  resultText?: string | null;
  unit?: string | null;
  methodUsed?: string | null;
  specification?: string | null;
  lowerLimit?: string | null;
  upperLimit?: string | null;
  outcome: ArdResultOutcome;
  remarks?: string | null;
  analysisStartDate?: string | null;
  completionDate?: string | null;
}

/** The AGM's decision on a submitted result. A rejection needs a reason. */
export interface ReviewAssignmentResultRequest {
  version: number;
  decision: 'Approved' | 'Rejected';
  reason?: string | null;
}

export interface ArdTestAssignment {
  id: number;
  trfId: number;
  testRequestedOptionId: number;
  testName: string;
  status: ArdTestAssignmentStatus;
  assignedBy: number | null;
  assignedAt: string | null;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  analysts?: { id: number; fullName: string; employeeCode: string; departmentName: string | null; assignedAt: string }[];
  // Computed from analysts for client convenience
  analystIds?: number[];
  /** Result fields (from ard_assignment_results) */
  resultValue?: string | null;
  resultText?: string | null;
  unit?: string | null;
  methodUsed?: string | null;
  specification?: string | null;
  lowerLimit?: string | null;
  upperLimit?: string | null;
  outcome?: 'Pass' | 'Fail' | 'NA' | null;
  remarks?: string | null;
  enteredBy?: number | null;
  enteredByName?: string | null;
  enteredAt?: string | null;
  /** Review of the submitted result by an AGM */
  reviewStatus?: ArdResultReviewStatus | null;
  submittedAt?: string | null;
  reviewedBy?: number | null;
  reviewedByName?: string | null;
  reviewedAt?: string | null;
  reviewReason?: string | null;
  /** Result input mode: text fields or an uploaded PDF file. */
  resultMode?: 'text' | 'pdf' | null;
  /** PDF file info (when resultMode is 'pdf'). fileName is for display; the path stays server-side. */
  fileName?: string | null;
  fileSize?: number | null;
  /** Completion fields */
  analysisStartDate?: string | null;
  completionDate?: string | null;
  completedBy?: number | null;
  completedByName?: string | null;
}

export interface ArdTestAssignmentAnalyst {
  id: number;
  assignmentId: number;
  analystId: number;
  assignedAt: string;
  assignedBy: number | null;
}

export interface ArdTestAssignmentHistory {
  id: number;
  assignmentId: number;
  action: 'ASSIGNED' | 'REASSIGNED' | 'UNASSIGNED' | 'STATUS_CHANGED' | 'RESULT_ENTERED' | 'RESULT_CHANGED' | 'RESULT_FILE_UPLOADED';
  oldAnalystIds: number[];
  newAnalystIds: number[];
  oldStatus: string | null;
  newStatus: string | null;
  changedBy: number;
  changedAt: string;
  reason: string | null;
}

export interface TrfLock {
  id: number;
  trfId: number;
  lockedBy: number;
  lockedAt: string;
  lockReason: string | null;
  finalStatus: string;
  allTestsCompleted: boolean;
  createdAt: string;
}

export interface TrfLockHistory {
  id: number;
  trfId: number;
  action: 'LOCKED' | 'UNLOCKED';
  lockedBy: number | null;
  unlockedBy: number | null;
  lockedAt: string | null;
  unlockedAt: string | null;
  lockReason: string | null;
  unlockReason: string | null;
  changedBy: number;
  changedAt: string;
}

// New lookup types
export interface TrfTestRequested {
  id: number;
  trfId: number;
  testRequestedOptionId: number;
  createdAt: string;
  createdBy: number | null;
}

// Analyst dashboard view
export interface AnalystAssignedTest {
  assignmentId: number;
  trfId: number;
  trfNumber: string;
  arNumber: string | null;
  productName: string | null;
  genericName: string | null;
  batchNumber: string | null;
  testName: string;
  testStatus: ArdTestAssignmentStatus;
  assignedAt: string | null;
  assignedBy: number | null;
  dueDate: string | null;
  analystId: number;
  analystName: string;
  analystCode: string;
  analystDepartment: string | null;
  /** Result fields */
  resultValue?: string | null;
  resultText?: string | null;
  unit?: string | null;
  methodUsed?: string | null;
  specification?: string | null;
  lowerLimit?: string | null;
  upperLimit?: string | null;
  outcome?: 'Pass' | 'Fail' | 'NA' | null;
  remarks?: string | null;
  enteredBy?: number | null;
  enteredByName?: string | null;
  enteredAt?: string | null;
  /** Review of the submitted result by an AGM */
  reviewStatus?: ArdResultReviewStatus | null;
  submittedAt?: string | null;
  reviewedByName?: string | null;
  reviewedAt?: string | null;
  reviewReason?: string | null;
  /** The assignment's version, needed to submit a result */
  assignmentVersion?: number;
  /** Result input mode: text fields or an uploaded PDF file. */
  resultMode?: 'text' | 'pdf' | null;
  /** PDF file info (when resultMode is 'pdf'). */
  fileName?: string | null;
  fileSize?: number | null;
  /** Completion fields */
  analysisStartDate?: string | null;
  completionDate?: string | null;
  completedBy?: number | null;
  completedByName?: string | null;
}

/** One submitted result waiting in the AGM's review queue. */
export interface ResultReviewQueueItem {
  assignmentId: number;
  assignmentVersion: number;
  trfId: number;
  trfNumber: string;
  arNumber: string | null;
  productName: string | null;
  batchNumber: string | null;
  testName: string;
  resultValue: string | null;
  resultText: string | null;
  unit: string | null;
  outcome: ArdResultOutcome | null;
  submittedAt: string | null;
  submittedByName: string | null;
  /** Result input mode: 'text' or 'pdf'. */
  resultMode?: 'text' | 'pdf' | null;
  /** PDF file name for display (when resultMode is 'pdf'). */
  fileName?: string | null;
}

// ARD overview view
export interface ArdTestAssignmentOverview {
  assignmentId: number;
  trfId: number;
  trfNumber: string;
  productName: string | null;
  genericName: string | null;
  batchNumber: string | null;
  trfStatus: TrfStatus;
  ardWorkflowStatus: ArdWorkflowStatus;
  testName: string;
  testStatus: ArdTestAssignmentStatus;
  assignedAt: string | null;
  assignedBy: number | null;
  assignedByName: string | null;
  dueDate: string | null;
  analysts: {
    analystId: number;
    analystName: string;
    analystCode: string;
    analystDepartment: string | null;
    assignedAt: string;
  }[];
}

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
   sampleSubmittedById: number | null;
   sampleSubmittedByName: string | null;
   signatureDate: string | null;
  /** ARD: who received the sample. The last item of the ARD block. */
  sampleReceivedById: number | null;
  sampleReceivedByName: string | null;
  /** Approvals are made by an administrator only. */
  formulationDecidedAt: string | null;
  formulationDecidedByName: string | null;
  formulationApprovalStatus: FinalApprovalStatus;
  finalApprovalStatus: FinalApprovalStatus;
  finalDecidedAt: string | null;
  finalDecidedByName: string | null;
  /** When set, the TRF is locked: nobody can change it until an administrator reopens it. */
  lockedAt: string | null;
  lockedBy: number | null;
  lockedByName: string | null;
  /** Part B — ARD Analysis Details. */
   ardNumber: string | null;
   ardAnalystId: number | null;
   stage: ArdStage;
   analystName: string | null;
   /** Comma-separated names of the analysts assigned to this TRF's tests
    * (from the test assignments). When a TRF has more than one test, every
    * assigned analyst is listed, comma-separated. Falls back to the single
    * ARD analyst when no test assignments exist. */
   assignedAnalystNames?: string | null;
  analysisStartDate: string | null;
  reportingStatus: ArdReportingStatus;
  coaStatus: ArdCoaStatus;
  tat: number | null;
  workflowStatus: ArdWorkflowStatus;
  remarksStatus: RemarksStatus;
  /** ARD remark Status dropdown. */
  ardRemarksStatus: ArdRemarksStatus;
  ardRemarks: string | null;
  finalizedAt: string | null;
  deletedAt: string | null;
  /** New fields for Generic Name and Test Requested multi-select */
  genericName: string | null;
  testRequestedOptionIds: number[];
  testRequestedOptionNames: string[];
  testRequestedOther: string | null;
  /** Dosage Form multi-select: option IDs, names, and custom "Other" description */
  dosageFormOptionIds: number[];
  dosageFormOptionNames: string[];
  dosageFormOther: string | null;
  /** Approval tracking */
  ardApprovalStatus: FinalApprovalStatus;
  ardDecidedAt: string | null;
  ardDecidedByName: string | null;
  /** Test assignments for ARD multi-test workflow */
  testAssignments: ArdTestAssignment[];
  /** ARD Submit-to-AGM workflow */
  ardSubmittedAt: string | null;
  ardSubmittedBy: number | null;
  ardSubmittedByName: string | null;
  ardSubmitNote: string | null;
  completedByAgm: number | null;
  completedByAgmName: string | null;
  completedAt: string | null;
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

export interface TrfDocument {
  id: number;
  trfId: number;
  filePath: string;
  fileName: string;
  fileSize: number | null;
  mimeType: string;
  version: number;
  generatedBy: number | null;
  generatedAt: string;
  status: 'generated' | 'failed' | 'regenerated';
  errorMessage: string | null;
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
  genericName: string | null;
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
  approvalPending?: boolean;
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
   'remarks', 'sampleGivenBy', 'sampleSubmittedByName', 'signatureDate', 'ardNumber', 'analystName',
   'analysisStartDate', 'reportingStatus', 'coaStatus', 'ardRemarks',
   'sampleReceivedDate', 'sampleReceivedByName', 'stage',
  ] as const;
export type TrfSortField = (typeof TRF_SORT_FIELDS)[number];

export const DEFAULT_TRF_FILTERS: TrfFilters = {
  page: 1, pageSize: 25, search: '', status: [], priority: [], overdueOnly: false,
  sortBy: 'trfDate', sortDir: 'desc',
};

/** Statuses that can never change again, whatever the role. */
export const TERMINAL_TRF_STATUSES: readonly TrfStatus[] = ['Completed', 'Cancelled'];

export interface SystemSetting {
  key: string;
  value: string;
  description: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export type SystemSettingsList = SystemSetting[];
