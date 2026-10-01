import { useEffect, useMemo, useState } from 'react';
import type { ExportSheetName } from '@trf/shared';
import { EXPORT_ROW_LIMIT, sheetsFor } from '@trf/shared';
import { messageOf } from '../lib/api';
import { useAuth } from '../lib/auth';
import { OfflineNotice } from '../components/OfflineNotice';
import { useServerStatus } from '../lib/server-status';
import { ExportButton } from '../components/ExportButton';

interface ExportOptions {
  sheets: ExportSheetName[];
  scope: 'all' | 'own';
  rowLimit: number;
}

const SHEET_NOTES: Record<ExportSheetName, string> = {
  'TRF Master': 'Every request with its status, due date and the people involved.',
  Analysis: 'Test results with their outcome and the delay flag.',
  Assignments: 'Who holds which test, and what is overdue.',
  Employees: 'Employee records. Managers and administrators only.',
  COA: 'Certificates with their preparation, approval and issue trail.',
  'Dashboard Data': 'The counts behind the dashboard, scope-aware.',
  'Audit Log': 'Who changed what, and when. Managers and administrators only.',
};

/**
 * One place to build a report, rather than hunting for the right button. Each sheet
 * keeps the filters the matching list uses, so a saved file can be reproduced.
 * The server decides what the role may see; this page only asks and reports.
 */
export function ReportsPage() {
  const { can, employee } = useAuth();
  const { state } = useServerStatus();
  const allowed = can('reports.export');

  const [options, setOptions] = useState<ExportOptions | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [trfNumber, setTrfNumber] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [dueFrom, setDueFrom] = useState('');
  const [dueTo, setDueTo] = useState('');
  const [delayedOnly, setDelayedOnly] = useState(false);
  const [overdueOnly, setOverdueOnly] = useState(false);

  useEffect(() => {
    if (!allowed || state === 'offline') return;
    let cancelled = false;
    void window.trf.request<ExportOptions>({ method: 'GET', path: '/api/reports/export-options' })
      .then((res) => {
        if (cancelled) return;
        if (!res.ok || !res.data) {
          setError(messageOf(res.data, 'The available reports could not be read.'));
          return;
        }
        setOptions(res.data);
      });
    return () => { cancelled = true; };
  }, [allowed, state, employee?.id]);

  const filters = useMemo(() => ({
    search, status, trfNumber,
    employeeId: employeeId || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    dueFrom: dueFrom || undefined,
    dueTo: dueTo || undefined,
    delayedOnly, overdueOnly,
  }), [search, status, trfNumber, employeeId, dateFrom, dateTo, dueFrom, dueTo, delayedOnly, overdueOnly]);

  if (!allowed) {
    return (
      <div className="page">
        <div className="page__head"><h1>Reports</h1></div>
        <div className="notice">
          <strong>You do not have permission to export reports.</strong>
          <p className="muted">Ask a manager or administrator if you need this.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page page--wide">
      <div className="page__head">
        <h1>Reports</h1>
        <p className="muted">Save the filtered data as an Excel workbook. Nothing is written until you choose a location.</p>
      </div>

      {state === 'offline' && <OfflineNotice />}
      {error && <p className="error-text" role="alert">{error}</p>}

      <div className="filters">
        <input placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search report data" />
        <input placeholder="Status" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status" />
        <input placeholder="TRF number" value={trfNumber} onChange={(e) => setTrfNumber(e.target.value)} aria-label="Filter by TRF number" />
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} aria-label="From date" />
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} aria-label="To date" />
        <label className="filters__check">
          <input type="checkbox" checked={delayedOnly} onChange={(e) => setDelayedOnly(e.target.checked)} /> Delayed only
        </label>
        <label className="filters__check">
          <input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} /> Overdue only
        </label>
        <button className="btn btn--ghost" onClick={() => {
          setSearch(''); setStatus(''); setTrfNumber(''); setEmployeeId('');
          setDateFrom(''); setDateTo(''); setDueFrom(''); setDueTo('');
          setDelayedOnly(false); setOverdueOnly(false);
        }}>Clear filters</button>
      </div>

      {!options && <p className="muted">Loading…</p>}

      {options && (
        <>
          <p className="muted">
            {options.scope === 'own'
              ? 'Reports include only your own work.'
              : 'Reports include all records you are allowed to see.'}
            {' '}Each sheet holds up to {options.rowLimit.toLocaleString()} rows.
          </p>
          <div className="report-grid">
            {options.sheets.map((sheet) => (
              <div className="report-card" key={sheet}>
                <h2>{sheet}</h2>
                <p className="muted">{SHEET_NOTES[sheet]}</p>
                <ExportButton filters={filters} sheet={sheet} label={`Save ${sheet}`} />
              </div>
            ))}
          </div>
          <p className="muted">
            The whole workbook ({sheetsFor(options.scope).join(', ')}) can also be saved as one file.
          </p>
          <ExportButton filters={filters} label="Save the full workbook" />
        </>
      )}
    </div>
  );
}