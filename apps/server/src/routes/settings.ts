import { Router } from 'express';
import { z } from 'zod';
import type { SystemSetting } from '@trf/shared';
import { pool, withTransaction } from '../db';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { authenticate, currentEmployee, requirePermission, requireRole, validateBody } from '../middleware/auth';

export const settingsRouter = Router();
settingsRouter.use(authenticate);

const settingKeys = [
  'FORM_SOP_NO', 'FORM_REVISION', 'FORM_EFFECTIVE_DATE', 'FORM_ISSUED_BY', 'FORM_DEPARTMENT',
] as const;
type SettingKey = (typeof settingKeys)[number];

const settingSchema = z.object({
  value: z.string().trim().max(500),
});

settingsRouter.get('/', requirePermission('settings.view'), async (_req, res, next) => {
  try {
    const result = await pool.query<{
      key: string; value: string; description: string | null; updated_at: string; updated_by_name: string | null;
    }>(
      `SELECT s.key, s.value, s.description, s.updated_at,
              e.full_name AS updated_by_name
       FROM system_settings s
       LEFT JOIN employees e ON e.id = s.updated_by
       ORDER BY s.key ASC`
    );
    const items: SystemSetting[] = result.rows.map((row) => ({
      key: row.key,
      value: row.value,
      description: row.description,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by_name,
    }));
    res.json({ items });
  } catch (err) { next(err); }
});

/** Form-specific settings for the print page - accessible with trf.view permission. */
settingsRouter.get('/form', requirePermission('trf.view'), async (_req, res, next) => {
  try {
    const result = await pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM system_settings WHERE key IN ('FORM_SOP_NO', 'FORM_REVISION', 'FORM_EFFECTIVE_DATE', 'FORM_ISSUED_BY', 'FORM_DEPARTMENT')`
    );
    const map = Object.fromEntries(result.rows.map((r) => [r.key, r.value]));
    res.json({
      sopNo: map.FORM_SOP_NO ?? 'QAGN:003:F1',
      revision: map.FORM_REVISION ?? '00',
      effectiveDate: map.FORM_EFFECTIVE_DATE ?? '',
      issuedBy: map.FORM_ISSUED_BY ?? '',
      department: map.FORM_DEPARTMENT ?? 'Quality Assurance',
    });
  } catch (err) { next(err); }
});

settingsRouter.patch('/:key', requirePermission('settings.manage'), validateBody(settingSchema), async (req, res, next) => {
  const key = String(req.params.key).toUpperCase();
  if (!settingKeys.includes(key as SettingKey)) {
    return next(badRequest('Unknown setting key.'));
  }
  const user = currentEmployee(req);
  const body = req.body as z.infer<typeof settingSchema>;
  try {
    const result = await withTransaction(async (client) => {
      const existing = await client.query<{ value: string }>(
        `SELECT value FROM system_settings WHERE key = $1`, [key]
      );
      const oldValue = existing.rows[0]?.value ?? '';
      if (oldValue === body.value) return { key, value: body.value };

      await client.query(
        `INSERT INTO system_settings (key, value, updated_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = NOW()`,
        [key, body.value, user.id]
      );

      await writeAudit(client, {
        userId: user.id, userName: user.fullName, action: 'setting.changed', module: 'settings',
        recordType: 'SystemSetting', recordRef: key,
        oldValue: { value: oldValue },
        newValue: { value: body.value },
      });
      return { key, value: body.value };
    });
    res.json(result);
  } catch (err) { next(err); }
});

const defaultSettings: Record<SettingKey, { value: string; description: string }> = {
  FORM_SOP_NO: { value: 'QAGN:003:F1', description: 'SOP number printed on the TRF form' },
  FORM_REVISION: { value: '00', description: 'Revision number printed on the TRF form' },
  FORM_EFFECTIVE_DATE: { value: '', description: 'Effective date printed on the TRF form' },
  FORM_ISSUED_BY: { value: '', description: 'Issued by name printed on the TRF form' },
  FORM_DEPARTMENT: { value: 'Quality Assurance', description: 'Department name printed on the TRF form' },
};

settingsRouter.post('/seed', requirePermission('settings.manage'), async (_req, res, next) => {
  try {
    await withTransaction(async (client) => {
      for (const [key, { value, description }] of Object.entries(defaultSettings)) {
        await client.query(
          `INSERT INTO system_settings (key, value, description)
           VALUES ($1, $2, $3)
           ON CONFLICT (key) DO NOTHING`,
          [key, value, description]
        );
      }
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});