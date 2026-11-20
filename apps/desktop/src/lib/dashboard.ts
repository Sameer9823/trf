import type { DashboardPayload, DashboardResult } from '@trf/shared';
import { MESSAGES } from '@trf/shared';
import { messageOf } from './api';

/**
 * The dashboard has no filters of its own: every figure already reflects the
 * signed-in role's scope. Clicking a card hands the matching filter to the list.
 */
export async function loadDashboard(): Promise<DashboardResult> {
  const res = await window.trf.request<DashboardPayload>({ method: 'GET', path: '/api/dashboard' });
  if (!res.ok || !res.data) {
    return { ok: false, message: messageOf(res.data, MESSAGES.SERVER_UNAVAILABLE) };
  }
  return { ok: true, data: res.data };
}

/** The list URL a card opens, using the same query shape the list endpoint reads. */
export function cardLink(page: string, filters: Record<string, string | number | boolean>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === '' || value === false) continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `#/${page}?${query}` : `#/${page}`;
}