import { NextFunction, Request, Response } from 'express';
import { ZodSchema } from 'zod';
import { Role, canEditTrfPartA, canEditTrfPartB, canDeleteTrf, permissionsForRole, roleHasPermission, Permission, EmployeeProfile, AccountType, TeamType, MESSAGES } from '@trf/shared';
import { AppError, badRequest, forbidden, notFound, unauthorized } from '../lib/errors';
import { verifyAccessToken } from '../lib/tokens';
import { pool } from '../db';
import { EMPLOYEE_FROM, EMPLOYEE_SELECT, EmployeeRow, toProfile } from '../lib/employees';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      employee?: EmployeeProfile;
      actingEmployeeId?: number | null;
      accountId?: number | null;
    }
  }
}

/** Validates and replaces req.body. Runs before any handler touches the database. */
export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const fields: Record<string, string> = {};
      for (const issue of result.error.issues) {
        fields[issue.path.join('.') || 'form'] = issue.message;
      }
      return next(badRequest('Some details are not valid. Please check the highlighted fields.', fields));
    }
    req.body = result.data;
    next();
  };
}

interface AuthCacheEntry { employee: EmployeeProfile; expiresAt: number }
const AUTH_CACHE_TTL_MS = 5_000;
const authCache = new Map<number, AuthCacheEntry>();

/**
 * Verifies the bearer token and loads the active employee. A deactivated or
 * deleted employee loses access immediately, even with an unexpired token.
 * For shared team accounts, also validates the actingEmployeeId.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized('Sign in to continue.');

    const payload = verifyAccessToken(header.slice(7).trim());
    const id = Number(payload.sub);
    const actingEmployeeId = payload.actingEmployeeId ?? null;
    const accountId = payload.accountId ?? null;

    // Store actingEmployeeId and accountId on the request for easy access
    req.actingEmployeeId = actingEmployeeId;
    req.accountId = accountId;

    const cached = authCache.get(id);
    if (cached && cached.expiresAt > Date.now()) {
      req.employee = cached.employee;
      // For shared team accounts, validate the acting employee
      if (req.employee.accountType === 'SHARED_TEAM') {
        await validateActingEmployee(req);
      }
      return next();
    }

    const result = await pool.query<EmployeeRow>(
      `SELECT ${EMPLOYEE_SELECT} ${EMPLOYEE_FROM} WHERE e.id = $1`, [id]);
    const row = result.rows[0];
    if (!row) throw unauthorized('Sign in to continue.');
    if (!row.is_active) throw unauthorized('Your account is not active. Please contact your administrator.');

    const employee = toProfile(row);
    authCache.set(id, { employee, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
    req.employee = employee;

    // For shared team accounts, validate the acting employee
    if (employee.accountType === 'SHARED_TEAM') {
      await validateActingEmployee(req);
    }

    next();
  } catch (err) {
    next(err instanceof AppError ? err : unauthorized('Your session has expired. Please sign in again.'));
  }
}

async function validateActingEmployee(req: Request): Promise<void> {
  const { actingEmployeeId, accountId } = req;
  const employee = req.employee;
  
  if (!employee) {
    throw unauthorized('No employee in session.');
  }
  
  if (!actingEmployeeId) {
    throw unauthorized(MESSAGES.SELECT_MEMBER_REQUIRED);
  }

  // Verify the acting employee exists and is active
  const result = await pool.query<EmployeeRow>(
    `SELECT ${EMPLOYEE_SELECT} ${EMPLOYEE_FROM} WHERE e.id = $1`, [actingEmployeeId]);
  const actingEmployee = result.rows[0];
  
  if (!actingEmployee) {
    throw unauthorized(MESSAGES.MEMBER_INACTIVE);
  }
  if (!actingEmployee.is_active) {
    throw unauthorized(MESSAGES.MEMBER_INACTIVE);
  }
  if (actingEmployee.account_type !== 'SHARED_TEAM') {
    throw unauthorized('The selected user is not a team member.');
  }
  if (actingEmployee.team !== employee.team) {
    throw unauthorized(MESSAGES.MEMBER_WRONG_TEAM);
  }

  // Verify the team account matches
  if (accountId) {
    const teamAccountResult = await pool.query<{ id: number; team: string }>(
      `SELECT id, team FROM team_accounts WHERE id = $1`, [accountId]);
    const teamAccount = teamAccountResult.rows[0];
    if (!teamAccount || teamAccount.team !== employee.team) {
      throw unauthorized('Invalid team account.');
    }
  }
}

/** Drops the cached profile so a role change or deactivation takes effect at once. */
export function invalidateEmployeeCache(id: number): void {
  authCache.delete(id);
}

export function invalidateAllEmployeeCaches(): void {
  authCache.clear();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.employee) return next(unauthorized('Sign in to continue.'));
    if (!roles.includes(req.employee.role)) return next(forbidden());
    next();
  };
}

/** Server-side authorization: the UI hiding a button is never the protection. */
export function requirePermission(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.employee) return next(unauthorized('Sign in to continue.'));
    if (!permissions.every((p) => roleHasPermission(req.employee!.role, p))) return next(forbidden());
    next();
  };
}

export function currentEmployee(req: Request): EmployeeProfile {
  if (!req.employee) throw notFound('No signed-in employee.');
  return req.employee;
}

export function currentActingEmployeeId(req: Request): number {
  if (!req.actingEmployeeId) throw unauthorized(MESSAGES.NO_ACTING_MEMBER);
  return req.actingEmployeeId;
}

export function currentAccountId(req: Request): number {
  if (!req.accountId) throw unauthorized('No team account in session.');
  return req.accountId;
}

export function employeePermissions(role: Role) {
  return permissionsForRole(role);
}

/** Formulation department users (plus Admin and Manager) may create TRFs.
 * ARD-only users are refused: a TRF is a formulation request, so only Part A
 * holders may start one. */
export function requireTrfCreate() {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.employee) return next(unauthorized('Sign in to continue.'));
    if (!canEditTrfPartA(req.employee)) return next(forbidden());
    next();
  };
}

/** Formulation department users (plus Admin and Manager) may create/edit
 * customers and products inline while filling in a TRF. */
export function requireTrfLookupEdit() {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.employee) return next(unauthorized('Sign in to continue.'));
    if (!canEditTrfPartA(req.employee)) return next(forbidden());
    next();
  };
}

/**
 * Formulation department users (plus any Admin) may create and edit Part A
 * fields on the TRF, and anyone who can also edit Part B may update those.
 * The server is the authority: the UI only hides the buttons it already knows
 * it cannot use.
 */
export function requireTrfEdit() {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.employee) return next(unauthorized('Sign in to continue.'));
    if (!canEditTrfPartA(req.employee) && !canEditTrfPartB(req.employee)) return next(forbidden());
    next();
  };
}

/**
 * ARD department users (plus Admin and Manager) may edit ARD fields and change
 * the workflow status.
 */
export function requireArdEdit() {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.employee) return next(unauthorized('Sign in to continue.'));
    if (!canEditTrfPartB(req.employee)) return next(forbidden());
    next();
  };
}

/**
 * Deletion is restricted to Admin and Formulation department users.
 */
export function requireTrfDelete() {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.employee) return next(unauthorized('Sign in to continue.'));
    if (!canDeleteTrf(req.employee)) return next(forbidden());
    next();
  };
}

/**
 * Require GM or Admin for Formulation approval.
 */
export function requireFormulationApproval() {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.employee) return next(unauthorized('Sign in to continue.'));
    if (req.employee.role !== 'GM' && req.employee.role !== 'Admin') return next(forbidden());
    next();
  };
}

/**
 * Require AGM or Admin for ARD approval.
 */
export function requireArdApproval() {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.employee) return next(unauthorized('Sign in to continue.'));
    if (req.employee.role !== 'AGM' && req.employee.role !== 'Admin') return next(forbidden());
    next();
  };
}
