import { Router } from 'express';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { AuthTokens, EmployeeProfile, permissionsForRole } from '@trf/shared';
import { MESSAGES } from '@trf/shared';
import { config } from '../config';
import { pool, withTransaction } from '../db';
import { AppError, unauthorized, badRequest, forbidden, notFound } from '../lib/errors';
import { EMPLOYEE_FROM, EMPLOYEE_SELECT, EmployeeRow, toProfile } from '../lib/employees';
import { hashPassword, hashToken, randomToken, verifyPassword } from '../lib/password';
import { refreshTokenExpiry, signAccessToken } from '../lib/tokens';
import { writeAudit } from '../lib/audit';
import { authenticate, currentEmployee, invalidateEmployeeCache, validateBody } from '../middleware/auth';
import { TEAM_LABEL, TeamAccountRow, loadTeamAccount, loadTeamAccountByLogin, teamPseudoProfile } from '../lib/team-accounts';
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

async function loadEmployeeByLogin(login: string): Promise<EmployeeRow | undefined> {
  const result = await pool.query<EmployeeRow>(
    `SELECT ${EMPLOYEE_SELECT} ${EMPLOYEE_FROM}
     WHERE lower(e.username) = lower($1) OR lower(e.email) = lower($1) LIMIT 1`,
    [login],
  );
  return result.rows[0];
}


async function issueEmployeeTokens(employee: EmployeeProfile, userAgent: string | undefined, client: PoolClient): Promise<AuthTokens> {
  const jti = randomToken(12);
  const { token: accessToken, expiresAt } = signAccessToken(
    { sub: String(employee.id), role: employee.role, employeeCode: employee.employeeCode, actingEmployeeId: null, accountId: null },
    jti,
  );
  const refreshToken = randomToken();
  await client.query(
    `INSERT INTO refresh_tokens (employee_id, token_hash, expires_at, user_agent) VALUES ($1, $2, $3, $4)`,
    [employee.id, hashToken(refreshToken), refreshTokenExpiry(), userAgent?.slice(0, 300) ?? null],
  );
  return { accessToken, refreshToken, accessTokenExpiresAt: expiresAt, employee, actingEmployeeId: null, accountId: null };
}

/**
 * Tokens for a shared team login. The token names the team account, not an
 * employee; `acting` is the member who has chosen their name and entered their
 * PIN, or null while the screen is still waiting for that.
 */
async function issueTeamTokens(account: TeamAccountRow, acting: EmployeeProfile | null, userAgent: string | undefined, client: PoolClient): Promise<AuthTokens> {
  const jti = randomToken(12);
  const { token: accessToken, expiresAt } = signAccessToken(
    {
      kind: 'team', sub: String(account.id), role: acting?.role ?? 'Viewer',
      employeeCode: acting?.employeeCode ?? account.username, actingEmployeeId: acting?.id ?? null, accountId: account.id,
    },
    jti,
  );
  const refreshToken = randomToken();
  await client.query(
    `INSERT INTO refresh_tokens (team_account_id, acting_employee_id, token_hash, expires_at, user_agent) VALUES ($1, $2, $3, $4, $5)`,
    [account.id, acting?.id ?? null, hashToken(refreshToken), refreshTokenExpiry(), userAgent?.slice(0, 300) ?? null],
  );
  return {
    accessToken, refreshToken, accessTokenExpiresAt: expiresAt,
    employee: acting ?? teamPseudoProfile(account), actingEmployeeId: acting?.id ?? null, accountId: account.id,
  };
}

async function getSystemSetting(key: string): Promise<string> {
  const result = await pool.query<{ value: string }>(`SELECT value FROM system_settings WHERE key = $1`, [key]);
  return result.rows[0]?.value ?? '';
}

/** A team member who may still act: active, in this team, and never an administrator. */
function memberUsable(member: EmployeeRow | undefined, account: TeamAccountRow): member is EmployeeRow {
  return !!member && member.is_active && member.account_type === 'SHARED_TEAM'
    && member.role !== 'Admin' && member.team === account.team;
}

authRouter.post('/login', validateBody(loginSchema), async (req, res, next) => {
  try {
    const { username, password } = req.body as z.infer<typeof loginSchema>;

    const employeeRow = await loadEmployeeByLogin(username);

    if (employeeRow) {
      // One generic message for unknown user, wrong password, inactive account and a team
      // member's own name alike, so the form never reveals which accounts exist. A team
      // member has no personal sign-in: they use their team account and their PIN.
      if (!employeeRow.is_active || employeeRow.account_type === 'SHARED_TEAM') throw unauthorized(MESSAGES.INVALID_CREDENTIALS);
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
        return issueEmployeeTokens(toProfile(employeeRow), req.headers['user-agent'], client);
      });
      invalidateEmployeeCache(employeeRow.id);
      res.json(tokens);
      return;
    }

    // Not an employee: try the shared team accounts (one for FRD, one for ARD).
    const account = await loadTeamAccountByLogin(username);
    if (!account || !account.is_active || !account.password_hash) throw unauthorized(MESSAGES.INVALID_CREDENTIALS);
    if (account.locked_until && new Date(account.locked_until) > new Date()) throw unauthorized(MESSAGES.ACCOUNT_LOCKED);

    const passwordOk = await verifyPassword(account.password_hash, password);
    if (!passwordOk) {
      await withTransaction(async (client) => {
        const attempts = account.failed_login_count + 1;
        if (attempts >= config.LOGIN_MAX_ATTEMPTS) {
          await client.query(
            `UPDATE team_accounts SET failed_login_count = 0, locked_until = now() + ($2 || ' minutes')::interval WHERE id = $1`,
            [account.id, String(config.LOGIN_LOCK_MINUTES)],
          );
          await writeAudit(client, {
            userName: TEAM_LABEL[account.team], action: 'auth.team_login_locked', module: 'auth',
            recordType: 'TeamAccount', recordRef: account.username, accountId: account.id,
            newValue: { lockedUntilMinutes: config.LOGIN_LOCK_MINUTES },
          });
        } else {
          await client.query('UPDATE team_accounts SET failed_login_count = $2 WHERE id = $1', [account.id, attempts]);
          await writeAudit(client, {
            userName: TEAM_LABEL[account.team], action: 'auth.team_login_failed', module: 'auth',
            recordType: 'TeamAccount', recordRef: account.username, accountId: account.id,
            newValue: { failedAttempts: attempts },
          });
        }
      });
      throw unauthorized(MESSAGES.INVALID_CREDENTIALS);
    }

    const tokens = await withTransaction(async (client) => {
      await client.query('UPDATE team_accounts SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [account.id]);
      await writeAudit(client, {
        userName: TEAM_LABEL[account.team], action: 'auth.team_login', module: 'auth',
        recordType: 'TeamAccount', recordRef: account.username, accountId: account.id,
      });
      // No acting member yet: the person must choose their name and enter their PIN first.
      return issueTeamTokens(account, null, req.headers['user-agent'], client);
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

    const result = await pool.query<{
      id: number; employee_id: number | null; team_account_id: number | null; acting_employee_id: number | null;
      expires_at: Date; revoked_at: Date | null;
    }>(
      `SELECT id, employee_id, team_account_id, acting_employee_id, expires_at, revoked_at
         FROM refresh_tokens WHERE token_hash = $1`,
      [hashToken(presented)],
    );
    const stored = result.rows[0];
    if (!stored || stored.revoked_at || new Date(stored.expires_at) < new Date()) {
      throw unauthorized('Your session has expired. Please sign in again.');
    }

    if (stored.team_account_id) {
      const account = await loadTeamAccount(stored.team_account_id);
      if (!account || !account.is_active) throw unauthorized(MESSAGES.INVALID_CREDENTIALS);
      // The member who was acting stays acting through a refresh, unless they have been deactivated.
      let acting: EmployeeProfile | null = null;
      if (stored.acting_employee_id) {
        const memberResult = await pool.query<EmployeeRow>(
          `SELECT ${EMPLOYEE_SELECT} ${EMPLOYEE_FROM} WHERE e.id = $1`, [stored.acting_employee_id]);
        const member = memberResult.rows[0];
        if (memberUsable(member, account)) acting = toProfile(member);
      }
      const tokens = await withTransaction(async (client) => {
        await client.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [stored.id]);
        return issueTeamTokens(account, acting, req.headers['user-agent'], client);
      });
      res.json(tokens);
      return;
    }

    const employeeResult = await pool.query<EmployeeRow>(
      `SELECT ${EMPLOYEE_SELECT} ${EMPLOYEE_FROM} WHERE e.id = $1`, [stored.employee_id]);
    const employee = employeeResult.rows[0];
    if (!employee || !employee.is_active || employee.account_type === 'SHARED_TEAM') throw unauthorized(MESSAGES.INVALID_CREDENTIALS);

    // Rotate: the presented token is revoked as the new pair is issued.
    const tokens = await withTransaction(async (client) => {
      await client.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [stored.id]);
      return issueEmployeeTokens(toProfile(employee), req.headers['user-agent'], client);
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
      // Who signed out is read from the token before it is revoked, because after the
      // update there is nothing left to identify the sign-out by.
      await withTransaction(async (client) => {
        const digest = hashToken(presented);
        const owner = await client.query<{
          employee_id: number | null; team_account_id: number | null; acting_employee_id: number | null;
          full_name: string | null; employee_code: string | null; team: 'FRD' | 'ARD' | null; username: string | null;
        }>(
          `SELECT rt.employee_id, rt.team_account_id, rt.acting_employee_id,
                  e.full_name, e.employee_code, ta.team, ta.username
             FROM refresh_tokens rt
             LEFT JOIN employees e ON e.id = COALESCE(rt.acting_employee_id, rt.employee_id)
             LEFT JOIN team_accounts ta ON ta.id = rt.team_account_id
            WHERE rt.token_hash = $1 AND rt.revoked_at IS NULL`,
          [digest],
        );
        await client.query(
          'UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [digest]);

        const who = owner.rows[0];
        if (who) {
          await writeAudit(client, {
            userId: who.acting_employee_id ?? who.employee_id,
            userName: who.full_name ?? (who.team ? TEAM_LABEL[who.team] : null),
            action: 'auth.logout', module: 'auth',
            recordType: who.team_account_id ? 'TeamAccount' : 'Employee',
            recordRef: who.team_account_id ? who.username : who.employee_code,
            accountId: who.team_account_id,
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
    // The permission list lets the desktop hide what this role cannot do. The server
    // still checks every request. A team login that has not chosen a member holds none.
    const permissions = req.teamPending ? [] : permissionsForRole(me.role);
    res.json({ ...me, permissions, actingEmployeeId: req.actingEmployeeId ?? null, accountId: req.accountId ?? null });
  } catch (err) {
    next(err);
  }
});

/**
 * A member of the team chooses their name and enters their PIN. From then on every
 * request, and every audit row, is made as that person, with their own role.
 */
authRouter.post('/select-member', authenticate, validateBody(selectMemberSchema), async (req, res, next) => {
  try {
    if (!req.accountId) throw forbidden('This action is only available for team accounts.');
    const { employeeId, pin } = req.body as z.infer<typeof selectMemberSchema>;

    const account = await loadTeamAccount(req.accountId);
    if (!account || !account.is_active) throw unauthorized('Team account not found.');

    const memberResult = await pool.query<EmployeeRow>(
      `SELECT ${EMPLOYEE_SELECT} ${EMPLOYEE_FROM} WHERE e.id = $1`, [employeeId]);
    const member = memberResult.rows[0];
    if (!member) throw notFound('Team member not found.');
    if (!member.is_active) throw forbidden(MESSAGES.MEMBER_INACTIVE);
    if (!memberUsable(member, account)) throw forbidden(MESSAGES.MEMBER_WRONG_TEAM);

    const requirePin = (await getSystemSetting('REQUIRE_MEMBER_PIN')) !== 'false';
    if (requirePin) {
      if (!pin) throw badRequest(MESSAGES.PIN_REQUIRED, { pin: MESSAGES.PIN_REQUIRED });
      if (!member.pin_hash) throw forbidden('This team member has no PIN yet. Please ask your administrator to set one.');
      if (member.pin_locked_until && new Date(member.pin_locked_until) > new Date()) throw forbidden(MESSAGES.PIN_LOCKED);

      const pinOk = await verifyPassword(member.pin_hash, pin);
      if (!pinOk) {
        const maxAttempts = parseInt(await getSystemSetting('PIN_MAX_ATTEMPTS'), 10) || 5;
        const lockMinutes = parseInt(await getSystemSetting('PIN_LOCK_MINUTES'), 10) || 15;
        const attempts = member.pin_failed_attempts + 1;
        await withTransaction(async (client) => {
          if (attempts >= maxAttempts) {
            await client.query(
              `UPDATE employees SET pin_failed_attempts = 0, pin_locked_until = now() + ($2 || ' minutes')::interval WHERE id = $1`,
              [member.id, String(lockMinutes)]);
          } else {
            await client.query('UPDATE employees SET pin_failed_attempts = $2 WHERE id = $1', [member.id, attempts]);
          }
          await writeAudit(client, {
            userId: member.id, userName: member.full_name, accountId: account.id,
            action: attempts >= maxAttempts ? 'team.pin_locked' : 'team.pin_failed', module: 'team',
            recordType: 'Employee', recordRef: member.employee_code,
            newValue: attempts >= maxAttempts ? { lockedUntilMinutes: lockMinutes } : { failedAttempts: attempts },
          });
        });
        invalidateEmployeeCache(member.id);
        throw forbidden(MESSAGES.INVALID_PIN);
      }
    }

    const tokens = await withTransaction(async (client) => {
      await client.query('UPDATE employees SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = $1', [member.id]);
      await writeAudit(client, {
        userId: member.id, userName: member.full_name, accountId: account.id, action: 'team.member_selected', module: 'team',
        recordType: 'Employee', recordRef: member.employee_code, newValue: { team: account.team },
      });
      return issueTeamTokens(account, toProfile(member), req.headers['user-agent'], client);
    });
    invalidateEmployeeCache(member.id);

    // The tokens go to the desktop's main process only; they never reach the page.
    res.json({ ok: true, actingEmployee: toProfile(member), tokens });
  } catch (err) {
    next(err);
  }
});

/**
 * Hands the screen back to the name picker. Used by "Not me" and by the idle lock,
 * so a PC left unattended can never be used as the last person who signed in.
 */
authRouter.post('/switch-user', authenticate, async (req, res, next) => {
  try {
    if (!req.accountId) throw forbidden('This action is only available for team accounts.');
    const account = await loadTeamAccount(req.accountId);
    if (!account || !account.is_active) throw unauthorized('Team account not found.');
    const previousId = req.actingEmployeeId ?? null;
    const reason = (req.body as { reason?: string } | undefined)?.reason === 'idle' ? 'idle' : 'switch';

    const tokens = await withTransaction(async (client) => {
      if (previousId) {
        // The member's refresh tokens end here, so locking the screen cannot be undone without the PIN.
        await client.query(
          `UPDATE refresh_tokens SET revoked_at = now()
            WHERE team_account_id = $1 AND acting_employee_id = $2 AND revoked_at IS NULL`,
          [account.id, previousId]);
        const prev = await client.query<{ full_name: string; employee_code: string }>(
          'SELECT full_name, employee_code FROM employees WHERE id = $1', [previousId]);
        if (prev.rows[0]) {
          await writeAudit(client, {
            userId: previousId, userName: prev.rows[0].full_name, accountId: account.id,
            action: reason === 'idle' ? 'team.session_locked' : 'team.member_signed_out', module: 'team',
            recordType: 'Employee', recordRef: prev.rows[0].employee_code,
          });
        }
      }
      return issueTeamTokens(account, null, req.headers['user-agent'], client);
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
