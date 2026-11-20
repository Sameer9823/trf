import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { DashboardCard, DashboardPayload, StatusSlice } from '@trf/shared';
import { cardLink, loadDashboard } from '../lib/dashboard';
import { useAuth } from '../lib/auth';
import { useServerStatus } from '../lib/server-status';
import { OfflineNotice } from '../components/OfflineNotice';
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, ResponsiveContainer,
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
  const cards: DashboardCard[] = [
    { label: 'TRFs', total: t.trfTotal, tone: 'neutral', to: '#/trf' },
    { label: 'New', total: t.trfNew, tone: 'info', to: cardLink('trf', { status: 'New' }) },
    { label: 'Assigned', total: t.trfAssigned, tone: 'info', to: cardLink('trf', { status: 'Assigned' }) },
    { label: 'In Progress', total: t.trfInProgress, tone: 'info', to: cardLink('trf', { status: 'In Progress' }) },
    {
      label: 'Analysis Completed', total: t.trfAnalysisCompleted, tone: 'neutral',
      to: cardLink('trf', { status: 'Analysis Completed' }),
    },
    {
      label: 'COA Pending', total: t.trfCoaPending, tone: 'warn',
      to: cardLink('trf', { status: 'COA Pending' }),
    },
    {
      label: 'Completed', total: t.trfCompleted, tone: 'ok',
      to: cardLink('trf', { status: 'Completed' }),
    },
    {
      label: 'Overdue', total: t.trfOverdue, tone: t.trfOverdue > 0 ? 'danger' : 'neutral',
      to: cardLink('trf', { overdueOnly: 'true' }),
      hint: 'Due date passed and not finished',
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
    {
      label: 'Certificates to issue', total: t.coaAwaitingIssue, tone: 'warn',
      to: cardLink('coa', { status: 'Draft,Under Review,Approved' }),
    },
    {
      label: 'Certificates issued', total: t.coaIssued, tone: 'ok',
      to: cardLink('coa', { status: 'Issued' }),
    },
  ];

  return (
    <div className="page page--wide">
      <div className="page__head">
        <div>
          <h1>Dashboard</h1>
          <p className="muted">
            {data.scope === 'own'
              ? 'Showing the TRFs, tests and certificates you are involved in.'
              : 'Showing every TRF, test and certificate in the system.'}
          </p>
        </div>
        <div className="row">
          <button className="btn" onClick={() => setNonce((n) => n + 1)} disabled={loading}>Refresh</button>
        </div>
      </div>

      {error && <p className="error-text" role="alert">{error}</p>}

      <div className="stat-row stat-row--wrap">
        {cards.map((card) => (
          <Card key={card.label} card={card} />
        ))}
      </div>

      {t.trfTotal === 0 && (
        <div className="notice">
          <strong>Nothing to show yet.</strong> Create a TRF, or wait for work to be assigned, and this page fills in on its own.
        </div>
      )}

      <div className="dash-grid">
        <Panel title="TRFs received, last 12 months">
          <ResponsiveContainer width="100%" height={230}>
            <LineChart data={data.monthlyTrfs} margin={{ top: 8, right: 12, bottom: 4, left: -18 }}>
              <CartesianGrid stroke="#e3e9ec" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v: number) => [`${v} TRF${v === 1 ? '' : 's'}`, 'Received']} />
              <Line type="monotone" dataKey="count" stroke="#1f6f8b" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="TRF status">
          <StatusChart data={data.trfStatus} palette={TRF_PALETTE} linkFor={(s) => cardLink('trf', { status: s })} />
        </Panel>

        <Panel title="Analysis status">
          <StatusChart data={data.analysisStatus} palette={ANALYSIS_PALETTE}
            linkFor={(s) => cardLink('analysis', { status: s })} />
        </Panel>

        {can('coa.view') && (
          <Panel title="Certificate status">
            <StatusChart data={data.coaStatus} palette={COA_PALETTE} linkFor={(s) => cardLink('coa', { status: s })} />
          </Panel>
        )}
      </div>

      {data.workload.length > 0 && (
        <Panel title={data.scope === 'own' ? 'Your work' : 'Analyst workload'}>
          <div className="chart-scroll">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={data.workload} margin={{ top: 8, right: 12, bottom: 4, left: -18 }}>
                <CartesianGrid stroke="#e3e9ec" vertical={false} />
                <XAxis dataKey="employeeName" tick={{ fontSize: 11 }} interval={0} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Legend />
                <Bar dataKey="assigned" name="Assigned" stackId="work" fill="#8fb4c6" />
                <Bar dataKey="inProgress" name="In progress" stackId="work" fill="#1f6f8b" />
                <Bar dataKey="delayed" name="Delayed" stackId="work" fill="#c9821b" />
                <Bar dataKey="passed" name="Completed, passed" stackId="done" fill="#2e7d5b" />
                <Bar dataKey="failed" name="Completed, failed" stackId="done" fill="#b3382c" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      )}

      <h2>Connection</h2>
      <dl className="facts">
        <dt>Company server</dt><dd>{serverUrl}</dd>
        <dt>Status</dt><dd>{state === 'checking' ? 'Checking…' : 'Connected'}</dd>
        <dt>Database</dt><dd>{health?.database === 'connected' ? 'Connected' : 'Unavailable'}</dd>
        <dt>Server version</dt><dd>{health?.version ?? '—'}</dd>
        <dt>Figures as at</dt><dd>{new Date(data.generatedAt).toLocaleString()}</dd>
        <dt>Last checked</dt><dd>{lastChecked ? lastChecked.toLocaleTimeString() : '—'}</dd>
      </dl>

      {employee && (
        <p className="muted">
          Signed in as {employee.fullName} ({employee.role}). Figures follow this account's access.
        </p>
      )}
    </div>
  );
}

/** A card is a link whenever there is a list behind it; otherwise it is just a number. */
function Card({ card }: { card: DashboardCard }) {
  const inner = (
    <>
      <span className={`stat__value stat__value--${card.tone}`}>{card.total}</span>
      <span className="stat__label">{card.label}</span>
      {card.hint && <span className="stat__hint">{card.hint}</span>}
    </>
  );
  if (!card.to) return <div className="stat">{inner}</div>;
  return (
    <Link className="stat stat--link" to={card.to.replace('#', '')} title={`Show the ${card.label.toLowerCase()} list`}>
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
 * A bar per status, coloured by meaning. Clicking a bar opens the list that
 * produced it with the same status filter, so a chart and its list cannot
 * describe different things. Statuses at zero are left out of the drawing: the
 * server still sends them, so the response stays complete for any other client,
 * but a bar of length zero says nothing on screen.
 */
function StatusChart<T extends string>({
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
    <ResponsiveContainer width="100%" height={Math.max(160, rows.length * 34)}>
      <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 24, bottom: 4, left: 24 }}>
        <CartesianGrid stroke="#e3e9ec" horizontal={false} />
        <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
        <YAxis type="category" dataKey="status" width={124} tick={{ fontSize: 11 }} />
        <Tooltip formatter={(v: number) => [`${v}`, 'Count']} cursor={{ fill: 'rgba(31,111,139,.08)' }} />
        <Bar
          dataKey="count"
          radius={[0, 3, 3, 0]}
          onClick={(entry: unknown) => {
            const status = (entry as { status?: T } | undefined)?.status;
            if (status) navigate(linkFor(status));
          }}
        >
          {rows.map((row) => <Cell key={row.status} fill={palette[row.status] ?? '#8fb4c6'} cursor="pointer" />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// Colours carry meaning here: blue is work in hand, amber is late, green is done.
const TRF_PALETTE: Record<string, string> = {
  New: '#b9c6cc', Assigned: '#8fb4c6', 'In Progress': '#1f6f8b',
  'Analysis Completed': '#5c9bb0', 'COA Pending': '#c9821b', Completed: '#2e7d5b', Cancelled: '#9aa7ad',
};

const ANALYSIS_PALETTE: Record<string, string> = {
  Pending: '#b9c6cc', Assigned: '#8fb4c6', 'In Progress': '#1f6f8b',
  Completed: '#2e7d5b', 'Re-test Required': '#c9821b', Cancelled: '#9aa7ad',
};

const COA_PALETTE: Record<string, string> = {
  Pending: '#b9c6cc', Draft: '#8fb4c6', 'Under Review': '#1f6f8b',
  Approved: '#c9821b', Issued: '#2e7d5b',
};