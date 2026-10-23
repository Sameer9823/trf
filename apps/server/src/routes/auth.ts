import { Router } from 'express';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { AuthTokens, EmployeeProfile, permissionsForRole, MeResponse, SelectMemberRequest, SelectMemberResponse, VerifyPinRequest, VerifyPinResponse } from '@trf/shared';
import { MESSAGES } from '@trf/shared';
import { config } from '../config';
import { pool, withTransaction } from '../db';
import { AppError, unauthorized, badRequest, forbidden, notFound } from '../lib/errors';
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

const selectMemberSchema = z.object({
  employeeId: z.number().int().positive(),
  pin: z.string().optional(),
});

const verifyPinSchema = z.object({
  employeeId: z.number().int().positive(),
  pin: z.string().min(4, 'PIN must be at least 4 digits.').max(6, 'PIN must be at most 6 digits.').regex(/^\d+$/, 'PIN must be numeric.'),
});

async function loadEmployeeByLogin(login: string): Promise<EmployeeRow | undefined> {
  const result = await pool.query<EmployeeRow>(
    `SELECT ${EMPLOYEE_SELECT} ${EMPLOYEE_FROM}
     WHERE lower(e.username) = lower($1) OR lower(e.email) = lower($1) LIMIT 1`,
    [login],
  );
  return result.rows[0];
}

async function loadTeamAccountByLogin(login: string): Promise<{ id: number; team: string; username: string; password_hash: string; email: string; is_active: boolean; must_change_password: boolean } | undefined> {
  const result = await pool.query<{ id: number; team: string; username: string; password_hash: string; email: string; is_active: boolean; must_change_password: boolean }>(
    `SELECT id, team, username, password_hash, email, is_active, must_change_password FROM team_accounts WHERE lower(username) = lower($1) OR lower(email) = lower($1) LIMIT 1`,
    [login],
  );
  return result.rows[0];
}

async function issueTokens(employee: EmployeeProfile, userAgent: string | undefined, client: PoolClient, actingEmployeeId: number | null = null, accountId: number | null = null): Promise<AuthTokens> {
  const jti = randomToken(12);
  const { token: accessToken, expiresAt } = signAccessToken(
    { sub: String(employee.id), role: employee.role, employeeCode: employee.employeeCode, actingEmployeeId, accountId },
    jti,
  );
  const refreshToken = randomToken();
  await client.query(
    `INSERT INTO refresh_tokens (employee_id, token_hash, expires_at, user_agent) VALUES ($1, $2, $3, $4)`,
    [employee.id, hashToken(refreshToken), refreshTokenExpiry(), userAgent?.slice(0, 300) ?? null],
  );
  return { accessToken, refreshToken, accessTokenExpiresAt: expiresAt, employee, actingEmployeeId, accountId };
}

async function getSystemSetting(key: string): Promise<string> {
  const result = await pool.query<{ value: string }>(`SELECT value FROM system_settings WHERE key = $1`, [key]);
  return result.rows[0]?.value ?? '';
}

authRouter.post('/login', validateBody(loginSchema), async (req, res, next) => {
  try {
    const { username, password } = req.body as z.infer<typeof loginSchema>;

    // Try loading as individual employee first
    const employeeRow = await loadEmployeeByLogin(username);

    // One generic message for unknown user, wrong password and wrong role alike,
    // so the form never reveals which employee accounts exist.
    const fail = async (message: string, status = 401) => {
      throw new AppError(status, message === MESSAGES.ACCOUNT_LOCKED ? 'ACCOUNT_LOCKED' : 'UNAUTHORIZED', message);
    };

    if (employeeRow) {
      // Individual employee login
      if (!employeeRow.is_active) throw unauthorized(MESSAGES.INVALID_CREDENTIALS);
      if (employeeRow.locked_until && new Date(employeeRow.locked_until) > new Date()) throw unauthorized(MESSAGES.ACCOUNT_LOCKED);

      const passwordOk = await verifyPassword(employeeRow.password_hash, password);
      if (!passwordOk) {
        await withTransaction(async (client) => {
          const attempts = employeeRow.failed_login_count + 1;
          if (attempts >= config.LOGIN_MAX_ATTEMPTS) {
            await client.query(
              `UPDATE employees SET failed_login_count = 0, locked_until = now() + ($2 || ' minutes')::interval WHERE id = $1`,
              [employeeRow.id, String(config.LOGIN_LOCK_MINUTES)],
            );
            await writeAudit(client, {
              userId: employeeRow.id, userName: employeeRow.full_name, action: 'auth.login_locked', module: 'auth',
              recordType: 'Employee', recordRef: employeeRow.employee_code,
              newValue: { lockedUntilMinutes: config.LOGIN_LOCK_MINUTES },
            });
          } else {
            await client.query('UPDATE employees SET failed_login_count = $2 WHERE id = $1', [employeeRow.id, attempts]);
            await writeAudit(client, {
              userId: employeeRow.id, userName: employeeRow.full_name, action: 'auth.login_failed', module: 'auth',
              recordType: 'Employee', recordRef: employeeRow.employee_code, newValue: { failedAttempts: attempts },
            });
          }
        });
        invalidateEmployeeCache(employeeRow.id);
        throw unauthorized(MESSAGES.INVALID_CREDENTIALS);
      }

      const tokens = await withTransaction(async (client) => {
        await client.query(
          `UPDATE employees SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`,
          [employeeRow.id],
        );
        await writeAudit(client, {
          userId: employeeRow.id, userName: employeeRow.full_name, action: 'auth.login', module: 'auth',
          recordType: 'Employee', recordRef: employeeRow.employee_code,
        });
        return issueTokens(toProfile(employeeRow), req.headers['user-agent'], client);
      });
      invalidateEmployeeCache(employeeRow.id);
      res.json(tokens);
      return;
    }

    // Try loading as team account
    const teamAccount = await loadTeamAccountByLogin(username);
    if (!teamAccount) throw unauthorized(MESSAGES.INVALID_CREDENTIALS);
    if (!teamAccount.is_active) throw unauthorized(MESSAGES.INVALID_CREDENTIALS);

    const passwordOk = await verifyPassword(teamAccount.password_hash, password);
    if (!passwordOk) {
      // Team account login failure - generic message
      throw unauthorized(MESSAGES.INVALID_CREDENTIALS);
    }

    // Team account login successful - return tokens with accountId but no actingEmployeeId yet
    // The client must then call /auth/select-member to choose a team member
    const tokens = await withTransaction(async (client) => {
      // Create a minimal profile for the team account (for token purposes)
      const teamProfile: EmployeeProfile = {
        id: teamAccount.id,
        employeeCode: teamAccount.username,
        fullName: teamAccount.team === 'FRD' ? 'Formulation Team' : 'Analytical Team',
        designation: null,
        email: teamAccount.email,
        username: teamAccount.username,
        role: 'Analyst',
        departmentId: null,
        departmentName: teamAccount.team,
        isActive: teamAccount.is_active,
        mustChangePassword: teamAccount.must_change_password,
        lastLoginAt: new Date().toISOString(),
        version: 1,
        createdAt: new Date().toISOString(),
        accountType: 'SHARED_TEAM',
        team: teamAccount.team as 'FRD' | 'ARD',
        pinFailedAttempts: 0,
        pinLockedUntil: null,
      };
      await writeAudit(client, {
        userId: teamAccount.id, userName: teamAccount.username, action: 'auth.team_login', module: 'auth',
        recordType: 'TeamAccount', recordRef: teamAccount.username,
      });
      return issueTokens(teamProfile, req.headers['user-agent'], client, null, teamAccount.id);
    });
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
      // Preserve actingEmployeeId and accountId from the old token
      const authHeader = req.headers.authorization;
      let actingEmployeeId: number | null = null;
      let accountId: number | null = null;
      if (authHeader?.startsWith('Bearer ')) {
        try {
          const { verifyAccessToken } = await import('../lib/tokens');
          const payload = verifyAccessToken(authHeader.slice(7).trim());
          actingEmployeeId = (payload as any).actingEmployeeId ?? null;
          accountId = (payload as any).accountId ?? null;
        } catch {
          // Ignore
        }
      }
      return issueTokens(toProfile(employee), req.headers['user-agent'], client, actingEmployeeId, accountId);
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
    // Include actingEmployeeId and accountId from the token payload
    const authHeader = req.headers.authorization;
    let actingEmployeeId: number | null = null;
    let accountId: number | null = null;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const { verifyAccessToken } = await import('../lib/tokens');
        const payload = verifyAccessToken(authHeader.slice(7).trim());
        actingEmployeeId = (payload as any).actingEmployeeId ?? null;
        accountId = (payload as any).accountId ?? null;
      } catch {
        // Ignore token parse errors
      }
    }
    res.json({ ...me, permissions: permissionsForRole(me.role), actingEmployeeId, accountId });
  } catch (err) {
    next(err);
  }
});

/**
 * Select a team member after shared team account login.
 * This endpoint validates the member belongs to the team and verifies PIN if required.
 */
authRouter.post('/select-member', authenticate, validateBody(selectMemberSchema), async (req, res, next) => {
  try {
    const me = currentEmployee(req);
    const { employeeId, pin } = req.body as z.infer<typeof selectMemberSchema>;

    // Only shared team accounts can select members
    if (me.accountType !== 'SHARED_TEAM') {
      throw forbidden('This action is only available for shared team accounts.');
    }

    // Verify the team account ID from the token
    const authHeader = req.headers.authorization;
    let accountId: number | null = null;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const { verifyAccessToken } = await import('../lib/tokens');
        const payload = verifyAccessToken(authHeader.slice(7).trim());
        accountId = (payload as any).accountId ?? null;
      } catch {
        throw unauthorized('Invalid session.');
      }
    }
    if (!accountId) throw unauthorized('No team account in session.');

    // Load the team account to get the team
    const teamAccountResult = await pool.query<{ id: number; team: string }>(
      `SELECT id, team FROM team_accounts WHERE id = $1`,
      [accountId]
    );
    const teamAccount = teamAccountResult.rows[0];
    if (!teamAccount) throw unauthorized('Team account not found.');

    // Load the selected member
    const memberResult = await pool.query<EmployeeRow>(
      `SELECT ${EMPLOYEE_SELECT} ${EMPLOYEE_FROM} WHERE e.id = $1`,
      [employeeId]
    );
    const member = memberResult.rows[0];
    if (!member) throw notFound('Team member not found.');
    if (!member.is_active) throw forbidden(MESSAGES.MEMBER_INACTIVE);
    if (member.team !== teamAccount.team) throw forbidden(MESSAGES.MEMBER_WRONG_TEAM);
    if (member.account_type !== 'SHARED_TEAM') throw forbidden('This employee is not a team member.');

    // Check PIN if required
    const requirePin = (await getSystemSetting('REQUIRE_MEMBER_PIN')) === 'true';
    if (requirePin) {
      if (!pin) throw badRequest(MESSAGES.PIN_REQUIRED);
      if (!member.pin_hash) throw forbidden('This team member has no PIN set. Please contact your administrator.');

      // Check PIN lockout
      if (member.pin_locked_until && new Date(member.pin_locked_until) > new Date()) {
        throw forbidden(MESSAGES.PIN_LOCKED);
      }

      const pinOk = await verifyPassword(member.pin_hash, pin);
      if (!pinOk) {
        // Increment failed attempts
        const maxAttempts = parseInt(await getSystemSetting('PIN_MAX_ATTEMPTS'), 10) || 5;
        const lockMinutes = parseInt(await getSystemSetting('PIN_LOCK_MINUTES'), 10) || 15;
        const newAttempts = member.pin_failed_attempts + 1;

        await withTransaction(async (client) => {
          if (newAttempts >= maxAttempts) {
            await client.query(
              `UPDATE employees SET pin_failed_attempts = 0, pin_locked_until = now() + ($2 || ' minutes')::interval WHERE id = $1`,
              [member.id, String(lockMinutes)]
            );
            await writeAudit(client, {
              userId: member.id, userName: member.full_name, action: 'team.pin_locked', module: 'team',
              recordType: 'Employee', recordRef: member.employee_code,
              newValue: { lockedUntilMinutes: lockMinutes, accountId },
            });
          } else {
            await client.query('UPDATE employees SET pin_failed_attempts = $2 WHERE id = $1', [member.id, newAttempts]);
            await writeAudit(client, {
              userId: member.id, userName: member.full_name, action: 'team.pin_failed', module: 'team',
              recordType: 'Employee', recordRef: member.employee_code,
              newValue: { failedAttempts: newAttempts, accountId },
            });
          }
        });
        invalidateEmployeeCache(member.id);
        throw forbidden(MESSAGES.INVALID_PIN);
      }

      // PIN correct - reset failed attempts
      await withTransaction(async (client) => {
        await client.query('UPDATE employees SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = $1', [member.id]);
      });
      invalidateEmployeeCache(member.id);
    }

    // Member selected successfully - issue new tokens with actingEmployeeId
    const tokens = await withTransaction(async (client) => {
      await writeAudit(client, {
        userId: member.id, userName: member.full_name, action: 'team.member_selected', module: 'team',
        recordType: 'Employee', recordRef: member.employee_code,
        newValue: { team: member.team, accountId },
      });
      return issueTokens(toProfile(member), req.headers['user-agent'], client, member.id, accountId);
    });

    res.json({ ok: true, actingEmployee: toProfile(member), tokens });
  } catch (err) {
    next(err);
  }
});

/*** Verify PIN for a team member (used when switching users).
 */
authRouter.post('/verify-pin', authenticate, validateBody(verifyPinSchema), async (req, res, next) => {
  try {
    const me = currentEmployee(req);
    const { employeeId, pin } = req.body as z.infer<typeof verifyPinSchema>;

    // Only shared team accounts can verify PINs
    if (me.accountType !== 'SHARED_TEAM') {
      throw forbidden('This action is only available for shared team accounts.');
    }

    // Load the member
    const memberResult = await pool.query<EmployeeRow>(
      `SELECT ${EMPLOYEE_SELECT} ${EMPLOYEE_FROM} WHERE e.id = $1`,
      [employeeId]
    );
    const member = memberResult.rows[0];
    if (!member) throw notFound('Team member not found.');
    if (!member.is_active) throw forbidden(MESSAGES.MEMBER_INACTIVE);
    if (member.team !== me.team) throw forbidden(MESSAGES.MEMBER_WRONG_TEAM);
    if (member.account_type !== 'SHARED_TEAM') throw forbidden('This employee is not a team member.');

    if (!member.pin_hash) throw forbidden('This team member has no PIN set.');

    // Check PIN lockout
    if (member.pin_locked_until && new Date(member.pin_locked_until) > new Date()) {
      throw forbidden(MESSAGES.PIN_LOCKED);
    }

    const pinOk = await verifyPassword(member.pin_hash, pin);
    if (!pinOk) {
      const maxAttempts = parseInt(await getSystemSetting('PIN_MAX_ATTEMPTS'), 10) || 5;
      const lockMinutes = parseInt(await getSystemSetting('PIN_LOCK_MINUTES'), 10) || 15;
      const newAttempts = member.pin_failed_attempts + 1;

      await withTransaction(async (client) => {
        if (newAttempts >= maxAttempts) {
          await client.query(
            `UPDATE employees SET pin_failed_attempts = 0, pin_locked_until = now() + ($2 || ' minutes')::interval WHERE id = $1`,
            [member.id, String(lockMinutes)]
          );
          await writeAudit(client, {
            userId: member.id, userName: member.full_name, action: 'team.pin_locked', module: 'team',
            recordType: 'Employee', recordRef: member.employee_code,
            newValue: { lockedUntilMinutes: lockMinutes },
          });
        } else {
          await client.query('UPDATE employees SET pin_failed_attempts = $2 WHERE id = $1', [member.id, newAttempts]);
          await writeAudit(client, {
            userId: member.id, userName: member.full_name, action: 'team.pin_failed', module: 'team',
            recordType: 'Employee', recordRef: member.employee_code,
            newValue: { failedAttempts: newAttempts },
          });
        }
      });
      invalidateEmployeeCache(member.id);
      const response: VerifyPinResponse = { ok: false, message: MESSAGES.INVALID_PIN, lockedUntil: member.pin_locked_until?.toISOString() ?? null, failedAttempts: newAttempts };
      res.json(response);
      return;
    }

    // PIN correct - reset failed attempts
    await withTransaction(async (client) => {
      await client.query('UPDATE employees SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = $1', [member.id]);
    });
    invalidateEmployeeCache(member.id);

    const response: VerifyPinResponse = { ok: true };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

/*** Switch user - returns to member selection screen (clears actingEmployeeId).
 */
authRouter.post('/switch-user', authenticate, async (req, res, next) => {
  try {
    const me = currentEmployee(req);

    // Only shared team accounts can switch users
    if (me.accountType !== 'SHARED_TEAM') {
      throw forbidden('This action is only available for shared team accounts.');
    }

    // Get the current acting employee ID from token
    const authHeader = req.headers.authorization;
    let actingEmployeeId: number | null = null;
    let accountId: number | null = null;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const { verifyAccessToken } = await import('../lib/tokens');
        const payload = verifyAccessToken(authHeader.slice(7).trim());
        actingEmployeeId = (payload as any).actingEmployeeId ?? null;
        accountId = (payload as any).accountId ?? null;
      } catch {
        throw unauthorized('Invalid session.');
      }
    }

    // Audit the switch for the previous acting employee
    if (actingEmployeeId) {
      const prevMemberResult = await pool.query<EmployeeRow>(
        `SELECT ${EMPLOYEE_SELECT} ${EMPLOYEE_FROM} WHERE e.id = $1`,
        [actingEmployeeId]
      );
      const prevMember = prevMemberResult.rows[0];
      if (prevMember) {
        await withTransaction(async (client) => {
          await writeAudit(client, {
            userId: prevMember.id, userName: prevMember.full_name, action: 'team.member_signed_out', module: 'team',
            recordType: 'Employee', recordRef: prevMember.employee_code,
            newValue: { accountId },
          });
        });
      }
    }

    // Return new tokens with same accountId but no actingEmployeeId
    const tokens = await withTransaction(async (client) => {
      // Re-issue tokens for the team account profile
      const teamAccountResult = await pool.query<{ id: number; team: string; username: string; email: string; is_active: boolean; must_change_password: boolean }>(
        `SELECT id, team, username, email, is_active, must_change_password FROM team_accounts WHERE id = $1`,
        [accountId]
      );
      const teamAccount = teamAccountResult.rows[0];
      if (!teamAccount) throw unauthorized('Team account not found.');

      const teamProfile: EmployeeProfile = {
        id: teamAccount.id,
        employeeCode: teamAccount.username,
        fullName: teamAccount.team === 'FRD' ? 'Formulation Team' : 'Analytical Team',
        designation: null,
        email: teamAccount.email,
        username: teamAccount.username,
        role: 'Analyst',
        departmentId: null,
        departmentName: teamAccount.team,
        isActive: teamAccount.is_active,
        mustChangePassword: teamAccount.must_change_password,
        lastLoginAt: new Date().toISOString(),
        version: 1,
        createdAt: new Date().toISOString(),
        accountType: 'SHARED_TEAM',
        team: teamAccount.team as 'FRD' | 'ARD',
        pinFailedAttempts: 0,
        pinLockedUntil: null,
      };
      return issueTokens(teamProfile, req.headers['user-agent'], client, null, accountId);
    });

    res.json({ ok: true, tokens });
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
