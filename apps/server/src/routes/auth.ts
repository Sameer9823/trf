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
import { sendEmail } from '../lib/email';
import { generatePasswordResetEmail, generatePasswordChangedEmail } from '../lib/email-templates';

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

const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required.'),
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

// Forgot password - sends reset link to email
authRouter.post('/forgot-password', validateBody(forgotPasswordSchema), async (req, res, next) => {
  try {
    const { email } = req.body as z.infer<typeof forgotPasswordSchema>;
    
    // Always return success to prevent email enumeration
    const genericMessage = 'If an account with that email exists, a password reset link has been sent.';
    
    const result = await pool.query<EmployeeRow>(
      `SELECT ${EMPLOYEE_SELECT} ${EMPLOYEE_FROM} WHERE lower(e.email) = lower($1) AND e.is_active = TRUE LIMIT 1`,
      [email]
    );
    
    const row = result.rows[0];
    if (row) {
      const resetToken = randomToken(32);
      const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 hours
      
      await withTransaction(async (client) => {
        // Invalidate any existing unused tokens for this employee
        await client.query(
          `UPDATE password_reset_tokens SET used_at = now() WHERE employee_id = $1 AND used_at IS NULL`,
          [row.id]
        );
        
        // Create new reset token
        await client.query(
          `INSERT INTO password_reset_tokens (employee_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
          [row.id, hashToken(resetToken), expiresAt]
        );
        
        await writeAudit(client, {
          userId: row.id, userName: row.full_name, action: 'auth.password_reset_requested', module: 'auth',
          recordType: 'Employee', recordRef: row.employee_code,
        });
      });
      
      // Send reset email
      const frontendUrl = config.FRONTEND_URL ?? 'http://localhost:5173';
      const resetUrl = `${frontendUrl}/#/reset-password?token=${resetToken}`;
      const emailContent = generatePasswordResetEmail(row.full_name, resetUrl, 2);
      
      await sendEmail({
        to: row.email,
        subject: emailContent.subject,
        html: emailContent.html,
        text: emailContent.text,
      });
    }
    
    res.json({ ok: true, message: genericMessage });
  } catch (err) {
    next(err);
  }
});

// Reset password with token
authRouter.post('/reset-password', validateBody(resetPasswordSchema), async (req, res, next) => {
  try {
    const { token, newPassword } = req.body as z.infer<typeof resetPasswordSchema>;
    const tokenHash = hashToken(token);
    
    const result = await pool.query<{ id: number; employee_id: number; expires_at: Date; used_at: Date | null }>(
      `SELECT id, employee_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = $1`,
      [tokenHash]
    );
    
    const resetToken = result.rows[0];
    if (!resetToken) {
      throw badRequest('Invalid or expired reset token.');
    }
    
    if (resetToken.used_at) {
      throw badRequest('This reset token has already been used.');
    }
    
    if (new Date(resetToken.expires_at) < new Date()) {
      throw badRequest('This reset token has expired.');
    }
    
    // Get employee details
    const empResult = await pool.query<EmployeeRow>(
      `SELECT ${EMPLOYEE_SELECT} ${EMPLOYEE_FROM} WHERE e.id = $1`,
      [resetToken.employee_id]
    );
    
    const employee = empResult.rows[0];
    if (!employee) {
      throw badRequest('Invalid reset token.');
    }
    
    const passwordHash = await hashPassword(newPassword);
    
    await withTransaction(async (client) => {
      // Update password and mark token as used
      await client.query(
        `UPDATE employees SET password_hash = $2, must_change_password = FALSE, failed_login_count = 0, locked_until = NULL, version = version + 1 WHERE id = $1`,
        [employee.id, passwordHash]
      );
      
      await client.query(
        `UPDATE password_reset_tokens SET used_at = now() WHERE id = $1`,
        [resetToken.id]
      );
      
      // Revoke all refresh tokens
      await client.query('UPDATE refresh_tokens SET revoked_at = now() WHERE employee_id = $1 AND revoked_at IS NULL', [employee.id]);
      
      await writeAudit(client, {
        userId: employee.id, userName: employee.full_name, action: 'auth.password_reset', module: 'auth',
        recordType: 'Employee', recordRef: employee.employee_code, newValue: { changedBy: 'reset_token' },
      });
    });
    
    invalidateEmployeeCache(employee.id);
    
    // Send confirmation email
    const emailContent = generatePasswordChangedEmail(employee.full_name);
    await sendEmail({
      to: employee.email,
      subject: emailContent.subject,
      html: emailContent.html,
      text: emailContent.text,
    });
    
    res.json({ ok: true, message: 'Your password has been reset. Please sign in with your new password.' });
  } catch (err) {
    next(err);
  }
});

export const loginValidators = { loginSchema, changePasswordSchema, forgotPasswordSchema, resetPasswordSchema };
export type LoginInput = z.infer<typeof loginSchema>;
