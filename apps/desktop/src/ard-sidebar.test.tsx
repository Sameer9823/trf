import { describe, expect, test } from 'vitest';
import type { EmployeeProfile } from '@trf/shared';
import { MODULE_ACCESS } from '@trf/shared';
import { NAV, visibleNav } from './components/Layout';

function employee(role: string, departmentName: string | null, team: string | null = null): EmployeeProfile {
  return {
    id: 1, employeeCode: 'T-001', fullName: 'Test', username: 'test',
    role, designation: role, email: 'test@test.local',
    departmentId: departmentName ? 1 : null, departmentName, accountType: 'INDIVIDUAL', team,
    pinFailedAttempts: 0, pinLockedUntil: null,
  } as EmployeeProfile;
}

// The ARD workspace is Manager+ only; analysts reach their own tests through Assignments.
const mayAccessArd = (e: EmployeeProfile) => (MODULE_ACCESS['ard'] ?? []).includes(e.role);

describe('ARD sidebar visibility', () => {
  test('ARD nav item exists', () => {
    expect(NAV.find((n) => n.module === 'ard')).toBeDefined();
  });

  test('ARD analyst does not see the ARD nav item', () => {
    expect(mayAccessArd(employee('Analyst', 'ARD', 'ARD'))).toBe(false);
  });

  test('Manager sees the ARD nav item', () => {
    expect(mayAccessArd(employee('Manager', null))).toBe(true);
  });

  test('AGM sees the ARD nav item', () => {
    expect(mayAccessArd(employee('AGM', null))).toBe(true);
  });

  test('Admin sees the ARD nav item', () => {
    expect(mayAccessArd(employee('Admin', null))).toBe(true);
  });

  test('Viewer does not see the ARD nav item', () => {
    expect(mayAccessArd(employee('Viewer', 'ARD'))).toBe(false);
  });

  test('Formulation-only analyst does not see the ARD nav item', () => {
    expect(mayAccessArd(employee('Analyst', 'Formulation', 'FRD'))).toBe(false);
  });
});

describe('main dashboard visibility', () => {
  const all = () => true;

  test('an ARD team member has no main dashboard, but keeps TRF and Assignments', () => {
    const nav = visibleNav(employee('Analyst', 'ARD', 'ARD'), all);
    expect(nav.some((n) => n.module === 'dashboard')).toBe(false);
    expect(nav.some((n) => n.module === 'trf')).toBe(true);
    expect(nav.some((n) => n.module === 'assignments')).toBe(true);
  });

  test('the main dashboard stays for managers, other teams, and individual accounts', () => {
    expect(visibleNav(employee('Manager', null), all).some((n) => n.module === 'dashboard')).toBe(true);
    expect(visibleNav(employee('Analyst', 'Formulation', 'FRD'), all).some((n) => n.module === 'dashboard')).toBe(true);
    expect(visibleNav(null, all).some((n) => n.module === 'dashboard')).toBe(true);
  });

  test('the dashboard is hidden for an ARD team member even when the role would allow it', () => {
    // Role alone (Analyst) would permit the dashboard; the ARD team rule overrides it.
    const nav = visibleNav(employee('Analyst', 'ARD', 'ARD'), all);
    expect(NAV.some((n) => n.module === 'dashboard')).toBe(true); // it exists for others
    expect(nav.some((n) => n.module === 'dashboard')).toBe(false);
  });
});