import { Router } from 'express';
import { z } from 'zod';
import { TeamType } from '@trf/shared';
import { pool, withTransaction } from '../db';
import { badRequest, conflict, notFound } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { hashPassword } from '../lib/password';
import { TEAM_LABEL } from '../lib/team-accounts';
import { authenticate, currentEmployee, requirePermission, validateBody } from '../middleware/auth';

/**
 * The two shared team logins (one for FRD, one for ARD) and the mailbox each team
 * uses. Only an administrator manages them. The password never leaves the server
 * and is stored only as a hash.
 */
export const teamAccountsRouter = Router();
teamAccountsRouter.use(authenticate, requirePermission('teamaccounts.manage'));

const updateSchema = z.object({
  username: z.string().trim().min(3).max(60).regex(/^[A-Za-z0-9._-]+$/, 'Use letters, numbers, dot, dash or underscore only.').optional(),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').optional(),
  password: z.string().min(10, 'The password must be at least 10 characters.')
    .regex(/[A-Za-z]/, 'The password must contain a letter.')
    .regex(/[0-9]/, 'The password must contain a number.').optional(),
  isActive: z.boolean().optional(),
});

interface Row { id: number; team: TeamType; username: string; email: string; is_active: boolean; has_password: boolean; locked_until: Date | null }

const SELECT = `id, team, username, email, is_active, (password_hash <> '') AS has_password, locked_until`;

function toItem(row: Row) {
  return {
    id: row.id, team: row.team, label: TEAM_LABEL[row.team], username: row.username, email: row.email,
    isActive: row.is_active, hasPassword: row.has_password,
    lockedUntil: row.locked_until && new Date(row.locked_until) > new Date() ? new Date(row.locked_until).toISOString() : null,
  };
}

teamAccountsRouter.get('/', async (_req, res, next) => {
  try {
    const result = await pool.query<Row>(`SELECT ${SELECT} FROM team_accounts ORDER BY team`);
    res.json({ items: result.rows.map(toItem) });
  } catch (err) {
    next(err);
  }
});

teamAccountsRouter.patch('/:id', validateBody(updateSchema), async (req, res, next) => {
  const admin = currentEmployee(req);
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    const body = req.body as z.infer<typeof updateSchema>;

    const updated = await withTransaction(async (client) => {
      const before = await client.query<Row>(`SELECT ${SELECT} FROM team_accounts WHERE id = $1 FOR UPDATE`, [id]);
      const current = before.rows[0];
      if (!current) throw notFound();

      const sets: string[] = [];
      const params: unknown[] = [];
      const add = (column: string, value: unknown) => { params.push(value); sets.push(`${column} = $${params.length}`); };
      if (body.username !== undefined) add('username', body.username);
      if (body.email !== undefined) add('email', body.email);
      if (body.password !== undefined) {
        add('password_hash', await hashPassword(body.password));
        add('failed_login_count', 0);
        add('locked_until', null);
        add('must_change_password', false);
      }
      if (body.isActive !== undefined) add('is_active', body.isActive);
      if (!sets.length) throw badRequest('There is nothing to update.');
      if (body.isActive === true && !current.has_password && body.password === undefined) {
        throw conflict('Set a password before activating this team login.');
      }

      params.push(id);
      await client.query(`UPDATE team_accounts SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      // The password and its hash are never written to the audit trail.
      await writeAudit(client, {
        userId: admin.id, userName: admin.fullName, action: 'team.account_updated', module: 'team',
        recordType: 'TeamAccount', recordRef: current.username, accountId: id,
        newValue: {
          username: body.username, email: body.email, isActive: body.isActive,
          passwordChanged: body.password !== undefined ? true : undefined,
        },
      });
      // A deactivated or re-keyed team login ends every session that came through it.
      if (body.isActive === false || body.password !== undefined) {
        await client.query('UPDATE refresh_tokens SET revoked_at = now() WHERE team_account_id = $1 AND revoked_at IS NULL', [id]);
      }
      const after = await client.query<Row>(`SELECT ${SELECT} FROM team_accounts WHERE id = $1`, [id]);
      return after.rows[0];
    });
    res.json(toItem(updated));
  } catch (err) {
    next(err);
  }
});

