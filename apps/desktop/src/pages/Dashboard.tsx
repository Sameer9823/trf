import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { DashboardCard, DashboardPayload, StatusSlice } from '@trf/shared';
import { cardLink, loadDashboard } from '../lib/dashboard';
import { useAuth } from '../lib/auth';
import { useServerStatus } from '../lib/server-status';
import { OfflineNotice } from '../components/OfflineNotice';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';

/**
 * Every figure on this page is counted by the server over the scope of the
 * signed-in role. Nothing is totalled in the browser, so a card and the list it
 * opens can never disagree.
 */
export function Dashboard() {
  const { state, health, serverUrl, lastChecked } = useServerStatus();
  const { employee, can } = useAuth();
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

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

  if (state === 'offline') return <div className="page page--wide"><OfflineNotice /></div>;

  if (loading && !data) {
    return <div className="page page--wide"><p className="muted">Loading the dashboard…</p></div>;
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

  const primary: DashCard[] = [
    { label: 'TRFs', total: t.trfTotal, tone: 'info', to: '#/trf', hint: 'All requests' },
    { label: 'Completed', total: t.trfCompleted, tone: 'ok', to: cardLink('trf', { status: 'Completed' }), hint: 'Closed out' },
    {
      label: 'Overdue', total: t.trfOverdue, tone: t.trfOverdue > 0 ? 'danger' : 'neutral',
      to: cardLink('trf', { overdueOnly: 'true' }), hint: 'Past due date',
    },
    {
      label: 'Certificates to issue', total: t.coaAwaitingIssue,
      tone: t.coaAwaitingIssue > 0 ? 'warn' : 'neutral',
      to: cardLink('coa', { status: 'Draft,Under Review,Approved' }), hint: 'Awaiting issue',
    },
  ];

  const pipeline: DashCard[] = [
    { label: 'New', total: t.trfNew, tone: 'neutral', to: cardLink('trf', { status: 'New' }) },
    { label: 'Assigned', total: t.trfAssigned, tone: 'info', to: cardLink('trf', { status: 'Assigned' }) },
    { label: 'In Progress', total: t.trfInProgress, tone: 'info', to: cardLink('trf', { status: 'In Progress' }) },
    {
      label: 'Analysis Completed', total: t.trfAnalysisCompleted, tone: 'neutral',
      to: cardLink('trf', { status: 'Analysis Completed' }),
    },
    {
      label: 'COA Pending', total: t.trfCoaPending, tone: t.trfCoaPending > 0 ? 'warn' : 'neutral',
      to: cardLink('trf', { status: 'COA Pending' }),
    },
    {
      label: 'Open tests', total: t.analysisOpenTests, tone: 'info',
      to: cardLink('analysis', { status: 'Assigned,In Progress,Re-test Required' }),
    },
    {
      label: 'Delayed tests', total: t.analysisDelayedTests,
      tone: t.analysisDelayedTests > 0 ? 'warn' : 'neutral',
      to: cardLink('analysis', { delayedOnly: 'true' }),
    },
    { label: 'Certificates issued', total: t.coaIssued, tone: 'ok', to: cardLink('coa', { status: 'Issued' }) },
  ];

  const attention: DashCard[] = [
    ...(t.trfOverdue > 0
      ? [{ label: 'overdue', total: t.trfOverdue, tone: 'danger' as const, to: cardLink('trf', { overdueOnly: 'true' }) }]
      : []),
    ...(t.trfCoaPending > 0
      ? [{ label: 'COA pending', total: t.trfCoaPending, tone: 'warn' as const, to: cardLink('trf', { status: 'COA Pending' }) }]
      : []),
    ...(t.analysisDelayedTests > 0
      ? [{ label: 'delayed tests', total: t.analysisDelayedTests, tone: 'warn' as const, to: cardLink('analysis', { delayedOnly: 'true' }) }]
      : []),
  ];

  return (
    <div className="page page--wide">
      <div className="dash">
        <header className="dash__head">
          <div>
            <h1 className="dash__title">Dashboard</h1>
            <p className="dash__scope">
              {data.scope === 'own'
                ? 'The TRFs, tests and certificates you are involved in.'
                : 'Every TRF, test and certificate in the system.'}
            </p>
          </div>
          <button className="btn" onClick={() => setNonce((n) => n + 1)} disabled={loading}>Refresh</button>
        </header>

        {error && <p className="error-text" role="alert">{error}</p>}

        {attention.length > 0 && (
          <section className="attention" aria-label="Needs attention">
            <span className="attention__title">Needs attention</span>
            <div className="attention__items">
              {attention.map((item) => (
                <Link
                  key={item.label}
                  className={`attention__item attention__item--${item.tone}`}
                  to={item.to.replace('#', '')}
                >
                  <strong>{item.total.toLocaleString()}</strong>
                  <span>{item.label}</span>
                </Link>
              ))}
            </div>
          </section>
        )}

        <div className="kpi-grid">
          {primary.map((card) => (
            <Kpi key={card.label} card={card} />
          ))}
        </div>

        {t.trfTotal === 0 && (
          <div className="notice">
            <strong>Nothing to show yet.</strong> Create a TRF, or wait for work to be assigned, and this page fills in on its own.
          </div>
        )}

        <section aria-labelledby="dash-pipeline-title">
          <h2 id="dash-pipeline-title" className="dash__section-title">Pipeline</h2>
          <div className="pipeline">
            {pipeline.map((card) => (
              <Link
                key={card.label}
                className={`pipeline__item pipeline__item--${card.tone}`}
                to={card.to.replace('#', '')}
                title={`Show the ${card.label.toLowerCase()} list`}
              >
                <span className="pipeline__dot" aria-hidden="true" />
                <span className="pipeline__label">{card.label}</span>
                <span className="pipeline__value">{card.total.toLocaleString()}</span>
              </Link>
            ))}
          </div>
        </section>

        <div className="dash-grid">
          <Panel title="TRFs received, last 12 months">
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={data.monthlyTrfs} margin={{ top: 8, right: 12, bottom: 4, left: -18 }}>
                <defs>
                  <linearGradient id="trfFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#6b3a2a" stopOpacity={0.2} />
                    <stop offset="100%" stopColor="#6b3a2a" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#efe6df" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" axisLine={false} tickLine={false} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(v: number) => [`${v} TRF${v === 1 ? '' : 's'}`, 'Received']}
                />
                <Area
                  type="monotone" dataKey="count" stroke="#6b3a2a" strokeWidth={2}
                  fill="url(#trfFill)" dot={false} activeDot={{ r: 4 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </Panel>

          <Panel title="TRF status">
            <StatusBreakdown data={data.trfStatus} palette={TRF_PALETTE} linkFor={(s) => cardLink('trf', { status: s })} />
          </Panel>

          <Panel title="Analysis status">
            <StatusBreakdown data={data.analysisStatus} palette={ANALYSIS_PALETTE}
              linkFor={(s) => cardLink('analysis', { status: s })} />
          </Panel>

          {can('coa.view') && (
            <Panel title="Certificate status">
              <StatusBreakdown data={data.coaStatus} palette={COA_PALETTE} linkFor={(s) => cardLink('coa', { status: s })} />
            </Panel>
          )}
        </div>

        {data.workload.length > 0 && (
          <Panel title={data.scope === 'own' ? 'Your work' : 'Analyst workload'}>
            <div className="chart-scroll">
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={data.workload} margin={{ top: 8, right: 12, bottom: 4, left: -18 }}>
                  <CartesianGrid stroke="#efe6df" vertical={false} />
                  <XAxis dataKey="employeeName" tick={{ fontSize: 11 }} interval={0} axisLine={false} tickLine={false} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(107,58,42,.06)' }} />
                  <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="assigned" name="Assigned" stackId="work" fill="#c9b6aa" />
                  <Bar dataKey="inProgress" name="In progress" stackId="work" fill="#6b3a2a" />
                  <Bar dataKey="delayed" name="Delayed" stackId="work" fill="#b7791f" />
                  <Bar dataKey="passed" name="Completed, passed" stackId="done" fill="#2f7d4f" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="failed" name="Completed, failed" stackId="done" fill="#b3382c" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Panel>
        )}

        <footer className="dash-foot">
          <dl className="dash-foot__grid">
            <dt>Company server</dt><dd>{serverUrl}</dd>
            <dt>Status</dt><dd>{state === 'checking' ? 'Checking…' : 'Connected'}</dd>
            <dt>Database</dt><dd>{health?.database === 'connected' ? 'Connected' : 'Unavailable'}</dd>
            <dt>Server version</dt><dd>{health?.version ?? '—'}</dd>
            <dt>Figures as at</dt><dd>{new Date(data.generatedAt).toLocaleString()}</dd>
            <dt>Last checked</dt><dd>{lastChecked ? lastChecked.toLocaleTimeString() : '—'}</dd>
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

/** A tile that always links to the list behind it. */
type DashCard = DashboardCard & { to: string };

/** A headline tile: the number is the point, the label and hint give it context. */
function Kpi({ card }: { card: DashboardCard }) {
  const inner = (
    <>
      <span className="kpi__label">{card.label}</span>
      <span className="kpi__value">{card.total.toLocaleString()}</span>
      {card.hint && <span className="kpi__hint">{card.hint}</span>}
    </>
  );
  if (!card.to) return <div className={`kpi kpi--${card.tone}`}>{inner}</div>;
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
 * A status mix as one proportional bar plus a clickable legend. Clicking a row
 * opens the list that produced it with the same status filter, so a chart and
 * its list cannot describe different things. Statuses at zero are left out: the
 * server still sends them, but a zero-length segment says nothing on screen.
 */
function StatusBreakdown<T extends string>({
  data, palette, linkFor,
}: {
  data: StatusSlice<T>[];
  palette: Record<string, string>;
  linkFor: (status: T) => string;
}) {
  const navigate = useNavigate();
  const rows = data.filter((d) => d.count > 0);
  if (rows.length === 0) {
    return <p className="muted chart-empty">Nothing recorded yet.</p>;
  }
  return (
    <div className="breakdown">
      <div className="breakdown__bar" aria-hidden="true">
        {rows.map((row) => (
          <span
            key={row.status}
            className="breakdown__seg"
            style={{ flexGrow: row.count, background: palette[row.status] ?? '#c9b6aa' }}
          />
        ))}
      </div>
      <ul className="breakdown__legend">
        {rows.map((row) => (
          <li key={row.status}>
            <button
              type="button"
              className="breakdown__key"
              onClick={() => navigate(linkFor(row.status))}
              aria-label={`${row.status}: ${row.count}. Show the list.`}
            >
              <span className="breakdown__dot" style={{ background: palette[row.status] ?? '#c9b6aa' }} aria-hidden="true" />
              <span className="breakdown__label">{row.status}</span>
              <span className="breakdown__count">{row.count}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Colours carry meaning here: blue is work in hand, amber is late, green is done.
const TRF_PALETTE: Record<string, string> = {
  New: '#c9b6aa', Assigned: '#8fb4c6', 'In Progress': '#6b3a2a',
  'Analysis Completed': '#a9745f', 'COA Pending': '#b7791f', Completed: '#2f7d4f', Cancelled: '#b9c6cc',
};

const ANALYSIS_PALETTE: Record<string, string> = {
  Pending: '#c9b6aa', Assigned: '#8fb4c6', 'In Progress': '#6b3a2a',
  Completed: '#2f7d4f', 'Re-test Required': '#b7791f', Cancelled: '#b9c6cc',
};

const COA_PALETTE: Record<string, string> = {
  Pending: '#c9b6aa', Draft: '#8fb4c6', 'Under Review': '#6b3a2a',
  Approved: '#b7791f', Issued: '#2f7d4f',
};