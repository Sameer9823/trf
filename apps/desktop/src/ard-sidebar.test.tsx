import { describe, expect, test } from 'vitest';
import type { EmployeeProfile } from '@trf/shared';
import { MODULE_ACCESS } from '@trf/shared';
import { NAV } from './components/Layout';

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