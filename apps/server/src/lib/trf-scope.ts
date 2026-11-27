import { canEditTrfPartB, roleHasPermission } from '@trf/shared';
import type { EmployeeProfile } from '@trf/shared';

/**
 * The TRF list's visibility scope, in one place so the list and the dashboard
 * apply exactly the same rule. A role with trf.viewAll sees everything; everyone
 * else sees only the TRFs they created or are the assigned employee on, plus —
 * for the ARD team — TRFs Formulation has approved and not yet locked (waiting
 * for ARD action).
 */
export interface TrfScope {
  employeeId: number;
  includeApproved: boolean;
}

export function scopeFor(employee: EmployeeProfile): TrfScope | null {
  if (roleHasPermission(employee.role, 'trf.viewAll')) return null;
  return { employeeId: employee.id, includeApproved: canEditTrfPartB(employee) };
}

/**
 * Pushes the scope parameter (when there is one) and returns the SQL clause
 * without a leading boolean, so the caller can AND it into a WHERE. Returns an
 * empty string for a role that sees everything.
 *
 * A TRF is visible when ANY is true:
 *  1) t.created_by = me or t.assigned_employee_id = me
 *  2) I am an analyst on any test of it (EXISTS on ard_test_assignment_analysts)
 *  3) I am ARD-team (includeApproved), the TRF is approved and not locked, AND
 *     no analyst is assigned to any test of it yet (negated EXISTS)
 */
export function trfScopeClause(scope: TrfScope | null, params: unknown[]): string {
  if (!scope) return '';
  params.push(scope.employeeId);
  const me = params.length;
  const own = `(t.assigned_employee_id = $${me} OR t.created_by = $${me})`;
  const analystExists = `EXISTS (SELECT 1 FROM ard_test_assignments a JOIN ard_test_assignment_analysts x ON x.assignment_id = a.id WHERE a.trf_id = t.id AND x.analyst_id = $${me})`;
  const noAnalyst = `NOT EXISTS (SELECT 1 FROM ard_test_assignments a JOIN ard_test_assignment_analysts x ON x.assignment_id = a.id WHERE a.trf_id = t.id)`;
  const base = `(${own} OR ${analystExists})`;
  return scope.includeApproved
    ? `(${base} OR (t.remarks_status = 'Approved' AND t.locked_at IS NULL AND ${noAnalyst}))`
    : base;
}