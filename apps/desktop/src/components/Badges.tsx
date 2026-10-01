import { MESSAGES, TrfStatus, canTransitionTrf } from '@trf/shared';

const LABELS: Record<TrfStatus, string> = {
  New: 'New',
  Assigned: 'Assigned',
  'In Progress': 'In Progress',
  'Analysis Completed': 'Analysis Completed',
  'COA Pending': 'COA Pending',
  Completed: 'Completed',
  Cancelled: 'Cancelled',
};

const TONE: Record<TrfStatus, string> = {
  New: 'badge--muted',
  Assigned: 'badge--info',
  'In Progress': 'badge--info',
  'Analysis Completed': 'badge--info',
  'COA Pending': 'badge--warn',
  Completed: 'badge--ok',
  Cancelled: 'badge--muted',
};

export function StatusBadge({ status }: { status: TrfStatus }) {
  return <span className={`badge ${TONE[status]}`}>{LABELS[status]}</span>;
}

export function PriorityBadge({ priority }: { priority: 'Low' | 'Normal' | 'High' | 'Urgent' }) {
  if (priority === 'Normal' || priority === 'Low') return <span className="muted">{priority}</span>;
  return <span className={`badge ${priority === 'Urgent' ? 'badge--danger' : 'badge--warn'}`}>{priority}</span>;
}

export function OverdueBadge() {
  return <span className="badge badge--danger">Overdue</span>;
}

const PRIORITY_RANK: Record<string, number> = { Urgent: 0, High: 1, Normal: 2, Low: 3 };

/** Only the transitions the transition table allows are offered. */
export function allowedNextStatuses(status: TrfStatus): TrfStatus[] {
  const all: TrfStatus[] = ['New', 'Assigned', 'In Progress', 'Analysis Completed', 'COA Pending', 'Completed', 'Cancelled'];
  return all.filter((candidate) => canTransitionTrf(status, candidate));
}

export function sortPriorities(priorities: string[]): string[] {
  return [...priorities].sort((a, b) => (PRIORITY_RANK[a] ?? 9) - (PRIORITY_RANK[b] ?? 9));
}

export function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('en-GB');
}

export const OFFLINE_MESSAGE = MESSAGES.SERVER_UNAVAILABLE;
