import { useState } from 'react';
import type { ExportMeta, ExportSheetName } from '@trf/shared';
import { MESSAGES } from '@trf/shared';

export interface ExportOutcome {
  ok: boolean;
  cancelled: boolean;
  message?: string;
  path?: string;
  meta?: ExportMeta | null;
}

/**
 * Export takes the same filter names the list endpoints read, so the file holds
 * exactly the rows the employee was looking at. The workbook is fetched and saved
 * in the main process; this module only reports what happened.
 */
export async function runExport(
  filters: Record<string, string | number | boolean | undefined>,
  sheet?: ExportSheetName,
): Promise<ExportOutcome> {
  const params = new URLSearchParams();
  if (sheet) params.set('sheet', sheet);
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === '' || value === false) continue;
    params.set(key, String(value));
  }

  const res = await window.trf.exportReport(params.toString());
  if (!res.ok) {
    return { ok: false, cancelled: Boolean(res.cancelled), message: res.message ?? MESSAGES.CURRENCY_UNAVAILABLE };
  }
  return {
    ok: true,
    cancelled: false,
    path: res.path,
    meta: (res.meta as ExportMeta | undefined) ?? null,
  };
}

export type ExportState =
  | { status: 'idle' }
  | { status: 'working' }
  | { status: 'done'; outcome: ExportOutcome }
  | { status: 'failed'; message: string };

/**
 * Shared button state. The caller keeps the filters; this only manages whether a
 * save is in progress and what to say afterwards, so every list behaves the same.
 */
export function useExportButton() {
  const [state, setState] = useState<ExportState>({ status: 'idle' });

  const start = async (filters: Record<string, string | number | boolean | undefined>) => {
    setState({ status: 'working' });
    const outcome = await runExport(filters);
    setState(outcome.ok ? { status: 'done', outcome } : { status: 'failed', message: outcome.message ?? 'The export failed.' });
    return outcome;
  };

  const clear = () => setState({ status: 'idle' });
  return { state, start, clear, busy: state.status === 'working' };
}

/** One line saying where the file went and what was in it. */
export function exportSummary(state: ExportState): string | null {
  if (state.status === 'done' && state.outcome.ok) {
    const meta = state.outcome.meta;
    const parts = meta ? Object.entries(meta.rowCounts).map(([sheet, n]) => `${sheet} ${n}`).join(', ') : '';
    const where = state.outcome.path ? ` saved to ${state.outcome.path}` : '';
    return `Export complete (${parts}).${where}`;
  }
  if (state.status === 'failed') return state.message;
  return null;
}