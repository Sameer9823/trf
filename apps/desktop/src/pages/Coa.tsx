import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Coa, CoaSortField, CoaStatus, CoaSummary, TrfStatus } from '@trf/shared';
import {
  COA_SORTS, COA_STATUS_OPTIONS, OFFLINE, coaApi, coaStatusTone, toCoaQuery,
} from '../lib/coa';
import { useAuth } from '../lib/auth';
import { useServerStatus } from '../lib/server-status';
import { OfflineNotice } from '../components/OfflineNotice';
import { StatusBadge, formatDate } from '../components/Badges';
import { Certificate } from '../components/Certificate';
import { ExportButton } from '../components/ExportButton';

const STEP_LABEL: Record<CoaStatus, string> = {
  Pending: 'Not started',
  Draft: 'Drafted',
  'Under Review': 'Under review',
  Approved: 'Approved',
  Issued: 'Issued',
};

export function CoaPage() {
  const { state } = useServerStatus();
  const { can, employee } = useAuth();
  const [params, setParams] = useSearchParams();

  const [items, setItems] = useState<Coa[]>([]);
  const [summary, setSummary] = useState<CoaSummary | null>(null);
  const [total, setTotal] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Coa | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [nonce, setNonce] = useState(0);

  const filters = useMemo(() => ({
    search: params.get('search') ?? '',
    status: params.get('status') ? params.get('status')!.split(',') : [],
    trfNumber: params.get('trfNumber') ?? '',
    dateFrom: params.get('dateFrom') ?? undefined,
    dateTo: params.get('dateTo') ?? undefined,
    mineOnly: params.get('mineOnly') === 'true',
    sortBy: (params.get('sortBy') ?? 'createdAt') as CoaSortField,
    sortDir: (params.get('sortDir') ?? 'desc') as 'asc' | 'desc',
  }), [params]);

  const page = Number(params.get('page') ?? 1);

  const setFilter = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (!value || value === 'false') next.delete(key); else next.set(key, value);
    next.delete('page');
    setParams(next, { replace: true });
  };

  const toggleSort = (field: CoaSortField) => {
    const next = new URLSearchParams(params);
    next.set('sortBy', field);
    next.set('sortDir', filters.sortBy === field && filters.sortDir === 'desc' ? 'asc' : 'desc');
    next.delete('page');
    setParams(next, { replace: true });
  };

  const goToPage = (target: number) => {
    const next = new URLSearchParams(params);
    if (target <= 1) next.delete('page'); else next.set('page', String(target));
    setParams(next, { replace: true });
  };

  const query = useMemo(() => toCoaQuery({ ...filters, page }), [filters, page]);

  useEffect(() => {
    if (state === 'offline') { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    void coaApi.list(query).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (!res.ok || !res.data) { setError(res.message ?? OFFLINE); return; }
      setError(null);
      setItems(res.data.items);
      setTotal(res.data.total);
      setPageCount(res.data.pageCount);
    });
    return () => { cancelled = true; };
  }, [query, state, nonce]);

  useEffect(() => {
    if (state === 'offline') return;
    let cancelled = false;
    void coaApi.summary(query).then((res) => { if (!cancelled) setSummary(res); });
    return () => { cancelled = true; };
  }, [query, state, nonce]);

  if (state === 'offline') return <div className="page page--wide"><OfflineNotice /></div>;

  const refresh = () => setNonce((n) => n + 1);
  const onChanged = (coa: Coa) => {
    setOpen(coa);
    setItems((current) => current.map((c) => (c.id === coa.id ? coa : c)));
    refresh();
  };

  return (
    <div className="page page--wide">
      <div className="page__head">
        <h1>Certificates of Analysis</h1>
        <div className="row">
          {can('coa.prepare') && (
            <button className="btn btn--primary" onClick={() => setDrafting(true)}>Draft a certificate</button>
          )}
          <ExportButton
            label="Export to Excel"
            sheet="COA"
            filters={{
              search: filters.search,
              status: filters.status.join(','),
              trfNumber: filters.trfNumber,
              dateFrom: filters.dateFrom,
              dateTo: filters.dateTo,
            }}
          />
        </div>
      </div>

      {summary && (
        <div className="stat-row">
          <Stat label="Certificates" value={summary.total} />
          <Stat label="Drafts" value={summary.draft} />
          <Stat label="Under review" value={summary.underReview} tone="warn" />
          <Stat label="Approved" value={summary.approved} />
          <Stat label="Issued" value={summary.issued} tone="ok" />
        </div>
      )}

      <div className="filters">
        <input placeholder="Search COA No., TRF, batch, product or customer" value={filters.search}
          onChange={(e) => setFilter('search', e.target.value)} aria-label="Search certificates" />
        <select value={filters.status.join(',')} onChange={(e) => setFilter('status', e.target.value || null)} aria-label="Filter by status">
          <option value="">All statuses</option>
          {COA_STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <input placeholder="TRF number" value={filters.trfNumber}
          onChange={(e) => setFilter('trfNumber', e.target.value)} aria-label="Filter by TRF number" />
        <input type="date" value={filters.dateFrom ?? ''} onChange={(e) => setFilter('dateFrom', e.target.value || null)}
          aria-label="Created from" />
        <input type="date" value={filters.dateTo ?? ''} onChange={(e) => setFilter('dateTo', e.target.value || null)}
          aria-label="Created to" />
        <label className="filters__check">
          <input type="checkbox" checked={filters.mineOnly}
            onChange={(e) => setFilter('mineOnly', e.target.checked ? 'true' : null)} />
          Mine only
        </label>
      </div>

      {error && <p className="error-text" role="alert">{error}</p>}

      <table className="table">
        <thead>
          <tr>
            <SortHeader label="COA No." field="coaNumber" current={filters.sortBy} dir={filters.sortDir} onSort={toggleSort} />
            <SortHeader label="TRF No." field="trfNumber" current={filters.sortBy} dir={filters.sortDir} onSort={toggleSort} />
            <SortHeader label="Customer" field="customerName" current={filters.sortBy} dir={filters.sortDir} onSort={toggleSort} />
            <th>Product / Batch</th>
            <th>Results</th>
            <SortHeader label="Status" field="status" current={filters.sortBy} dir={filters.sortDir} onSort={toggleSort} />
            <SortHeader label="Issued" field="issuedAt" current={filters.sortBy} dir={filters.sortDir} onSort={toggleSort} />
            <th aria-label="Open" />
          </tr>
        </thead>
        <tbody>
          {loading && <tr><td colSpan={8} className="muted">Loading…</td></tr>}
          {!loading && items.length === 0 && (
            <tr><td colSpan={8} className="muted">No certificates match these filters.</td></tr>
          )}
          {!loading && items.map((coa) => (
            <tr key={coa.id}>
              <td><strong>{coa.coaNumber ?? '—'}</strong></td>
              <td><a className="link" href={`#/trfs/${coa.trfId}`}>{coa.trfNumber}</a></td>
              <td>{coa.customerName ?? '—'}</td>
              <td>
                {coa.productName ?? '—'}
                <div className="muted">{coa.batchNumber ?? ''}</div>
              </td>
              <td>
                {coa.counts.total} test(s)
                {coa.counts.failed > 0 && (
                  <div><span className="badge badge--danger">{coa.counts.failed} failed</span></div>
                )}
              </td>
              <td><span className={`badge ${coaStatusTone(coa.status)}`}>{coa.status}</span></td>
              <td>{coa.issuedBy.at ? formatDate(coa.issuedBy.at.slice(0, 10)) : '—'}</td>
              <td><button className="btn btn--ghost" onClick={() => setOpen(coa)}>Open</button></td>
            </tr>
          ))}
        </tbody>
      </table>

      {!loading && (
        <div className="pager">
          <span className="muted">{total} certificate(s)</span>
          <span className="row">
            <button className="btn" disabled={page <= 1} onClick={() => goToPage(page - 1)}>Previous</button>
            <button className="btn" disabled={page >= pageCount} onClick={() => goToPage(page + 1)}>Next</button>
          </span>
        </div>
      )}

      {open && <CoaDetail coa={open} onClose={() => setOpen(null)} onChanged={onChanged} />}
      {drafting && (
        <DraftDialog
          onClose={() => setDrafting(false)}
          onDrafted={(coa) => { setDrafting(false); setOpen(coa); refresh(); }}
        />
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'ok' | 'warn' | 'danger' }) {
  return (
    <div className="stat">
      <span className={`stat__value ${tone ? `stat__value--${tone}` : ''}`}>{value}</span>
      <span className="stat__label">{label}</span>
    </div>
  );
}

function SortHeader({ label, field, current, dir, onSort }: {
  label: string; field: CoaSortField; current: CoaSortField; dir: 'asc' | 'desc';
  onSort: (field: CoaSortField) => void;
}) {
  const active = current === field;
  return (
    <th>
      <button className="th-sort" onClick={() => onSort(field)}
        aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
        {label}{active ? <span aria-hidden="true">{dir === 'asc' ? ' ▲' : ' ▼'}</span> : null}
      </button>
    </th>
  );
}

/** Drafting needs a TRF that has finished its analysis, so the list is the way in. */
function DraftDialog({ onClose, onDrafted }: { onClose: () => void; onDrafted: (coa: Coa) => void }) {
  const [trfNumber, setTrfNumber] = useState('');
  const [candidates, setCandidates] = useState<{ id: number; trfNumber: string; status: TrfStatus; productName: string | null }[]>([]);
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Only TRFs that have finished analysis can carry a certificate.
    void window.trf.request<{ items: { id: number; trfNumber: string; status: TrfStatus; productName: string | null }[] }>({
      method: 'GET', path: '/api/trfs?status=Analysis%20Completed,COA%20Pending&pageSize=100',
    }).then((res) => { if (res.ok && res.data) setCandidates(res.data.items); });
  }, []);

  const matches = candidates.filter((c) =>
    !trfNumber.trim() || c.trfNumber.toLowerCase().includes(trfNumber.trim().toLowerCase()));

  async function submit(trfId: number) {
    setBusy(true);
    setError(null);
    const res = await coaApi.draft(trfId, remarks.trim() || null);
    setBusy(false);
    if (!res.ok || !res.data) { setError(res.message ?? 'The certificate could not be drafted.'); return; }
    onDrafted(res.data);
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Draft a certificate">
      <div className="modal">
        <h2>Draft a certificate</h2>
        <p className="muted">
          Only TRFs whose analysis is complete can have one. The results are copied onto the
          certificate at this moment and do not change afterwards.
        </p>
        {error && <p className="error-text" role="alert">{error}</p>}
        <label className="field">
          <span>Find the TRF</span>
          <input value={trfNumber} onChange={(e) => setTrfNumber(e.target.value)} placeholder="e.g. TRF-2026" />
        </label>
        <div className="coa-picker">
          {matches.length === 0 && <p className="muted">No TRF is waiting for a certificate.</p>}
          {matches.map((c) => (
            <button key={c.id} className="coa-picker__row" disabled={busy} onClick={() => submit(c.id)}>
              <span><strong>{c.trfNumber}</strong> · {c.productName ?? 'No product'}</span>
              <StatusBadge status={c.status} />
            </button>
          ))}
        </div>
        <label className="field">
          <span>Remarks for the certificate (optional)</span>
          <textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </label>
        <div className="row modal__actions">
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/**
 * The certificate itself, plus the steps it still has to pass through. Printing
 * uses the browser's own print dialogue, so a draft and an issued certificate
 * come out identically.
 */
function CoaDetail({ coa, onClose, onChanged }: {
  coa: Coa; onClose: () => void; onChanged: (coa: Coa) => void;
}) {
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [returnNote, setReturnNote] = useState('');
  const [showReturn, setShowReturn] = useState(false);

  async function run(action: () => Promise<{ ok: boolean; data?: Coa; message?: string }>, fallback: string) {
    setBusy(true);
    setError(null);
    const res = await action();
    setBusy(false);
    if (!res.ok || !res.data) { setError(res.message ?? fallback); return; }
    onChanged(res.data);
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={`Certificate ${coa.coaNumber ?? coa.trfNumber}`}>
      <div className="modal modal--wide modal--tall">
        <div className="coa-detail__bar no-print">
          <h2>Certificate {coa.coaNumber ?? '(not yet numbered)'}</h2>
          <div className="row">
            <span className={`badge ${coaStatusTone(coa.status)}`}>{STEP_LABEL[coa.status]}</span>
            <button className="btn" onClick={() => void window.trf.printCoa()} disabled={coa.status !== 'Issued'}
              title={coa.status === 'Issued' ? 'Print the certificate' : 'Only an issued certificate can be printed'}>
              Print
            </button>
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        </div>

        {error && <p className="error-text no-print" role="alert">{error}</p>}

        <Certificate coa={coa} />

        <div className="coa-steps no-print">
          <Step label="Drafted" sign={coa.preparedBy} />
          <Step label="Reviewed" sign={coa.reviewedBy} />
          <Step label="Approved" sign={coa.approvedBy} />
          <Step label="Issued" sign={coa.issuedBy} />
        </div>

        {!showReturn && coa.status === 'Draft' && can('coa.prepare') && (
          <div className="row no-print">
            <button className="btn btn--primary" disabled={busy}
              onClick={() => run(() => coaApi.submit(coa.id, coa.version), 'The certificate could not be sent for review.')}>
              Send for review
            </button>
          </div>
        )}
        {coa.status === 'Under Review' && can('coa.prepare') && !showReturn && (
          <div className="row no-print">
            <button className="btn" disabled={busy} onClick={() => setShowReturn(true)}>Send back for changes</button>
          </div>
        )}
        {showReturn && (
          <div className="coa-return no-print">
            <label className="field">
              <span>What needs changing?</span>
              <textarea rows={2} value={returnNote} onChange={(e) => setReturnNote(e.target.value)} />
            </label>
            <div className="row">
              <button className="btn btn--primary" disabled={busy || returnNote.trim().length < 3}
                onClick={async () => {
                  await run(() => coaApi.returnForChange(coa.id, coa.version, returnNote.trim()), 'The certificate could not be sent back.');
                  setShowReturn(false);
                }}>
                Send back
              </button>
              <button className="btn" onClick={() => setShowReturn(false)}>Cancel</button>
            </div>
          </div>
        )}
        {coa.status === 'Under Review' && can('coa.approve') && (
          <div className="row no-print">
            <button className="btn btn--primary" disabled={busy}
              onClick={() => run(() => coaApi.approve(coa.id, coa.version), 'The certificate could not be approved.')}>
              Approve
            </button>
          </div>
        )}
        {coa.status === 'Approved' && can('coa.issue') && (
          <div className="row no-print">
            <button className="btn btn--primary" disabled={busy}
              onClick={() => run(() => coaApi.issue(coa.id, coa.version), 'The certificate could not be issued.')}>
              Issue certificate
            </button>
            <span className="muted">Issuing assigns the certificate number and completes the TRF.</span>
          </div>
        )}
        {coa.status === 'Issued' && (
          <p className="muted no-print">
            Issued certificates are final. Nothing on this certificate can be changed.
          </p>
        )}
      </div>
    </div>
  );
}

function Step({ label, sign }: { label: string; sign: Coa['preparedBy'] }) {
  return (
    <div className="coa-step">
      <span className="coa-step__label">{label}</span>
      {sign.name
        ? <span className="coa-step__who">{sign.name}<br /><span className="muted">{sign.at ? new Date(sign.at).toLocaleString() : ''}</span></span>
        : <span className="muted">Not yet</span>}
    </div>
  );
}


