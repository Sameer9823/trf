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
 */
export function trfScopeClause(scope: TrfScope | null, params: unknown[]): string {
  if (!scope) return '';
  params.push(scope.employeeId);
  const own = `(t.assigned_employee_id = $${params.length} OR t.created_by = $${params.length})`;
  return scope.includeApproved
    ? `(${own} OR (t.remarks_status = 'Approved' AND t.locked_at IS NULL))`
    : own;
}