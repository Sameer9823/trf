import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import type { AnalystAssignedTest, ArdResultReviewStatus, ArdTestAssignmentStatus } from '@trf/shared';
import { useAuth } from '../lib/auth';
import { useServerStatus } from '../lib/server-status';
import { OfflineNotice } from '../components/OfflineNotice';
import { formatDate } from '../components/Badges';
import { EmptyState, StatStrip } from '../components/StatStrip';
import { ResultReviewBadge, SubmitResultModal, ResultFileButton, type SubmitTarget } from '../components/ResultReview';
import { Icons } from '../components/Icons';

interface AssignmentSummary {
  id: number;
  trfId: number;
  trfNumber: string;
  arNumber: string | null;
  productName: string | null;
  genericName: string | null;
  batchNumber: string | null;
  testName: string;
  testStatus: ArdTestAssignmentStatus;
  assignedAt: string | null;
  dueDate: string | null;
  /** Result fields */
  outcome: 'Pass' | 'Fail' | 'NA' | null;
  resultValue: string | null;
  resultText: string | null;
  unit: string | null;
  methodUsed: string | null;
  specification: string | null;
  remarks: string | null;
  submittedAt: string | null;
  /** The AGM's review of the submitted result */
  reviewStatus: ArdResultReviewStatus | null;
  reviewReason: string | null;
  reviewedAt: string | null;
  reviewedByName: string | null;
  resultMode: 'text' | 'pdf' | null;
  fileName: string | null;
  fileSize: number | null;
  /** Completion fields */
  analysisStartDate: string | null;
  completionDate: string | null;
  /** Needed to submit a result: it guards against a newer change. */
  version: number;
}

const STATUS_LABEL: Record<ArdTestAssignmentStatus, string> = {
  'Pending Assignment': 'Pending',
  'Assigned': 'Assigned',
  'In Progress': 'In Progress',
  'Completed': 'Completed',
  'Re-test Required': 'Re-test',
  'Cancelled': 'Cancelled',
};

const STATUS_BADGE: Record<ArdTestAssignmentStatus, string> = {
  'Pending Assignment': 'badge--muted',
  'Assigned': 'badge--info',
  'In Progress': 'badge--info',
  'Completed': 'badge--ok',
  'Re-test Required': 'badge--warn',
  'Cancelled': 'badge--danger',
};

type Range = 'all' | 'today' | '7d' | '30d';
const RANGES: { key: Range; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
];

type SortKey = 'trf' | 'assigned' | 'due' | 'status';

/** The first moment a date-range window includes, or null for "all time". */
function rangeStart(range: Range, now: Date): Date | null {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (range === 'today') return midnight;
  if (range === '7d') { midnight.setDate(midnight.getDate() - 6); return midnight; }
  if (range === '30d') { midnight.setDate(midnight.getDate() - 29); return midnight; }
  return null;
}

/** Whether an ISO date (or missing date) falls inside the selected window. */
function inRange(iso: string | null, range: Range, now: Date): boolean {
  if (range === 'all') return true;
  // A test with no date yet (e.g. pending) belongs only to the unfiltered view.
  if (!iso) return false;
  const start = rangeStart(range, now);
  if (!start) return true;
  return new Date(iso).getTime() >= start.getTime();
}

/** Turnaround in days between two dates, or null if either is missing. */
function daysBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return ms / 86_400_000;
}

const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (iso: string) => iso.slice(0, 10);

function timeLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

type ActivityKind = 'assigned' | 'submitted' | 'approved' | 'rejected' | 'completed' | 'pdf';
interface Activity {
  id: string;
  at: string;
  kind: ActivityKind;
  text: string;
}
const ACTIVITY_COLOR: Record<ActivityKind, string> = {
  assigned: 'var(--navy)',
  submitted: 'var(--accent)',
  approved: 'var(--ok)',
  rejected: 'var(--danger)',
  completed: 'var(--ok)',
  pdf: 'var(--accent-2)',
};

export function EmployeeDashboard() {
  const { state } = useServerStatus();
  const { employee } = useAuth();
  const [assignments, setAssignments] = useState<AssignmentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState<SubmitTarget | null>(null);
  const [search, setSearch] = useState('');
  const [range, setRange] = useState<Range>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | ArdTestAssignmentStatus>('all');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'due', dir: 'asc' });
  /** PDF opens are noted here, in this session, so the activity list can show them. */
  const [pdfOpens, setPdfOpens] = useState<{ id: number; at: string; testName: string }[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await window.trf.request<{ items: AnalystAssignedTest[] }>({
      method: 'GET', path: '/api/ard-assignments/employee-dashboard',
    });
    setLoading(false);
    if (!res.ok) {
      setError(res.error || 'Could not load your assignments.');
      return;
    }
    const items: AssignmentSummary[] = (res.data?.items ?? []).map((a) => ({
      id: a.assignmentId,
      trfId: a.trfId,
      trfNumber: a.trfNumber,
      arNumber: a.arNumber,
      productName: a.productName,
      genericName: a.genericName,
      batchNumber: a.batchNumber,
      testName: a.testName,
      testStatus: a.testStatus,
      assignedAt: a.assignedAt,
      dueDate: a.dueDate,
      outcome: a.outcome ?? null,
      resultValue: a.resultValue ?? null,
      resultText: a.resultText ?? null,
      unit: a.unit ?? null,
      methodUsed: a.methodUsed ?? null,
      specification: a.specification ?? null,
      remarks: a.remarks ?? null,
      submittedAt: a.submittedAt ?? null,
      reviewStatus: a.reviewStatus ?? null,
      reviewReason: a.reviewReason ?? null,
      reviewedAt: a.reviewedAt ?? null,
      reviewedByName: a.reviewedByName ?? null,
      resultMode: a.resultMode ?? null,
      fileName: a.fileName ?? null,
      fileSize: a.fileSize ?? null,
      analysisStartDate: a.analysisStartDate ?? null,
      completionDate: a.completionDate ?? null,
      version: a.assignmentVersion ?? 0,
    }));
    setAssignments(items);
  }, []);

  useEffect(() => {
    if (state === 'offline') { setLoading(false); return; }
    void load();
  }, [load, state]);

  const recordPdfOpen = useCallback((testName: string) => {
    setPdfOpens((list) => [{ id: Date.now(), at: new Date().toISOString(), testName }, ...list].slice(0, 20));
  }, []);

  async function updateStatus(a: AssignmentSummary, status: ArdTestAssignmentStatus) {
    setUpdatingId(a.id);
    const res = await window.trf.request({
      method: 'PATCH',
      path: `/api/ard-assignments/${a.id}/status`,
      body: { status, version: a.version, note: null },
    });
    setUpdatingId(null);
    if (!res.ok) {
      setError(res.error || 'Could not update the test status.');
      return;
    }
    void load();
  }

  if (state === 'offline') return <div className="page page--wide"><OfflineNotice /></div>;

  if (loading && assignments.length === 0) {
    return <div className="page page--wide"><p className="muted">Loading your test assignments…</p></div>;
  }

  const now = new Date();

  // Everything below is derived from the assignments inside the selected date window,
  // so the KPIs, the ring, the trend and the queue always describe the same set.
  const scoped = assignments.filter((a) => inRange(a.assignedAt, range, now));
  const nonCancelled = scoped.filter((a) => a.testStatus !== 'Cancelled');

  const assignedCount = nonCancelled.filter((a) => a.testStatus === 'Pending Assignment' || a.testStatus === 'Assigned').length;
  const inProgressCount = nonCancelled.filter((a) => a.testStatus === 'In Progress' || a.testStatus === 'Re-test Required').length;
  const completedCount = nonCancelled.filter((a) => a.testStatus === 'Completed').length;
  const awaitingReview = nonCancelled.filter((a) => a.reviewStatus === 'Submitted').length;
  const sentBack = nonCancelled.filter((a) => a.reviewStatus === 'Rejected');
  const completionPct = nonCancelled.length > 0 ? Math.round((completedCount / nonCancelled.length) * 100) : 0;

  const turnarounds = nonCancelled
    .filter((a) => a.testStatus === 'Completed')
    .map((a) => daysBetween(a.analysisStartDate ?? a.assignedAt, a.completionDate))
    .filter((n): n is number => n != null);
  const avgTurnaround = turnarounds.length > 0
    ? `${(turnarounds.reduce((s, n) => s + n, 0) / turnarounds.length).toFixed(1)}d`
    : '—';

  // Completed-per-day, as a continuous 14-day window so the chart has a baseline.
  const trend: { label: string; count: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    trend.push({ label: d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), count: 0 });
  }
  const trendByKey = new Map<string, { label: string; count: number }>(
    trend.map((slot, i) => {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (13 - i));
      const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      return [key, slot] as const;
    }),
  );
  for (const a of nonCancelled) {
    if (!a.completionDate) continue;
    const slot = trendByKey.get(dayKey(a.completionDate));
    if (slot) slot.count += 1;
  }

  const activities: Activity[] = [];
  for (const a of nonCancelled) {
    if (a.assignedAt) activities.push({ id: `${a.id}-assigned`, at: a.assignedAt, kind: 'assigned', text: `${a.testName} assigned` });
    if (a.submittedAt) activities.push({ id: `${a.id}-submitted`, at: a.submittedAt, kind: 'submitted', text: `Result submitted for ${a.testName}` });
    if (a.reviewedAt) activities.push({ id: `${a.id}-reviewed`, at: a.reviewedAt, kind: a.reviewStatus === 'Rejected' ? 'rejected' : 'approved', text: `${a.testName} ${a.reviewStatus === 'Rejected' ? 'sent back' : 'approved'}` });
    if (a.completionDate) activities.push({ id: `${a.id}-completed`, at: a.completionDate, kind: 'completed', text: `${a.testName} completed` });
  }
  for (const p of pdfOpens) activities.push({ id: `pdf-${p.id}`, at: p.at, kind: 'pdf', text: `Viewed PDF for ${p.testName}` });
  const recentActivity = activities
    .filter((e) => e.at && !Number.isNaN(new Date(e.at).getTime()))
    .sort((x, y) => new Date(y.at).getTime() - new Date(x.at).getTime())
    .slice(0, 8);

  const query = search.trim().toLowerCase();
  const searched = query
    ? scoped.filter((a) => [a.trfNumber, a.arNumber, a.productName, a.genericName, a.testName]
        .filter(Boolean).join(' ').toLowerCase().includes(query))
    : scoped;
  const filtered = statusFilter === 'all' ? searched : searched.filter((a) => a.testStatus === statusFilter);

  const sorted = [...filtered].sort((a, b) => {
    let av = '';
    let bv = '';
    switch (sort.key) {
      case 'trf': av = a.trfNumber; bv = b.trfNumber; break;
      case 'assigned': av = a.assignedAt ?? ''; bv = b.assignedAt ?? ''; break;
      case 'due': av = a.dueDate ?? '9999-12-31'; bv = b.dueDate ?? '9999-12-31'; break;
      case 'status': av = a.testStatus; bv = b.testStatus; break;
    }
    const r = av.localeCompare(bv);
    return sort.dir === 'asc' ? r : -r;
  });

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  }
  const sortMark = (key: SortKey) => (sort.key === key ? (sort.dir === 'asc' ? '▲' : '▼') : '');

  const filtersActive = !!query || statusFilter !== 'all' || range !== 'all';

  return (
    <div className="page page--wide">
      <div className="dash ework">
        <header className="dash__head">
          <div>
            <h1 className="dash__title">Your Tests</h1>
            <p className="dash__scope">
              {employee
                ? `ARD test assignments for ${employee.fullName}.`
                : 'Your ARD test assignments.'}
            </p>
          </div>
          <div className="ework-head">
            <div className="segmented" role="group" aria-label="Date range">
              {RANGES.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  className={`segmented__btn${range === r.key ? ' segmented__btn--active' : ''}`}
                  onClick={() => setRange(r.key)}
                  aria-pressed={range === r.key}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <button className="btn" onClick={load} disabled={loading}>Refresh</button>
          </div>
        </header>

        {error && <p className="error-text" role="alert">{error}</p>}

        {assignments.length === 0 ? (
          <EmptyState
            icon={Icons.ard}
            title="No tests assigned to you"
            text="When a GM or AGM assigns a test, it will appear here."
          />
        ) : (
          <>
            <StatStrip tiles={[
              { label: 'Assigned', value: assignedCount, tone: 'info' },
              { label: 'In Progress', value: inProgressCount, tone: 'info' },
              { label: 'Completed', value: completedCount, tone: 'ok' },
              { label: 'Awaiting review', value: awaitingReview, tone: 'warn' },
              { label: 'Sent back', value: sentBack.length, tone: 'danger' },
              { label: 'Avg. turnaround', value: avgTurnaround },
            ]} />

            <div className="ework-grid">
              <section className="panel ework-ring-panel">
                <h2 className="panel__title">Completion</h2>
                <div className="ework-ring-wrap">
                  <div
                    className="ework-ring"
                    style={{ ['--pct' as string]: `${completionPct * 3.6}deg` } as React.CSSProperties}
                    role="img"
                    aria-label={`${completionPct}% of your tests completed`}
                  >
                    <div className="ework-ring__hole">
                      <span className="ework-ring__pct">{completionPct}%</span>
                      <span className="ework-ring__label">done</span>
                    </div>
                  </div>
                  <ul className="ework-ring-legend">
                    <li><span className="ework-ring-legend__dot" style={{ background: 'var(--ok)' }} />Completed <strong>{completedCount}</strong></li>
                    <li><span className="ework-ring-legend__dot" style={{ background: 'var(--accent)' }} />In hand <strong>{assignedCount + inProgressCount}</strong></li>
                    <li><span className="ework-ring-legend__dot" style={{ background: 'var(--warn)' }} />Awaiting review <strong>{awaitingReview}</strong></li>
                    <li><span className="ework-ring-legend__dot" style={{ background: 'var(--line)' }} />Total <strong>{nonCancelled.length}</strong></li>
                  </ul>
                </div>
              </section>

              <section className="panel">
                <h2 className="panel__title">Completed per day · last 14 days</h2>
                <div className="chart-scroll">
                  <ResponsiveContainer width="100%" height={220}>
                    <AreaChart data={trend} margin={{ top: 8, right: 12, bottom: 4, left: -18 }}>
                      <defs>
                        <linearGradient id="doneFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#2f7d4f" stopOpacity={0.22} />
                          <stop offset="100%" stopColor="#2f7d4f" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="#efe6df" vertical={false} />
                      <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" axisLine={false} tickLine={false} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                      <Tooltip
                        contentStyle={{ borderRadius: 8, border: '1px solid var(--line)', fontSize: 12, boxShadow: '0 6px 16px rgba(44,24,18,.08)' }}
                        formatter={(v: number) => [`${v} completed`, 'Tests']}
                      />
                      <Area type="monotone" dataKey="count" stroke="#2f7d4f" strokeWidth={2} fill="url(#doneFill)" dot={false} activeDot={{ r: 4 }} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </section>
            </div>

            {sentBack.length > 0 && (
              <section className="attention" aria-label="Sent back for correction">
                <span className="attention__title">Sent back</span>
                <div className="attention__items">
                  {sentBack.map((a) => (
                    <Link
                      key={a.id}
                      className="attention__item attention__item--danger"
                      to={`/trfs/${a.trfId}`}
                      title={a.reviewReason ?? undefined}
                    >
                      <strong>!</strong>
                      <span>{a.testName} · {a.trfNumber}</span>
                    </Link>
                  ))}
                </div>
              </section>
            )}

            {recentActivity.length > 0 && (
              <section className="panel">
                <h2 className="panel__title">Recent activity</h2>
                <ol className="ework-timeline">
                  {recentActivity.map((e) => (
                    <li key={e.id} className="ework-timeline__item">
                      <span className="ework-timeline__dot" style={{ background: ACTIVITY_COLOR[e.kind] }} aria-hidden="true" />
                      <span className="ework-timeline__body">
                        <span className="ework-timeline__what">{e.text}</span>
                        <span className="ework-timeline__when">{timeLabel(e.at)}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            <section className="panel ework-queue">
              <div className="ework-toolbar">
                <h2 className="panel__title">Work queue</h2>
                <div className="ework-toolbar__filters">
                  <input
                    placeholder="Search TRF, A.R. no, product or test"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    aria-label="Search your tests"
                  />
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as 'all' | ArdTestAssignmentStatus)}
                    aria-label="Filter by status"
                  >
                    <option value="all">All statuses</option>
                    {(Object.keys(STATUS_LABEL) as ArdTestAssignmentStatus[]).map((s) => (
                      <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                    ))}
                  </select>
                </div>
              </div>

              {sorted.length === 0 ? (
                <p className="muted">
                  {filtersActive ? `No tests match your filters.` : 'No tests in this date range.'}
                </p>
              ) : (
                <div className="table-wrap">
                  <table className="table table--striped" role="grid">
                    <thead>
                      <tr>
                        <th><button className="th-sort" onClick={() => toggleSort('trf')}>TRF {sortMark('trf')}</button></th>
                        <th>A.R. No.</th>
                        <th>Product</th>
                        <th>Generic Name</th>
                        <th>Test</th>
                        <th><button className="th-sort" onClick={() => toggleSort('assigned')}>Assigned {sortMark('assigned')}</button></th>
                        <th><button className="th-sort" onClick={() => toggleSort('due')}>Due Date {sortMark('due')}</button></th>
                        <th><button className="th-sort" onClick={() => toggleSort('status')}>Status {sortMark('status')}</button></th>
                        <th>Result</th>
                        <th>Outcome</th>
                        <th>AGM review</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sorted.map((a) => (
                        <tr key={a.id}>
                          <td><Link to={`#/trfs/${a.trfId}`} className="link">{a.trfNumber}</Link></td>
                          <td>{a.arNumber ?? '—'}</td>
                          <td>{a.productName ?? '—'}</td>
                          <td>{a.genericName ?? '—'}</td>
                          <td>{a.testName}</td>
                          <td>{a.assignedAt ? formatDate(a.assignedAt) : '—'}</td>
                          <td>{a.dueDate ? formatDate(a.dueDate) : '—'}</td>
                          <td>
                            <span className={`badge ${STATUS_BADGE[a.testStatus] ?? 'badge--info'}`}>
                              {STATUS_LABEL[a.testStatus]}
                            </span>
                          </td>
                          <td>
                            {a.resultMode === 'pdf' && a.fileName
                              ? <ResultFileButton assignmentId={a.id} fileName={a.fileName} onOpen={() => recordPdfOpen(a.testName)} />
                              : <>{a.resultValue ?? '—'}{a.resultMode !== 'pdf' && a.unit ? ` ${a.unit}` : ''}</>}
                          </td>
                          <td>{a.outcome ?? '—'}</td>
                          <td>
                            <ResultReviewBadge status={a.reviewStatus} />
                            {a.reviewStatus === 'Rejected' && a.reviewReason && (
                              <div className="reject-reason">{a.reviewReason}</div>
                            )}
                            {a.reviewStatus === 'Approved' && a.reviewedByName && <div className="muted">{a.reviewedByName}</div>}
                          </td>
                          <td>
                            {updatingId === a.id ? <span className="muted">Saving…</span> : (
                              <div className="table__actions">
                                <button
                                  className="btn btn--sm"
                                  onClick={() => updateStatus(a, 'In Progress')}
                                  disabled={a.testStatus === 'In Progress' || a.testStatus === 'Completed' || a.testStatus === 'Cancelled' || a.reviewStatus === 'Submitted'}
                                >Mark In Progress</button>
                                <button
                                  className="btn btn--sm btn--primary"
                                  onClick={() => setSubmitting({
                                    assignmentId: a.id, version: a.version, testName: a.testName, trfNumber: a.trfNumber,
                                    analysisStartDate: a.analysisStartDate,
                                    fileName: a.fileName ?? null, fileSize: a.fileSize ?? null, resultMode: a.resultMode ?? null,
                                    previous: a.reviewStatus === 'Rejected' ? {
                                      resultValue: a.resultValue, resultText: a.resultText, unit: a.unit, methodUsed: a.methodUsed,
                                      specification: a.specification,
                                      outcome: a.outcome, remarks: a.remarks,
                                    } : null,
                                  })}
                                  disabled={a.testStatus === 'Completed' || a.testStatus === 'Cancelled' || a.reviewStatus === 'Submitted'}
                                >{a.reviewStatus === 'Rejected' ? 'Correct & resubmit' : 'Submit result'}</button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}

        <SubmitResultModal target={submitting} onClose={() => setSubmitting(null)} onSubmitted={() => void load()} />
      </div>
    </div>
  );
}