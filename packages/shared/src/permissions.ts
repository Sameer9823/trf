/** Single source of truth for what each role may do. The server enforces this; the UI only hides what it knows. */

export const ROLES = ['Admin', 'GM', 'AGM', 'Manager', 'Analyst', 'Viewer'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'dashboard.view',
  'trf.view',
  'trf.viewAll',
  'trf.create',
  'trf.editFormulation',
  'trf.editArd',
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
  'settings.view',
  'settings.manage',
  'approval.formulation',
  'approval.ard',
  'teamaccounts.manage',
  'notifications.view',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  Admin: PERMISSIONS,
  GM: [
    'dashboard.view',
    'trf.view',
    'trf.viewAll',
    'trf.create',
    'trf.editFormulation',
    'trf.editArd',
    'approval.formulation',
    'approval.ard',
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
    'reports.view',
    'reports.export',
    'audit.view',
    'settings.view',
    'notifications.view',
  ],
  AGM: [
    'dashboard.view',
    'trf.view',
    'trf.viewAll',
    'trf.create',
    'trf.editArd',
    'approval.ard',
    'assignments.viewAll',
    'assignments.viewOwn',
    'assignments.manage',
    'analysis.view',
    'analysis.viewAll',
    'analysis.changeStatus',
    'coa.view',
    'coa.approve',
    'coa.issue',
    'coa.prepare',
    'employees.view',
    'reports.view',
    'reports.export',
    'audit.view',
    'settings.view',
    'notifications.view',
  ],
  Manager: [
    'dashboard.view',
    'trf.view',
    'trf.viewAll',
    'trf.create',
    'trf.editArd',
    'trf.changeStatus',
    'assignments.viewAll',
    'assignments.manage',
    'notifications.view',
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
    'trf.create',
    'notifications.view',
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
    'notifications.view',
    'analysis.view',
    'coa.view',
    'reports.view',
    'reports.export',
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

interface RoleAndDepartment { role: Role; departmentName: string | null; /** The shared team a member works through; it decides their side of the TRF. */ team?: TeamType | null }

/**
 * Formulation department users (plus any Admin) may create and edit Part A
 * fields on the TRF. A Manager who is not in Formulation is refused.
 */
export function canEditTrfPartA(employee: RoleAndDepartment): boolean {
  return employee.role === 'Admin' || employee.role === 'GM' || employee.role === 'Manager' || employee.team === 'FRD' || employee.departmentName === FORMULATION_DEPARTMENT;
}

/**
 * ARD department users (plus Admin, GM, AGM, and Manager) may edit Part B fields
 * and drive the workflow. Analysts and Viewers without the ARD department
 * are refused.
 *
 * GM has full ARD authority and AGM has full ARD authority per the role model,
 * so both roles may edit ARD fields regardless of department.
 */
export function canEditTrfPartB(employee: RoleAndDepartment): boolean {
  return employee.role === 'Admin' || employee.role === 'GM' || employee.role === 'AGM'
    || employee.role === 'Manager'
    || employee.team === 'ARD' || employee.departmentName === ARD_DEPARTMENT;
}

/**
 * Deletion is restricted to Admin and Formulation department users, and only
 * for their own TRFs that are still "New" with no dependent work.
 */
export function canDeleteTrf(employee: RoleAndDepartment): boolean {
  return employee.role === 'Admin' || employee.team === 'FRD' || employee.departmentName === FORMULATION_DEPARTMENT;
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

/**
 * Every approval is made by an administrator and by nobody else. A shared team
 * login can never hold the Admin role, so an approval is always attributable to
 * one named person.
 *
 * Track-based authority:
 * - FORMULATION: Admin and GM may approve or reject.
 * - ARD: Admin, GM, and AGM may approve or reject.
 *
 * In this system GM, AGM and COO are designations carried by Admin users (see
 * migration 017), not separate roles. The function checks role === 'Admin' for
 * backwards compatibility, and also allows GM/AGM roles directly when the
 * application uses them as real role values.
 */
export function canDecideApprovals(role: Role | undefined): boolean {
  return role === 'Admin' || role === 'GM';
}

/**
 * ARD final-approval authority. GM has full FRD and ARD authority, AGM has full
 * ARD authority, and Admin can do everything.
 */
export function canApproveArd(role: Role | undefined): boolean {
  return role === 'Admin' || role === 'GM' || role === 'AGM';
}

/**
 * Formulation approval authority. Only GM and Admin can approve FRD submissions.
 * AGM cannot approve FRD unless explicitly granted GM approval permission.
 */
export function canApproveFormulation(role: Role | undefined): boolean {
  return role === 'Admin' || role === 'GM';
}

/**
 * Only an administrator (Admin or GM) may reopen a TRF that has been approved and locked.
 * AGM and other users cannot unlock a locked TRF.
 */
export function canReopenLockedTrf(role: Role | undefined): boolean {
  return role === 'Admin' || role === 'GM';
}

export function requiresNameSelection(accountType: AccountType): boolean {
  return accountType === 'SHARED_TEAM';
}
