import { NextFunction, Request, Response } from 'express';
import { ZodSchema } from 'zod';
import { Role, canEditTrfPartA, canEditTrfPartB, canDeleteTrf, permissionsForRole, roleHasPermission, Permission, EmployeeProfile, TeamType, MESSAGES } from '@trf/shared';
import { AppError, badRequest, forbidden, notFound, unauthorized } from '../lib/errors';
import { verifyAccessToken } from '../lib/tokens';
import { pool } from '../db';
import { EMPLOYEE_FROM, EMPLOYEE_SELECT, EmployeeRow, toProfile } from '../lib/employees';
import { actorStore } from '../lib/actor';
import { TEAM_LABEL, teamPseudoProfile, loadTeamAccount } from '../lib/team-accounts';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      employee?: EmployeeProfile;
      actingEmployeeId?: number | null;
      accountId?: number | null;
      /** A team login that has not yet chosen a member: it may do nothing but choose one. */
      teamPending?: boolean;
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

/** The only calls a team login may make before a member has chosen their name and entered a PIN. */
const PENDING_MEMBER_ALLOWED = [
  '/api/auth/me', '/api/auth/select-member', '/api/auth/logout', '/api/auth/refresh',
  '/api/employees/team-members',
];

/**
 * Verifies the bearer token and loads who is acting. A deactivated or deleted
 * employee loses access immediately, even with an unexpired token.
 *
 * Two kinds of token exist. An employee token names one person. A team token
 * names a shared team account (FRD or ARD); until a member chooses their name
 * and enters their PIN it can do nothing, and afterwards every request is made
 * as that member, with that member's own role, so a shared password never
 * carries more rights than the person using it.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized('Sign in to continue.');

    const payload = verifyAccessToken(header.slice(7).trim());
    const id = Number(payload.sub);
    if (!Number.isInteger(id) || id <= 0) throw unauthorized('Sign in to continue.');

    if (payload.kind === 'team') {
      const account = await loadTeamAccount(id);
      if (!account || !account.is_active) throw unauthorized('Your account is not active. Please contact your administrator.');
      req.accountId = account.id;

      const actingId = payload.actingEmployeeId ?? null;
      if (!actingId) {
        const url = req.originalUrl.split('?')[0];
        if (!PENDING_MEMBER_ALLOWED.includes(url)) throw new AppError(403, 'SELECT_MEMBER_REQUIRED', MESSAGES.SELECT_MEMBER_REQUIRED);
        req.employee = teamPseudoProfile(account);
        req.teamPending = true;
        req.actingEmployeeId = null;
        return actorStore.run({ actorEmployeeId: null, accountId: account.id }, () => next());
      }

      const result = await pool.query<EmployeeRow>(
        `SELECT ${EMPLOYEE_SELECT} ${EMPLOYEE_FROM} WHERE e.id = $1`, [actingId]);
      const member = result.rows[0];
      if (!member || !member.is_active) throw unauthorized(MESSAGES.MEMBER_INACTIVE);
      if (member.account_type !== 'SHARED_TEAM' || member.role === 'Admin') throw unauthorized('The selected user is not a team member.');
      if (member.team !== account.team) throw unauthorized(MESSAGES.MEMBER_WRONG_TEAM);

      req.employee = toProfile(member);
      req.actingEmployeeId = member.id;
      return actorStore.run({ actorEmployeeId: member.id, accountId: account.id }, () => next());
    }

    req.actingEmployeeId = null;
    req.accountId = null;

    let employee: EmployeeProfile;
    const cached = authCache.get(id);
    if (cached && cached.expiresAt > Date.now()) {
      employee = cached.employee;
    } else {
      const result = await pool.query<EmployeeRow>(
        `SELECT ${EMPLOYEE_SELECT} ${EMPLOYEE_FROM} WHERE e.id = $1`, [id]);
      const row = result.rows[0];
      if (!row) throw unauthorized('Sign in to continue.');
      if (!row.is_active) throw unauthorized('Your account is not active. Please contact your administrator.');
      employee = toProfile(row);
      authCache.set(id, { employee, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
    }

    // A team member has no personal sign-in: they work through their team account.
    if (employee.accountType === 'SHARED_TEAM') throw unauthorized('Team members sign in through their team account.');

    req.employee = employee;
    return actorStore.run({ actorEmployeeId: employee.id, accountId: null }, () => next());
  } catch (err) {
    next(err instanceof AppError ? err : unauthorized('Your session has expired. Please sign in again.'));
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

export const TEAM_LABELS = TEAM_LABEL;

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
    if (!canEditTrfPartA(req.employee) && !canEditTrfPartB(req.employee)) return next(forbidden());
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
 * Approvals, rejections and reopenings are made by named individuals, not shared
 * team accounts. In this system GM and AGM are designations carried by Admin
 * users (see migration 017), so every Admin may decide either track and may
 * unlock a TRF. The track is read from the request body so the same middleware
 * serves both the decision and unlock routes: the unlock route carries no track,
 * so only an administrator passes.
 */
export function requireAdminApproval() {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.employee) return next(unauthorized('Sign in to continue.'));
    if (req.accountId) return next(forbidden('Team accounts cannot approve.'));
    if (req.employee.role === 'Admin') return next();
    next(forbidden('Only an authorized approver can take this action.'));
  };
}

/**
 * Anyone who may approve at least one track: Admin only (GM/AGM are designations on Admin).
 * Track-specific checks happen inside the route handler.
 */
export function requireAnyApprover() {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.employee) return next(unauthorized('Sign in to continue.'));
    if (req.accountId) return next(forbidden('Team accounts cannot approve.'));
    if (req.employee.role === 'Admin') return next();
    next(forbidden('Only an authorized approver can take this action.'));
  };
}

/**
 * Unlock and reopen: Admin only (GM/AGM are designations on Admin).
 */
export function requireLockAdmin() {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.employee) return next(unauthorized('Sign in to continue.'));
    if (req.accountId) return next(forbidden('Team accounts cannot approve.'));
    if (req.employee.role === 'Admin') return next();
    next(forbidden('Only an authorized approver can take this action.'));
  };
}

/**
 * Assigning ARD tests: requires assignments.manage permission (Admin, Manager).
 */
export function requireAssignmentsManage() {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.employee) return next(unauthorized('Sign in to continue.'));
    if (!roleHasPermission(req.employee.role, 'assignments.manage')) return next(forbidden());
    next();
  };
}

/**
 * Formulation approval: Admin only (GM/AGM are designations on Admin).
 */
export function requireFormulationApproval() {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.employee) return next(unauthorized('Sign in to continue.'));
    if (req.accountId) return next(forbidden('Team accounts cannot approve.'));
    if (req.employee.role === 'Admin') return next();
    next(forbidden('Only an authorized approver can take this action.'));
  };
}

/**
 * ARD approval: Admin only (GM/AGM are designations on Admin).
 */
export function requireArdApproval() {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.employee) return next(unauthorized('Sign in to continue.'));
    if (req.accountId) return next(forbidden('Team accounts cannot approve.'));
    if (req.employee.role === 'Admin') return next();
    next(forbidden('Only an authorized approver can take this action.'));
  };
}
