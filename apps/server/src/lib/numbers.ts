import type { PoolClient } from 'pg';
import { MESSAGES } from '@trf/shared';
import { duplicateError } from './errors';

/**
 * Gap-free, collision-free document numbers (TRF-2026-00001, COA-2026-00001).
 *
 * The counter row is locked and incremented inside the caller's transaction, so
 * fifty clients creating TRFs at the same moment get fifty different numbers and
 * none is skipped or reused. The UNIQUE constraint on trf_number is the final
 * guard: if this ever failed, the create would roll back rather than duplicate.
 */
export async function nextNumber(
  client: PoolClient,
  series: 'TRF' | 'COA',
  /** Year of the document itself, so a back-dated TRF still gets a number in its own year. */
  year?: number,
): Promise<string> {
  const useYear = year ?? new Date().getFullYear();
  const result = await client.query<{ last_value: number }>(
    `INSERT INTO number_counters (series, year, last_value) VALUES ($1, $2, 1)
     ON CONFLICT (series, year) DO UPDATE SET last_value = number_counters.last_value + 1
     RETURNING last_value`,
    [series, useYear],
  );
  return `${series}-${useYear}-${String(result.rows[0].last_value).padStart(5, '0')}`;
}

export const TRF_NUMBER_CONSTRAINT = 'trfs_trf_number_key';

export function trfDuplicateError(err: unknown) {
  return duplicateError(err, { [TRF_NUMBER_CONSTRAINT]: MESSAGES.TRF_NUMBER_EXISTS });
}
