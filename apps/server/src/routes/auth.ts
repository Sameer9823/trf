import { Router } from 'express';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { AuthTokens, EmployeeProfile, permissionsForRole } from '@trf/shared';
import { MESSAGES } from '@trf/shared';
import { config } from '../config';
import { pool, withTransaction } from '../db';
import { AppError, unauthorized, badRequest } from '../lib/errors';
import { EMPLOYEE_FROM, EMPLOYEE_SELECT, EmployeeRow, toProfile } from '../lib/employees';
import { hashPassword, hashToken, randomToken, verifyPassword } from '../lib/password';
import { refreshTokenExpiry, signAccessToken } from '../lib/tokens';
import { writeAudit } from '../lib/audit';
import { authenticate, currentEmployee, invalidateEmployeeCache, validateBody } from '../middleware/auth';

export const authRouter = Router();

const loginSchema = z.object({
  username: z.string().trim().min(1, 'Enter your username or email.'),
  password: z.string().min(1, 'Enter your password.'),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password.'),
  newPassword: z.string()
    .min(10, 'The new password must be at least 10 characters.')
    .regex(/[A-Za-z]/, 'The new password must contain a letter.')
    .regex(/[0-9]/, 'The new password must contain a number.'),
});

async function loadEmployeeByLogin(login: string): Promise<EmployeeRow | undefined> {
  const result = await pool.query<EmployeeRow>(
    `SELECT ${EMPLOYEE_SELECT} ${EMPLOYEE_FROM}
     WHERE lower(e.username) = lower($1) OR lower(e.email) = lower($1) LIMIT 1`,
    [login],
  );
  return result.rows[0];
}

async function issueTokens(employee: EmployeeProfile, userAgent: string | undefined, client: PoolClient): Promise<AuthTokens> {
  const jti = randomToken(12);
  const { token: accessToken, expiresAt } = signAccessToken(
    { sub: String(employee.id), role: employee.role, employeeCode: employee.employeeCode },
    jti,
  );
  const refreshToken = randomToken();
  await client.query(
    `INSERT INTO refresh_tokens (employee_id, token_hash, expires_at, user_agent) VALUES ($1, $2, $3, $4)`,
    [employee.id, hashToken(refreshToken), refreshTokenExpiry(), userAgent?.slice(0, 300) ?? null],
  );
  return { accessToken, refreshToken, accessTokenExpiresAt: expiresAt, employee };
}

authRouter.post('/login', validateBody(loginSchema), async (req, res, next) => {
  try {
    const { username, password } = req.body as z.infer<typeof loginSchema>;
    const row = await loadEmployeeByLogin(username);

    // One generic message for unknown user, wrong password and wrong role alike,
    // so the form never reveals which employee accounts exist.
    const fail = async (message: string, status = 401) => {
      throw new AppError(status, message === MESSAGES.ACCOUNT_LOCKED ? 'ACCOUNT_LOCKED' : 'UNAUTHORIZED', message);
    };

    if (!row) throw unauthorized(MESSAGES.INVALID_CREDENTIALS);
    if (!row.is_active) throw unauthorized(MESSAGES.INVALID_CREDENTIALS);
    if (row.locked_until && new Date(row.locked_until) > new Date()) throw unauthorized(MESSAGES.ACCOUNT_LOCKED);

    const passwordOk = await verifyPassword(row.password_hash, password);
    if (!passwordOk) {
      // Count the failure in its own transaction: the audit row and the counter
      // must survive even though no login tokens are issued.
      await withTransaction(async (client) => {
        const attempts = row.failed_login_count + 1;
        if (attempts >= config.LOGIN_MAX_ATTEMPTS) {
          await client.query(
            `UPDATE employees SET failed_login_count = 0, locked_until = now() + ($2 || ' minutes')::interval WHERE id = $1`,
            [row.id, String(config.LOGIN_LOCK_MINUTES)],
          );
          await writeAudit(client, {
            userId: row.id, userName: row.full_name, action: 'auth.login_locked', module: 'auth',
            recordType: 'Employee', recordRef: row.employee_code,
            newValue: { lockedUntilMinutes: config.LOGIN_LOCK_MINUTES },
          });
        } else {
          await client.query('UPDATE employees SET failed_login_count = $2 WHERE id = $1', [row.id, attempts]);
          await writeAudit(client, {
            userId: row.id, userName: row.full_name, action: 'auth.login_failed', module: 'auth',
            recordType: 'Employee', recordRef: row.employee_code, newValue: { failedAttempts: attempts },
          });
        }
      });
      invalidateEmployeeCache(row.id);
      throw unauthorized(MESSAGES.INVALID_CREDENTIALS);
    }

    const tokens = await withTransaction(async (client) => {
      await client.query(
        `UPDATE employees SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`,
        [row.id],
      );
      await writeAudit(client, {
        userId: row.id, userName: row.full_name, action: 'auth.login', module: 'auth',
        recordType: 'Employee', recordRef: row.employee_code,
      });
      return issueTokens(toProfile(row), req.headers['user-agent'], client);
    });
    invalidateEmployeeCache(row.id);
    res.json(tokens);
  } catch (err) {
    next(err);
  }
});

authRouter.post('/refresh', async (req, res, next) => {
  try {
    const presented = (req.body as { refreshToken?: string })?.refreshToken;
    if (typeof presented !== 'string' || !presented) throw unauthorized('Sign in to continue.');

    const result = await pool.query<{ id: number; employee_id: number; expires_at: Date; revoked_at: Date | null }>(
      `SELECT id, employee_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1`,
      [hashToken(presented)],
    );
    const stored = result.rows[0];
    if (!stored || stored.revoked_at || new Date(stored.expires_at) < new Date()) {
      throw unauthorized('Your session has expired. Please sign in again.');
    }

    const employeeResult = await pool.query<EmployeeRow>(
      `SELECT ${EMPLOYEE_SELECT} ${EMPLOYEE_FROM} WHERE e.id = $1`, [stored.employee_id]);
    const employee = employeeResult.rows[0];
    if (!employee || !employee.is_active) throw unauthorized(MESSAGES.INVALID_CREDENTIALS);

    // Rotate: the presented token is revoked as the new pair is issued.
    const tokens = await withTransaction(async (client) => {
      await client.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [stored.id]);
      return issueTokens(toProfile(employee), req.headers['user-agent'], client);
    });
    res.json(tokens);
  } catch (err) {
    next(err instanceof AppError ? err : unauthorized('Your session has expired. Please sign in again.'));
  }
});

authRouter.post('/logout', async (req, res, next) => {
  try {
    const presented = (req.body as { refreshToken?: string })?.refreshToken;
    if (typeof presented === 'string' && presented) {
      // The employee is read from the token before it is revoked, because after the
      // update there is nothing left to identify the sign-out by.
      await withTransaction(async (client) => {
        const digest = hashToken(presented);
        const owner = await client.query<{ id: number; full_name: string; employee_code: string }>(
          `SELECT e.id, e.full_name, e.employee_code
           FROM refresh_tokens rt JOIN employees e ON e.id = rt.employee_id
           WHERE rt.token_hash = $1 AND rt.revoked_at IS NULL`,
          [digest],
        );
        await client.query(
          'UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [digest]);

        const who = owner.rows[0];
        if (who) {
          await writeAudit(client, {
            userId: who.id, userName: who.full_name, action: 'auth.logout', module: 'auth',
            recordType: 'Employee', recordRef: who.employee_code,
          });
        }
      });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

authRouter.get('/me', authenticate, async (req, res, next) => {
  try {
    const me = currentEmployee(req);
    // The permission list lets the desktop hide what this role cannot do. The
    // server still checks every request.
    res.json({ ...me, permissions: permissionsForRole(me.role) });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/change-password', authenticate, validateBody(changePasswordSchema), async (req, res, next) => {
  try {
    const me = currentEmployee(req);
    const { currentPassword, newPassword } = req.body as z.infer<typeof changePasswordSchema>;

    const result = await pool.query<EmployeeRow>(`SELECT ${EMPLOYEE_SELECT} ${EMPLOYEE_FROM} WHERE e.id = $1`, [me.id]);
    const row = result.rows[0];
    if (!row) throw unauthorized('Sign in to continue.');
    if (!(await verifyPassword(row.password_hash, currentPassword))) {
      throw badRequest('Your current password is not correct.', { currentPassword: 'Your current password is not correct.' });
    }
    if (await verifyPassword(row.password_hash, newPassword)) {
      throw badRequest('The new password must be different from the current password.', { newPassword: 'Choose a password you have not used before.' });
    }

    const passwordHash = await hashPassword(newPassword);
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE employees SET password_hash = $2, must_change_password = FALSE,
         failed_login_count = 0, locked_until = NULL, version = version + 1 WHERE id = $1`,
        [me.id, passwordHash],
      );
      // Every existing session is revoked: a password change ends other sessions.
      await client.query('UPDATE refresh_tokens SET revoked_at = now() WHERE employee_id = $1 AND revoked_at IS NULL', [me.id]);
      await writeAudit(client, {
        userId: me.id, userName: row.full_name, action: 'auth.password_changed', module: 'auth',
        recordType: 'Employee', recordRef: row.employee_code, newValue: { changedBy: 'self' },
      });
    });
    invalidateEmployeeCache(me.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export const loginValidators = { loginSchema, changePasswordSchema };
export type LoginInput = z.infer<typeof loginSchema>;
