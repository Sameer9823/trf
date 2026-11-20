import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { PERMISSIONS, ROLE_PERMISSIONS, ROLES, permissionsForRole, roleHasPermission, canApproveFormulation, canApproveArd, canReopenLockedTrf } from '@trf/shared';
import { EXPORT_SHEETS, MESSAGES, sheetsFor } from '@trf/shared';

test('every role has a permission list and every listed permission is known', () => {
  for (const role of ROLES) {
    const list = ROLE_PERMISSIONS[role];
    assert.ok(Array.isArray(list), `${role} has no permission list`);
    for (const permission of list) {
      assert.ok((PERMISSIONS as readonly string[]).includes(permission), `${role} references unknown permission ${permission}`);
    }
  }
});

test('Admin can do everything', () => {
  for (const permission of PERMISSIONS) assert.ok(roleHasPermission('Admin', permission), `Admin missing ${permission}`);
});

test('an unknown role has no permissions', () => {
  assert.equal(roleHasPermission('Nobody' as never, 'trf.view'), false);
  assert.deepEqual(permissionsForRole('Nobody' as never), []);
});

test('only Admin manages employees and settings', () => {
  assert.equal(roleHasPermission('Admin', 'employees.manage'), true);
  for (const role of ['Manager', 'Analyst', 'Viewer'] as const) {
    assert.equal(roleHasPermission(role, 'employees.manage'), false, `${role} must not manage employees`);
    assert.equal(roleHasPermission(role, 'settings.manage'), false, `${role} must not manage settings`);
  }
});

test('Manager manages TRFs, assignments and monitoring but not employee accounts', () => {
  assert.equal(roleHasPermission('Manager', 'trf.create'), true);
  assert.equal(roleHasPermission('Manager', 'trf.editArd'), true);
  assert.equal(roleHasPermission('Manager', 'trf.editFormulation'), false);
  assert.equal(roleHasPermission('Manager', 'trf.delete'), false);
  assert.equal(roleHasPermission('Manager', 'assignments.manage'), true);
  assert.equal(roleHasPermission('Manager', 'analysis.viewAll'), true);
  assert.equal(roleHasPermission('Manager', 'employees.view'), true);
  assert.equal(roleHasPermission('Manager', 'employees.manage'), false);
  assert.equal(roleHasPermission('Manager', 'analysis.enterResults'), false);
});

test('Analyst sees ARD data via TRFs but cannot edit them', () => {
  assert.equal(roleHasPermission('Analyst', 'trf.view'), true);
  assert.equal(roleHasPermission('Analyst', 'trf.editArd'), false);
  assert.equal(roleHasPermission('Analyst', 'trf.editFormulation'), false);
});

test('Analyst sees ARD data via TRFs but cannot edit them or see all TRFs', () => {
  assert.equal(roleHasPermission('Analyst', 'trf.view'), true);
  assert.equal(roleHasPermission('Analyst', 'trf.viewAll'), false);
  assert.equal(roleHasPermission('Analyst', 'trf.editFormulation'), false);
  assert.equal(roleHasPermission('Analyst', 'trf.editArd'), false);
  assert.equal(roleHasPermission('Analyst', 'assignments.viewOwn'), true);
  assert.equal(roleHasPermission('Analyst', 'assignments.viewAll'), false);
  assert.equal(roleHasPermission('Analyst', 'analysis.enterResults'), true);
  assert.equal(roleHasPermission('Analyst', 'analysis.viewAll'), false);
  assert.equal(roleHasPermission('Analyst', 'audit.view'), false);
  assert.equal(roleHasPermission('Analyst', 'employees.view'), false);
  // An Analyst may save their own work as a file, but the export is scoped to
  // them and carries no Employees or Audit Log sheet.
  assert.equal(roleHasPermission('Analyst', 'reports.export'), true);
  assert.deepEqual(sheetsFor('own', 'Analyst'), ['TRF Master', 'ARD Tracking', 'Analysis', 'Assignments', 'COA', 'Dashboard Data']);
  assert.ok(!sheetsFor('own', 'Analyst').includes('Audit Log'));
  assert.ok(!sheetsFor('all', 'Analyst').includes('Employees'), 'a scoped export never widens by asking for everything');
});

test('an export never grants a sheet its own permission would refuse', () => {
  // A Viewer reads every TRF but not the employee directory or the audit log.
  // Reading "all" must not become a way around those two restrictions.
  assert.ok(!sheetsFor('all', 'Viewer').includes('Employees'));
  assert.ok(!sheetsFor('all', 'Viewer').includes('Audit Log'));
  assert.ok(sheetsFor('all', 'Viewer').includes('TRF Master'));
  // A Manager may list employees, but only an Admin may create them.
  assert.ok(sheetsFor('all', 'Manager').includes('Employees'));
  assert.deepEqual(sheetsFor('all', 'Admin'), [...EXPORT_SHEETS]);
});

test('Viewer is read-only and cannot create, assign or approve', () => {
  assert.equal(roleHasPermission('Viewer', 'trf.view'), true);
  assert.equal(roleHasPermission('Viewer', 'analysis.view'), true);
  assert.equal(roleHasPermission('Viewer', 'coa.view'), true);
  assert.equal(roleHasPermission('Viewer', 'reports.export'), true);
  for (const permission of ['trf.create', 'trf.assign', 'trf.editFormulation', 'trf.editArd', 'trf.delete', 'assignments.manage',
    'analysis.enterResults', 'coa.approve', 'coa.issue', 'employees.view'] as const) {
    assert.equal(roleHasPermission('Viewer', permission), false, `Viewer must not hold ${permission}`);
  }
});

test('GM has full approval authority over both FRD and ARD tracks', () => {
  assert.equal(roleHasPermission('GM', 'approval.formulation'), true);
  assert.equal(roleHasPermission('GM', 'approval.ard'), true);
  assert.equal(roleHasPermission('GM', 'trf.editFormulation'), true);
  assert.equal(roleHasPermission('GM', 'trf.editArd'), true);
  assert.equal(roleHasPermission('GM', 'assignments.manage'), true);
  assert.equal(roleHasPermission('GM', 'analysis.enterResults'), true);
  assert.equal(roleHasPermission('GM', 'coa.approve'), true);
  assert.equal(roleHasPermission('GM', 'coa.issue'), true);
  assert.equal(roleHasPermission('GM', 'employees.view'), true);
});

test('AGM has full ARD authority but NOT Formulation approval', () => {
  assert.equal(roleHasPermission('AGM', 'approval.ard'), true);
  assert.equal(roleHasPermission('AGM', 'approval.formulation'), false);
  assert.equal(roleHasPermission('AGM', 'trf.editFormulation'), false);
  assert.equal(roleHasPermission('AGM', 'trf.editArd'), true);
  assert.equal(roleHasPermission('AGM', 'assignments.manage'), true);
  assert.equal(roleHasPermission('AGM', 'analysis.changeStatus'), true);
  assert.equal(roleHasPermission('AGM', 'coa.approve'), true);
  assert.equal(roleHasPermission('AGM', 'coa.issue'), true);
  assert.equal(roleHasPermission('AGM', 'employees.view'), true);
});

test('standard messages keep the agreed wording', () => {
  assert.equal(MESSAGES.CONFLICT, 'This record was changed by someone else. Please reload and try again.');
  assert.equal(MESSAGES.NO_PERMISSION, 'Your account does not have permission to perform this action.');
  assert.equal(MESSAGES.SERVER_UNAVAILABLE, 'Company server is unavailable. Please connect to the company network.');
  assert.equal(MESSAGES.INVALID_CREDENTIALS, 'Invalid username or password.');
});

test('Formulation approval: Admin and GM; AGM cannot approve FRD', () => {
  assert.equal(canApproveFormulation('Admin'), true);
  assert.equal(canApproveFormulation('GM'), true);
  assert.equal(canApproveFormulation('AGM'), false);
  for (const role of ['Manager', 'Analyst', 'Viewer'] as const) {
    assert.equal(canApproveFormulation(role), false, `${role} must not be able to approve FRD`);
  }
});

test('ARD approval: Admin, GM, and AGM', () => {
  assert.equal(canApproveArd('Admin'), true);
  assert.equal(canApproveArd('GM'), true);
  assert.equal(canApproveArd('AGM'), true);
  for (const role of ['Manager', 'Analyst', 'Viewer'] as const) {
    assert.equal(canApproveArd(role), false, `${role} must not be able to approve ARD`);
  }
});

test('Unlock/reopen: Admin and GM only; AGM cannot unlock', () => {
  for (const role of ['Manager', 'Analyst', 'Viewer'] as const) {
    assert.equal(canReopenLockedTrf(role), false, `${role} must not be able to unlock`);
  }
  assert.equal(canReopenLockedTrf('Admin'), true);
  assert.equal(canReopenLockedTrf('GM'), true);
  assert.equal(canReopenLockedTrf('AGM'), false, 'AGM must not be able to unlock');
  assert.equal(canReopenLockedTrf(undefined), false, 'no employee means no unlock');
});
