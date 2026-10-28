import { Router } from 'express';
import type { Notification } from '@trf/shared';
import { authenticate, currentEmployee, requirePermission } from '../middleware/auth';
import { pool } from '../db';

export const notificationsRouter = Router();
notificationsRouter.use(authenticate);

notificationsRouter.get('/', requirePermission('notifications.view'), async (req, res, next) => {
  try {
    const employee = currentEmployee(req);
    const { page = '1', pageSize = '20', unread = 'false' } = req.query as Record<string, string>;
    const limit = Math.min(Math.max(Number(pageSize), 1), 100);
    const offset = (Math.max(Number(page), 1) - 1) * limit;
    const onlyUnread = unread === 'true';

    const result = await pool.query<Notification>(
      `SELECT id,
              recipient_type AS "recipientType",
              recipient_employee_id AS "recipientEmployeeId",
              recipient_team AS "recipientTeam",
              type, title, body,
              related_trf_id AS "relatedTrfId",
              link, is_read AS "isRead",
              created_at AS "createdAt",
              read_at AS "readAt"
         FROM notifications
         WHERE recipient_employee_id = $1
           AND ($4 = FALSE OR is_read = FALSE)
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
      [employee.id, limit, offset, onlyUnread],
    );

    const unreadCount = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM notifications
        WHERE recipient_employee_id = $1 AND is_read = FALSE`,
      [employee.id],
    );

    res.json({
      items: result.rows,
      unreadCount: Number(unreadCount.rows[0]?.count ?? 0),
      page: Number(page),
      pageSize: limit,
    });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.put('/:id/read', requirePermission('notifications.view'), async (req, res, next) => {
  try {
    const employee = currentEmployee(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: { message: 'Invalid notification ID.' } });
    const result = await pool.query(
      `UPDATE notifications
          SET is_read = TRUE, read_at = now()
        WHERE id = $1 AND recipient_employee_id = $2 AND is_read = FALSE
        RETURNING id`,
      [id, employee.id],
    );
    if (result.rowCount === 0) return res.status(204).send();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

notificationsRouter.get('/unread-count', requirePermission('notifications.view'), async (req, res, next) => {
  try {
    const employee = currentEmployee(req);
    const result = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM notifications
        WHERE recipient_employee_id = $1 AND is_read = FALSE`,
      [employee.id],
    );
    res.json({ count: Number(result.rows[0]?.count ?? 0) });
  } catch (err) {
    next(err);
  }
});
