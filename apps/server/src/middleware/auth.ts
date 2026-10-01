import { NextFunction, Request, Response } from 'express';
import { ZodSchema } from 'zod';
import { Role, permissionsForRole, roleHasPermission, Permission, EmployeeProfile } from '@trf/shared';
import { AppError, badRequest, forbidden, notFound, unauthorized } from '../lib/errors';
import { verifyAccessToken } from '../lib/tokens';
import { pool } from '../db';
import { EMPLOYEE_FROM, EMPLOYEE_SELECT, EmployeeRow, toProfile } from '../lib/employees';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      employee?: EmployeeProfile;
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
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized('Sign in to continue.');

    const payload = verifyAccessToken(header.slice(7).trim());
    const id = Number(payload.sub);

    const cached = authCache.get(id);
    if (cached && cached.expiresAt > Date.now()) {
      req.employee = cached.employee;
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
    next();
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

export function employeePermissions(role: Role) {
  return permissionsForRole(role);
}
