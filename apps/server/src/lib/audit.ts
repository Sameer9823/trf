import { PoolClient } from 'pg';

/**
 * Writes an audit row inside the caller's transaction, so an audit row can only
 * exist together with the change it describes.
 */
export async function writeAudit(
  client: PoolClient,
  entry: {
    userId?: number | null;
    userName?: string | null;
    action: string;
    module: string;
    recordType?: string | null;
    recordRef?: string | null;
    oldValue?: unknown;
    newValue?: unknown;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs (user_id, user_name, action, module, record_type, record_ref, old_value, new_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.userId ?? null,
      entry.userName ?? null,
      entry.action,
      entry.module,
      entry.recordType ?? null,
      entry.recordRef ?? null,
      entry.oldValue === undefined ? null : JSON.stringify(entry.oldValue),
      entry.newValue === undefined ? null : JSON.stringify(entry.newValue),
    ],
  );
}

/** Only the fields that actually changed, so the audit row stays readable. */
export function diffFields<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
  fields: (keyof T)[],
): { field: keyof T; old: unknown; new: unknown }[] {
  const changed: { field: keyof T; old: unknown; new: unknown }[] = [];
  for (const field of fields) {
    if (after[field] === undefined) continue;
    const oldValue = before[field];
    const newValue = after[field];
    if (oldValue instanceof Date) continue;
    if (oldValue !== newValue) changed.push({ field, old: oldValue ?? null, new: newValue ?? null });
  }
  return changed;
}
