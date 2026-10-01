/** Single source of truth for what each role may do. The server enforces this; the UI only hides what it knows. */

export const ROLES = ['Admin', 'Manager', 'Analyst', 'Viewer'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'dashboard.view',
  'trf.view',
  'trf.viewAll',
  'trf.create',
  'trf.edit',
  'trf.assign',
  'trf.changeStatus',
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
    'trf.edit',
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
