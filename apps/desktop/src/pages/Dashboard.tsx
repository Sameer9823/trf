import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { AnalystResultRow, DashboardPayload, StatusSlice } from '@trf/shared';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';
import { cardLink, loadDashboard } from '../lib/dashboard';
import { useAuth } from '../lib/auth';
import { useServerStatus } from '../lib/server-status';
import { OfflineNotice } from '../components/OfflineNotice';
import { Icons } from '../components/Icons';

/**
 * Every figure on this page is counted by the server over the scope of the
 * signed-in role. Nothing is totalled, filtered or derived in the browser, so a
 * card and the list it opens can never disagree. The one ratio shown — the
 * completion ring — is two payload figures over each other, not a recount.
 */
export function Dashboard() {
  const { state, health, serverUrl, lastChecked } = useServerStatus();
  const { employee, can, canAccessModule } = useAuth();
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // Chart draw-in plays once per session, on the first data only; never on refresh.
  const [animateCharts, setAnimateCharts] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await loadDashboard();
    setLoading(false);
    if (!res.ok) { setError(res.message); return; }
    setError(null);
    setData(res.data);
  }, []);

  useEffect(() => {
    if (state === 'offline') { setLoading(false); return; }
    void load();
  }, [load, state, nonce]);

  useEffect(() => {
    if (!data) return;
    const id = setTimeout(() => setAnimateCharts(false), 700);
    return () => clearTimeout(id);
  }, [data]);

  const prefersReduced = useMemo(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    [],
  );
  const chartAnim = animateCharts && !prefersReduced;

  if (state === 'offline') return <div className="page page--wide"><OfflineNotice /></div>;

  if (loading && !data) {
    return (
      <div className="page page--wide">
        <div className="dash">
          <div className="skel dash-skel-banner" />
          <div className="dash-skel-grid">
            <div className="skel dash-skel-card" />
            <div className="skel dash-skel-card" />
            <div className="skel dash-skel-card" />
            <div className="skel dash-skel-card" />
          </div>
          <div className="skel dash-skel-panel" />
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="page page--wide">
        <h1>Dashboard</h1>
        <p className="error-text" role="alert">{error ?? 'The dashboard could not be loaded.'}</p>
        <button className="btn" onClick={() => setNonce((n) => n + 1)}>Try again</button>
      </div>
    );
  }

  const t = data.totals;
  const completionPct = t.trfTotal > 0 ? Math.round((t.trfCompleted / t.trfTotal) * 100) : 0;

  const firstName = employee?.fullName.split(' ')[0] ?? 'there';
  const greeting = greetingFor(new Date());
  const scopeText = data.scope === 'own'
    ? (data.showCoa ? "Your team's TRFs, tests and certificates." : "Your team's TRFs and tests.")
    : (data.showCoa ? 'Every TRF, test and certificate in the system.' : 'Every TRF and test in the system.');
  const statusKind = state === 'connected' ? 'connected' : 'checking';

  const heroes: HeroKpi[] = [
    { label: 'TRFs', value: t.trfTotal, tone: 'info', to: '#/trf', hint: 'All requests' },
    { label: 'Completed', value: t.trfCompleted, tone: 'ok', to: cardLink('trf', { workflowStatus: 'Completed' }), hint: 'Closed out', ringPct: completionPct },
    {
      label: 'Overdue',
      value: t.trfOverdue,
      tone: t.trfOverdue > 0 ? 'danger' : 'neutral',
      to: cardLink('trf', { overdueOnly: 'true' }),
      hint: t.trfOverdue > 0 ? 'Past due date' : 'Nothing overdue',
    },
    ...(data.showCoa
      ? [{ label: 'Certificates to issue', value: t.coaAwaitingIssue, tone: (t.coaAwaitingIssue > 0 ? 'warn' : 'neutral') as Tone, to: cardLink('coa', { status: 'Draft,Under Review,Approved' }), hint: 'Awaiting issue' }]
      : []),
  ];

  // The pipeline is the ARD Final Status (workflow_status), the same stages the
  // TRF list filters on, so every stage card opens the list with the same rows.
  const wfCount = (s: string) => data.trfStatus.find((x) => x.status === s)?.count ?? 0;
  const pipeline: StageCard[] = [
    { label: 'Received', value: wfCount('Received'), tone: 'neutral', to: cardLink('trf', { workflowStatus: 'Received' }) },
    { label: 'In Progress', value: wfCount('In Progress'), tone: 'info', to: cardLink('trf', { workflowStatus: 'In Progress' }) },
    { label: 'Completed', value: t.trfCompleted, tone: 'ok', to: cardLink('trf', { workflowStatus: 'Completed' }) },
    { label: 'Cancelled', value: wfCount('Cancelled'), tone: 'neutral', to: cardLink('trf', { workflowStatus: 'Cancelled' }) },
  ];

  const attention: AttentionItem[] = [
    ...(t.trfOverdue > 0
      ? [{ label: 'Overdue TRFs', count: t.trfOverdue, tone: 'danger' as const, to: cardLink('trf', { overdueOnly: 'true' }), icon: Icons.trf }]
      : []),
    ...(t.analysisDelayedTests > 0
      ? [{ label: 'Delayed tests', count: t.analysisDelayedTests, tone: 'warn' as const, to: canAccessModule('ard') ? '#/ard' : '', icon: Icons.ard }]
      : []),
    ...(data.showCoa && t.coaAwaitingIssue > 0
      ? [{ label: 'Certificates awaiting issue', count: t.coaAwaitingIssue, tone: 'warn' as const, to: cardLink('coa', { status: 'Draft,Under Review,Approved' }), icon: Icons.approvals }]
      : []),
  ];

  const rankedEmployees = [...data.trfByEmployee].sort(
    (a, b) => b.total - a.total || b.completed - a.completed,
  );
  const monthlyEmpty = data.monthlyTrfs.every((p) => p.count === 0);

  return (
    <div className="page page--wide">
      <div className="dash">
        <header className="dash-banner">
          <div className="dash-banner__main">
            <p className="dash-banner__greeting">{greeting}, {firstName}</p>
            <p className="dash-banner__scope">
              {employee ? `${employee.role} · ` : ''}{scopeText}
            </p>
          </div>
          <div className="dash-banner__figure">
            <strong>{t.trfTotal.toLocaleString()}</strong>
            <span>TRFs in scope</span>
          </div>
          <div className="dash-banner__actions">
            <span className={`server-badge server-badge--${statusKind}`} role="status">
              <span className="server-badge__dot" aria-hidden="true" />
              {state === 'connected' ? 'Connected' : 'Checking…'}
            </span>
            <button className="btn" onClick={() => setNonce((n) => n + 1)} disabled={loading}>Refresh</button>
          </div>
        </header>

        {error && <p className="error-text" role="alert">{error}</p>}

        <div className="kpi-grid">
          {heroes.map((card) => <Kpi key={card.label} card={card} />)}
        </div>

        <section aria-labelledby="dash-pipeline-title">
          <h2 id="dash-pipeline-title" className="dash__section-title">Pipeline</h2>
          <div className="flow">
            {pipeline.map((stage, i) => (
              <Fragment key={stage.label}>
                {i > 0 && <span className="flow__arrow" aria-hidden="true">→</span>}
                <Link
                  className={`flow__item flow__item--${stage.tone}`}
                  to={stage.to.replace('#', '')}
                  title={`Show the ${stage.label.toLowerCase()} list`}
                >
                  <span className="flow__dot" aria-hidden="true" />
                  <span className="flow__label">{stage.label}</span>
                  <span className="flow__value">{stage.value.toLocaleString()}</span>
                </Link>
              </Fragment>
            ))}
          </div>
        </section>

        {attention.length > 0 && (
          <section className="attention" aria-label="Needs attention">
            <span className="attention__title">Needs attention</span>
            <div className="attention__items">
              {attention.map((item) => {
                const inner = (
                  <>
                    <span aria-hidden="true">{item.icon}</span>
                    <strong>{item.count.toLocaleString()}</strong>
                    <span>{item.label}</span>
                  </>
                );
                return item.to ? (
                  <Link
                    key={item.label}
                    className={`attention__item attention__item--${item.tone}`}
                    to={item.to.replace('#', '')}
                    title={`Show all ${item.label.toLowerCase()}`}
                  >
                    {inner}
                  </Link>
                ) : (
                  <span key={item.label} className={`attention__item attention__item--${item.tone}`}>
                    {inner}
                  </span>
                );
              })}
            </div>
          </section>
        )}

        <div className="dash-grid">
          <Panel title="TRFs received, last 12 months">
            {monthlyEmpty ? (
              <p className="chart-empty">No TRFs in this period yet.</p>
            ) : (
              <>
                <p className="sr-only">
                  {`Monthly TRF receipts over the last 12 months; ${data.monthlyTrfs.reduce((s, p) => s + p.count, 0)} in total.`}
                </p>
                <ResponsiveContainer width="100%" height={240}>
                  <AreaChart data={data.monthlyTrfs} margin={{ top: 8, right: 12, bottom: 4, left: -18 }}>
                    <defs>
                      <linearGradient id="trfFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={CHART.primary} stopOpacity={0.2} />
                        <stop offset="100%" stopColor={CHART.primary} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke={CHART.grid} vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" axisLine={false} tickLine={false} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => [`${v} TRF${v === 1 ? '' : 's'}`, 'Received']} />
                    <Area type="monotone" dataKey="count" stroke={CHART.primary} strokeWidth={2} fill="url(#trfFill)" dot={false} activeDot={{ r: 4 }} isAnimationActive={chartAnim} animationDuration={500} />
                  </AreaChart>
                </ResponsiveContainer>
              </>
            )}
          </Panel>

          <Panel title="TRF status">
            <StatusBars data={data.trfStatus} palette={TRF_PALETTE} animate={chartAnim}
              linkFor={(s) => cardLink('trf', { workflowStatus: s })} />
          </Panel>

          <Panel title="Analysis status">
            <StatusBars data={data.analysisStatus} palette={ANALYSIS_PALETTE} animate={chartAnim}
              linkFor={canAccessModule('ard') ? () => '#/ard' : undefined} />
          </Panel>

          {data.showCoa && can('coa.view') && (
            <Panel title="Certificate status">
              <StatusBars data={data.coaStatus} palette={COA_PALETTE} animate={chartAnim}
                linkFor={(s) => cardLink('coa', { status: s })} />
            </Panel>
          )}
        </div>

        <Panel title={data.scope === 'own' ? 'Your analyst results' : 'Analyst results'}>
          {data.workload.length === 0 ? (
            <p className="chart-empty">No analyst results in this period yet.</p>
          ) : (
            <>
              <p className="sr-only">{analystSummary(data.workload)}</p>
              <div className="chart-scroll">
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={data.workload} margin={{ top: 8, right: 12, bottom: 4, left: -18 }}>
                    <CartesianGrid stroke={CHART.grid} vertical={false} />
                    <XAxis dataKey="employeeName" tick={{ fontSize: 11 }} interval={0} axisLine={false} tickLine={false} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: CHART.cursor }} />
                    <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="assigned" name="Assigned" stackId="work" fill={CHART.primarySoft} isAnimationActive={chartAnim} animationDuration={500} />
                    <Bar dataKey="inProgress" name="In progress" stackId="work" fill={CHART.primary} />
                    <Bar dataKey="delayed" name="Delayed" stackId="work" fill={CHART.amber} />
                    <Bar dataKey="passed" name="Completed, passed" stackId="done" fill={CHART.green} radius={[3, 3, 0, 0]} />
                    <Bar dataKey="failed" name="Completed, failed" stackId="done" fill={CHART.red} radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </Panel>

        <Panel title={data.scope === 'own' ? 'Your TRFs completed' : 'Completed by employee'}>
          {rankedEmployees.length === 0 ? (
            <p className="chart-empty">No TRFs assigned to anyone in this scope yet.</p>
          ) : (
            <ul className="emp-progress">
              {rankedEmployees.map((row) => {
                const pct = row.total > 0 ? Math.round((row.completed / row.total) * 100) : 0;
                return (
                  <li key={row.employeeId} className="emp-progress__row">
                    <span className="emp-progress__name" title={row.employeeName}>{row.employeeName}</span>
                    <span
                      className="emp-progress__bar"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={row.total}
                      aria-valuenow={row.completed}
                      aria-label={`${row.employeeName}: ${row.completed} of ${row.total} TRFs completed`}
                    >
                      <span className="emp-progress__fill" style={{ transform: `scaleX(${row.total > 0 ? row.completed / row.total : 0})` }} />
                    </span>
                    <span className="emp-progress__count"><strong>{row.completed}</strong> / {row.total} · {pct}%</span>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <footer className="dash-foot">
          <dl className="dash-foot__grid">
            <dt>Company server</dt><dd>{serverUrl}</dd>
            <dt>Database</dt><dd>{health?.database === 'connected' ? 'Connected' : 'Unavailable'}</dd>
            <dt>Server version</dt><dd>{health?.version ?? '—'}</dd>
            <dt>Figures as at</dt><dd>{new Date(data.generatedAt).toLocaleString()}</dd>
            <dt>Last refreshed</dt><dd>{lastChecked ? lastChecked.toLocaleTimeString() : '—'}</dd>
          </dl>
          {employee && (
            <p className="dash-foot__who">
              Signed in as {employee.fullName} ({employee.role}). Figures follow this account's access.
            </p>
          )}
        </footer>
      </div>
    </div>
  );
}

const TOOLTIP_STYLE = {
  borderRadius: 8,
  border: '1px solid var(--line)',
  fontSize: 12,
  boxShadow: '0 6px 16px rgba(44,24,18,.08)',
} as const;

// Series colours mirror the brand tokens in styles.css; recharts needs concrete values.
const CHART = {
  primary: '#6b3a2a', primarySoft: '#c9b6aa', navy: '#0a2a5c', blue: '#8fb4c6',
  clay: '#a9745f', green: '#2f7d4f', amber: '#b7791f', red: '#b3382c', mist: '#b9c6cc',
  grid: '#efe6df', cursor: 'rgba(107,58,42,.06)',
} as const;

const TRF_PALETTE: Record<string, string> = {
  Received: CHART.primarySoft, 'In Progress': CHART.primary, Completed: CHART.green, Cancelled: CHART.mist,
};
const ANALYSIS_PALETTE: Record<string, string> = {
  'Pending Assignment': CHART.primarySoft, Assigned: CHART.blue, 'In Progress': CHART.primary,
  Completed: CHART.green, 'Re-test Required': CHART.amber, Cancelled: CHART.mist,
};
const COA_PALETTE: Record<string, string> = {
  Pending: CHART.primarySoft, Draft: CHART.blue, 'Under Review': CHART.primary,
  Approved: CHART.amber, Issued: CHART.green,
};

type Tone = 'neutral' | 'info' | 'warn' | 'danger' | 'ok';
interface HeroKpi { label: string; value: number; tone: Tone; to: string; hint?: string; ringPct?: number }
interface StageCard { label: string; value: number; tone: Tone; to: string }
interface AttentionItem { label: string; count: number; tone: 'warn' | 'danger'; to: string; icon: JSX.Element }

function greetingFor(now: Date): string {
  const h = now.getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function analystSummary(rows: AnalystResultRow[]): string {
  const sum = rows.reduce((a, r) => ({
    assigned: a.assigned + r.assigned, inProgress: a.inProgress + r.inProgress,
    passed: a.passed + r.passed, failed: a.failed + r.failed, delayed: a.delayed + r.delayed,
  }), { assigned: 0, inProgress: 0, passed: 0, failed: 0, delayed: 0 });
  return `Analyst results across ${rows.length} people: ${sum.assigned} assigned, ${sum.inProgress} in progress, ${sum.passed} passed, ${sum.failed} failed, ${sum.delayed} delayed.`;
}

/** A headline tile that links to the list behind it; the Completed tile carries the ring. */
function Kpi({ card }: { card: HeroKpi }) {
  const inner = (
    <>
      <span className="kpi__label">{card.label}</span>
      <span className="kpi__row">
        <span className="kpi__value">{card.value.toLocaleString()}</span>
        {card.ringPct != null && (
          <span className="kpi-ring" style={{ ['--pct' as string]: `${card.ringPct * 3.6}deg` } as React.CSSProperties}
            role="img" aria-label={`${card.ringPct}% of TRFs completed`}>
            <span className="kpi-ring__hole">{card.ringPct}%</span>
          </span>
        )}
      </span>
      {card.hint && <span className="kpi__hint">{card.hint}</span>}
    </>
  );
  return (
    <Link className={`kpi kpi--${card.tone}`} to={card.to.replace('#', '')} title={`Show the ${card.label.toLowerCase()} list`}>
      {inner}
    </Link>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <h2 className="panel__title">{title}</h2>
      {children}
    </section>
  );
}

/**
 * A status mix as a horizontal bar chart plus a keyboard/AT-friendly legend.
 * The chart is aria-hidden; the legend buttons carry the same numbers and open
 * the matching filtered list, so the chart and its list cannot disagree and the
 * data is reachable without a pointer. Statuses at zero are left out.
 */
function StatusBars<T extends string>({ data, palette, linkFor, animate }: {
  data: StatusSlice<T>[];
  palette: Record<string, string>;
  linkFor?: (status: T) => string;
  animate: boolean;
}) {
  const navigate = useNavigate();
  const rows = data.filter((d) => d.count > 0);
  if (rows.length === 0) return <p className="chart-empty">Nothing recorded yet.</p>;
  return (
    <div className="breakdown">
      <div aria-hidden="true">
        <ResponsiveContainer width="100%" height={Math.min(260, rows.length * 34 + 16)}>
          <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 20, bottom: 4, left: 8 }}>
            <CartesianGrid stroke={CHART.grid} horizontal={false} />
            <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis type="category" dataKey="status" width={116} tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: CHART.cursor }} formatter={(v: number) => [v, 'Count']} />
            <Bar dataKey="count" radius={[0, 4, 4, 0]} isAnimationActive={animate} animationDuration={500}>
              {rows.map((row) => <Cell key={row.status} fill={palette[row.status] ?? CHART.primarySoft} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ul className="breakdown__legend">
        {rows.map((row) => (
          <li key={row.status}>
            {linkFor ? (
              <button
                type="button"
                className="breakdown__key"
                onClick={() => navigate(linkFor(row.status))}
                aria-label={`${row.status}: ${row.count}. Show the list.`}
              >
                <span className="breakdown__dot" style={{ background: palette[row.status] ?? CHART.primarySoft }} aria-hidden="true" />
                <span className="breakdown__label">{row.status}</span>
                <span className="breakdown__count">{row.count}</span>
              </button>
            ) : (
              <span className="breakdown__key">
                <span className="breakdown__dot" style={{ background: palette[row.status] ?? CHART.primarySoft }} aria-hidden="true" />
                <span className="breakdown__label">{row.status}</span>
                <span className="breakdown__count">{row.count}</span>
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}