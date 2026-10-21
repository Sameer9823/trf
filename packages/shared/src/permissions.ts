/** Single source of truth for what each role may do. The server enforces this; the UI only hides what it knows. */

export const ROLES = ['Admin', 'Manager', 'Analyst', 'Viewer'] as const;
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
