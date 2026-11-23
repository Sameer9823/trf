import { PoolClient } from 'pg';

/**
 * Inserts a notification row inside the caller's transaction. Notifications are
 * addressed to a single employee (recipient_type = 'EMPLOYEE') when
 * recipientEmployeeId is set, or to a whole team (recipient_type = 'TEAM')
 * when recipientTeam is set.
 */
export interface NotificationParams {
  recipientEmployeeId?: number | null;
  recipientTeam?: 'FRD' | 'ARD' | null;
  type: string;
  title: string;
  body: string;
  trfId?: number | null;
  link?: string | null;
}

export async function createNotification(client: PoolClient, params: NotificationParams): Promise<void> {
  const recipientType = params.recipientEmployeeId ? 'EMPLOYEE' : 'TEAM';

  // One unread alert of a kind per TRF is enough. Re-firing the same event (a
  // status saved twice, or the ard-status and ard-submit paths both completing a
  // TRF) used to stack identical rows and flood the bell, so an existing unread
  // notification for this employee, type and TRF suppresses the new one. A team
  // broadcast has no single recipient to check against, so it is always sent.
  if (params.recipientEmployeeId && params.trfId) {
    const existing = await client.query(
      `SELECT 1 FROM notifications
        WHERE recipient_employee_id = $1
          AND type = $2
          AND related_trf_id = $3
          AND is_read = FALSE
        LIMIT 1`,
      [params.recipientEmployeeId, params.type, params.trfId],
    );
    if ((existing.rowCount ?? 0) > 0) return;
  }

  await client.query(
    `INSERT INTO notifications
       (recipient_type, recipient_employee_id, recipient_team, type, title, body, related_trf_id, link)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      recipientType,
      params.recipientEmployeeId ?? null,
      params.recipientTeam ?? null,
      params.type,
      params.title,
      params.body,
      params.trfId ?? null,
      params.link ?? (params.trfId ? `/trfs/${params.trfId}` : null),
    ],
  );
}

/** Convenience: notify a specific user about a TRF. */
export async function notifyEmployee(client: PoolClient, employeeId: number, type: string, title: string, body: string, trfId: number | null) {
  await createNotification(client, {
    recipientEmployeeId: employeeId,
    type, title, body,
    trfId,
    link: trfId ? `/trfs/${trfId}` : null,
  });
}
