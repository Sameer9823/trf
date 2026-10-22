/** Statuses, transition rules and shared API shapes. Everything else builds on this. */
import { Role } from './permissions';

export const TRF_STATUSES = [
  'New', 'Assigned', 'In Progress', 'Analysis Completed', 'COA Pending', 'Completed', 'Cancelled',
] as const;
export type TrfStatus = (typeof TRF_STATUSES)[number];

/** The agreed forward moves for a TRF. A step outside this table is refused. */
export const TRF_STATUS_TRANSITIONS: Record<TrfStatus, readonly TrfStatus[]> = {
  New: ['Assigned', 'Cancelled'],
  Assigned: ['In Progress', 'Cancelled'],
  'In Progress': ['Analysis Completed', 'Cancelled'],
  'Analysis Completed': ['COA Pending', 'Cancelled'],
  'COA Pending': ['Completed', 'Cancelled'],
  Completed: [],
  Cancelled: [],
};

export function canTransitionTrf(from: TrfStatus, to: TrfStatus): boolean {
  return (TRF_STATUS_TRANSITIONS[from] ?? []).includes(to);
}

export const ANALYSIS_STATUSES = [
  'Pending', 'Assigned', 'In Progress', 'Completed', 'Re-test Required', 'Cancelled',
] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

export const ANALYSIS_STATUS_TRANSITIONS: Record<AnalysisStatus, readonly AnalysisStatus[]> = {
  Pending: ['Assigned', 'Cancelled'],
  Assigned: ['In Progress', 'Cancelled'],
  'In Progress': ['Completed', 'Cancelled'],
  Completed: ['Re-test Required'],
  'Re-test Required': ['In Progress'],
  Cancelled: [],
};

export function canTransitionAnalysis(from: AnalysisStatus, to: AnalysisStatus): boolean {
  return (ANALYSIS_STATUS_TRANSITIONS[from] ?? []).includes(to);
}

export const COA_STATUSES = ['Pending', 'Draft', 'Under Review', 'Approved', 'Issued'] as const;
export type CoaStatus = (typeof COA_STATUSES)[number];

export const COA_STATUS_TRANSITIONS: Record<CoaStatus, readonly CoaStatus[]> = {
  Pending: ['Draft'],
  Draft: ['Under Review'],
  'Under Review': ['Approved', 'Draft'],
  Approved: ['Issued'],
  Issued: [],
};

export function canTransitionCoa(from: CoaStatus, to: CoaStatus): boolean {
  return (COA_STATUS_TRANSITIONS[from] ?? []).includes(to);
}

/** The Final Status of the ARD block. These four values are the workflow. */
export const ArdWorkflowStatus = ['Received', 'In Progress', 'Completed', 'Cancelled'] as const;
export type ArdWorkflowStatus = (typeof ArdWorkflowStatus)[number];

/**
 * Stage says where the sample is in the laboratory; Final Status says where
 * the request is in the workflow. They are separate dropdowns and separate
 * columns. Stage values live in the ard_stages master table, so they are
 * dynamic TEXT at the database level and validated by the application.
 */
export const DEFAULT_ARD_STAGE = 'Initial';

/** Workflow values that older TRF rows still hold in ard_stage. They are not
 * stages, so they are kept in ard_stages as inactive legacy values: existing
 * rows still display them, but only active stages are offered in the dropdown. */
export const LEGACY_ARD_STAGES: readonly string[] = ['Received', 'In Progress', 'Completed', 'Cancelled'];

export type ArdStage = string;

export const TERMINAL_ARD_STATUSES: readonly ArdWorkflowStatus[] = ['Completed', 'Cancelled'];
export const ArdReportingStatus = ['Pending', 'Draft', 'Submitted', 'Reviewed', 'Approved', 'Rejected'] as const;
export type ArdReportingStatus = (typeof ArdReportingStatus)[number];
/** The values the Reporting dropdown offers, in order. */
export const ARD_REPORTING_STATUSES = ArdReportingStatus;
export const ArdCoaStatus = ['Pending', 'Draft', 'Under Review', 'Approved', 'Issued'] as const;
export type ArdCoaStatus = (typeof ArdCoaStatus)[number];
/** The values the COA dropdown offers, in order. */
export const ARD_COA_STATUSES = ArdCoaStatus;

export const REMARKS_STATUSES = ['Pending', 'Approved', 'Rejected'] as const;
export type RemarksStatus = (typeof REMARKS_STATUSES)[number];

/** Status values for the ARD team's free-text remark. Pending is the default for new TRFs. */
export const ARD_REMARKS_STATUSES = ['Pending', 'Sample Received', 'Under Analysis', 'Result Reported', 'Retest Required', 'On Hold', 'Completed'] as const;
export type ArdRemarksStatus = (typeof ARD_REMARKS_STATUSES)[number];

/**
 * Forward moves for an ARD workflow. The stepper uses this to draw the path
 * from Received to Completed. The Final Status dropdown itself offers every
 * value, because a request can also be moved back out of a terminal state.
 */
export const ARD_WORKFLOW_TRANSITIONS: Record<ArdWorkflowStatus, readonly ArdWorkflowStatus[]> = {
  Received: ['In Progress', 'Cancelled'],
  'In Progress': ['Completed', 'Cancelled'],
  Completed: [],
  Cancelled: [],
};

export function canTransitionArd(from: ArdWorkflowStatus, to: ArdWorkflowStatus): boolean {
  return (ARD_WORKFLOW_TRANSITIONS[from] ?? []).includes(to);
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export interface Department {
  id: number;
  name: string;
  isActive: boolean;
}

/** Modules shown in the sidebar, with the roles that may open them. Enforced again on the server. */
export const MODULE_ACCESS: Record<string, readonly Role[]> = {
  dashboard: ['Admin', 'Manager', 'Analyst', 'Viewer'],
  trf: ['Admin', 'Manager', 'Analyst', 'Viewer'],
  assignments: ['Admin', 'Manager', 'Analyst'],
  analysis: ['Admin', 'Manager', 'Analyst', 'Viewer'],
  coa: ['Admin', 'Manager', 'Viewer'],
  employees: ['Admin', 'Manager'],
  reports: ['Admin', 'Manager', 'Viewer'],
  audit: ['Admin', 'Manager'],
  settings: ['Admin'],
};

export function canAccessModule(module: string, role: Role): boolean {
  return (MODULE_ACCESS[module] ?? []).includes(role);
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  database: 'connected' | 'unavailable';
  version: string;
  serverTime: string;
}

export interface ApiError {
  error: { code: string; message: string; fields?: Record<string, string> };
  requestId?: string;
}
