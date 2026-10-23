/** Single source of truth for what each role may do. The server enforces this; the UI only hides what it knows. */

export const ROLES = ['Admin', 'Manager', 'Analyst', 'Viewer', 'GM', 'AGM'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'dashboard.view',
  'trf.view',
  'trf.viewAll',
  'trf.create',
  'trf.editFormulation',
  'trf.editArd',
  'trf.assign',
  'trf.changeStatus',
  'trf.delete',
  'assignments.viewAll',
  'assignments.viewOwn',
  'assignments.manage',
  'analysis.view',
  'analysis.viewAll',
  'analysis.enterResults',
  'analysis.changeStatus',
  'coa.view',
  'coa.prepare',
  'coa.approve',
  'coa.issue',
  'employees.view',
  'employees.manage',
  'reports.view',
  'reports.export',
  'audit.view',
  'settings.manage',
  'approval.formulation',
  'approval.ard',
  'teamaccounts.manage',
  'notifications.view',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  Admin: PERMISSIONS,
  Manager: [
    'dashboard.view',
    'trf.view',
    'trf.viewAll',
    'trf.create',
    'trf.editArd',
    'trf.assign',
    'trf.changeStatus',
    'assignments.viewAll',
    'assignments.manage',
    'analysis.view',
    'analysis.viewAll',
    'coa.view',
    'coa.prepare',
    'coa.approve',
    'coa.issue',
    'employees.view',
    'reports.view',
    'reports.export',
    'audit.view',
  ],
  Analyst: [
    'dashboard.view',
    'trf.view',
    'assignments.viewOwn',
    'analysis.view',
    'analysis.enterResults',
    'analysis.changeStatus',
    'coa.view',
    'reports.view',
    'reports.export',
  ],
  Viewer: [
    'dashboard.view',
    'trf.view',
    'trf.viewAll',
    'analysis.view',
    'coa.view',
    'reports.view',
    'reports.export',
  ],
  GM: [
    'dashboard.view',
    'trf.view',
    'trf.viewAll',
    'trf.editFormulation',
    'trf.changeStatus',
    'assignments.viewAll',
    'analysis.view',
    'analysis.viewAll',
    'coa.view',
    'reports.view',
    'reports.export',
    'audit.view',
    'approval.formulation',
    'notifications.view',
  ],
  AGM: [
    'dashboard.view',
    'trf.view',
    'trf.viewAll',
    'trf.editArd',
    'trf.changeStatus',
    'assignments.viewAll',
    'analysis.view',
    'analysis.viewAll',
    'coa.view',
    'reports.view',
    'reports.export',
    'audit.view',
    'approval.ard',
    'notifications.view',
  ],
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function permissionsForRole(role: Role): Permission[] {
  return [...(ROLE_PERMISSIONS[role] ?? [])];
}

export const FORMULATION_DEPARTMENT = 'Formulation';
export const ARD_DEPARTMENT = 'ARD';

interface RoleAndDepartment { role: Role; departmentName: string | null }

/**
 * Formulation department users (plus any Admin) may create and edit Part A
 * fields on the TRF. A Manager who is not in Formulation is refused.
 */
export function canEditTrfPartA(employee: RoleAndDepartment): boolean {
  return employee.role === 'Admin' || employee.role === 'Manager' || employee.departmentName === FORMULATION_DEPARTMENT;
}

/**
 * ARD department users (plus Admin and any Manager) may edit Part B fields
 * and drive the workflow. Analysts and Viewers without the ARD department
 * are refused.
 */
export function canEditTrfPartB(employee: RoleAndDepartment): boolean {
  return employee.role === 'Admin' || employee.role === 'Manager' || employee.departmentName === ARD_DEPARTMENT;
}

/**
 * Deletion is restricted to Admin and Formulation department users, and only
 * for their own TRFs that are still "New" with no dependent work.
 */
export function canDeleteTrf(employee: RoleAndDepartment): boolean {
  return employee.role === 'Admin' || employee.departmentName === FORMULATION_DEPARTMENT;
}

export const TEAM_TYPES = ['FRD', 'ARD'] as const;
export type TeamType = (typeof TEAM_TYPES)[number];

export const ACCOUNT_TYPES = ['INDIVIDUAL', 'SHARED_TEAM'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const APPROVAL_TRACKS = ['FORMULATION', 'ARD'] as const;
export type ApprovalTrack = (typeof APPROVAL_TRACKS)[number];

export const APPROVAL_STATUSES = ['Pending', 'Approved', 'Rejected', 'Returned'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export interface TeamAccount {
  id: number;
  team: TeamType;
  username: string;
  email: string;
  isActive: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TeamMember {
  id: number;
  employeeCode: string;
  fullName: string;
  designation: string | null;
  departmentName: string | null;
  isActive: boolean;
  pinFailedAttempts: number;
  pinLockedUntil: string | null;
}

export interface TrfApproval {
  id: number;
  trfId: number;
  track: ApprovalTrack;
  status: ApprovalStatus;
  requestedByEmployeeId: number;
  requestedByAccountId: number;
  requestedAt: string;
  decidedBy: number | null;
  decidedAt: string | null;
  reason: string | null;
  version: number;
}

export interface Notification {
  id: number;
  recipientType: 'EMPLOYEE' | 'TEAM';
  recipientEmployeeId: number | null;
  recipientTeam: TeamType | null;
  type: string;
  title: string;
  body: string;
  relatedTrfId: number | null;
  link: string | null;
  isRead: boolean;
  createdAt: string;
  readAt: string | null;
}

export interface EmailOutbox {
  id: number;
  to: string;
  cc: string | null;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  fromMailbox: string;
  relatedTrfId: number | null;
  actingEmployeeId: number | null;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface DepartmentMailbox {
  team: TeamType;
  address: string;
  displayName: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassEncrypted: string;
  isActive: boolean;
}

export function isSharedTeamAccount(role: Role): boolean {
  return role === 'GM' || role === 'AGM' ? false : false; // This is determined by account_type, not role
}

export function canApproveFormulation(role: Role): boolean {
  return role === 'GM' || role === 'Admin';
}

export function canApproveArd(role: Role): boolean {
  return role === 'AGM' || role === 'Admin';
}

export function requiresNameSelection(accountType: AccountType): boolean {
  return accountType === 'SHARED_TEAM';
}
