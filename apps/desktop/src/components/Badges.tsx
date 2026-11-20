import { MESSAGES, TrfStatus, canTransitionTrf, canTransitionArd, ArdWorkflowStatus, RemarksStatus, ArdRemarksStatus } from '@trf/shared';

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

const ARD_WORKFLOW_TONE: Record<string, string> = {
  Received: 'badge--muted',
  'In Progress': 'badge--info',
  Completed: 'badge--ok',
  Cancelled: 'badge--muted',
};

const REMARKS_STATUS_TONE: Record<RemarksStatus, string> = {
  Pending: 'badge--warn',
  Approved: 'badge--ok',
  Rejected: 'badge--danger',
};

export function ArdWorkflowBadge({ status }: { status: string }) {
  return <span className={`badge ${ARD_WORKFLOW_TONE[status] ?? 'badge--muted'}`}>{status}</span>;
}

/**
 * The Final Status of the ARD block, shown as a coloured pill everywhere: on
 * the form, on the detail page, in the list and on the printable TRF.
 */
export function ArdFinalStatusBadge({ status }: { status: string }) {
  const tone = status === 'Completed' ? 'badge--ok'
    : status === 'In Progress' ? 'badge--info'
      : status === 'Cancelled' ? 'badge--danger' : 'badge--muted';
  return <span className={`badge ${tone}`}>{status}</span>;
}

/** The lab stage the sample has reached. */
export function ArdStageBadge({ stage }: { stage: string }) {
  const tone = stage === 'Completed' || stage === 'Reporting' || stage === 'COA Preparation' ? 'badge--ok'
    : stage === 'Sample Received' || stage === 'Sample Preparation' ? 'badge--muted'
      : 'badge--info';
  return <span className={`badge ${tone}`}>{stage}</span>;
}

export function RemarksStatusBadge({ status }: { status: RemarksStatus | string }) {
  const tone = REMARKS_STATUS_TONE[status as RemarksStatus] ?? 'badge--muted';
  return <span className={`badge ${tone}`}>{status}</span>;
}

const ARD_REMARKS_STATUS_TONE: Record<string, string> = {
  Pending: 'badge--warn',
  'Sample Received': 'badge--info',
  'Under Analysis': 'badge--info',
  'Result Reported': 'badge--ok',
  'Retest Required': 'badge--warn',
  'On Hold': 'badge--warn',
  Completed: 'badge--ok',
};

export function ArdRemarksStatusBadge({ status }: { status: ArdRemarksStatus | string }) {
  const tone = ARD_REMARKS_STATUS_TONE[status] ?? 'badge--muted';
  return <span className={`badge ${tone}`}>{status}</span>;
}

export function ArdCoaBadge({ status }: { status: string }) {
  const tone = ['Approved', 'Issued'].includes(status) ? 'badge--ok'
    : status === 'Under Review' ? 'badge--warn' : 'badge--muted';
  return <span className={`badge ${tone}`}>{status}</span>;
}

/** Reporting status as a coloured pill: Approved green, Rejected red, Pending amber, the rest neutral. */
export function ArdReportingBadge({ status }: { status: string }) {
  const tone = status === 'Approved' ? 'badge--ok'
    : status === 'Rejected' ? 'badge--danger'
      : status === 'Pending' ? 'badge--warn' : 'badge--muted';
  return <span className={`badge ${tone}`}>{status}</span>;
}

export function TatBadge({ tat }: { tat: number | null }): string {
  if (tat === null) return '—';
  if (tat > 5) return `${tat}d`;
  return `${tat}d`;
}

const PRIORITY_RANK: Record<string, number> = { Urgent: 0, High: 1, Normal: 2, Low: 3 };

/** Only the transitions the transition table allows are offered. */
export function allowedNextStatuses(status: TrfStatus): TrfStatus[] {
  const all: TrfStatus[] = ['New', 'Assigned', 'In Progress', 'Analysis Completed', 'COA Pending', 'Completed', 'Cancelled'];
  return all.filter((candidate) => canTransitionTrf(status, candidate));
}

/** ARD workflow transitions offered to the ARD team. */
export function allowedNextArdStatuses(status: ArdWorkflowStatus): ArdWorkflowStatus[] {
  return ArdWorkflowStatus.filter((candidate) => canTransitionArd(status, candidate));
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
