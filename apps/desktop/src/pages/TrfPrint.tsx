import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { TrfDetail } from '@trf/shared';
import { messageOf } from '../lib/api';
import { useAuth } from '../lib/auth';
import { OfflineNotice } from '../components/OfflineNotice';
import { useServerStatus } from '../lib/server-status';

/** The header values of the controlled form. They are settings, so a new revision of the form is a settings change. */
interface PrintSettings {
  sopNo: string;
  revision: string;
  effectiveDate: string;
  issuedBy: string;
  department: string;
}

const DEFAULT_SETTINGS: PrintSettings = { sopNo: 'QAQN-003:F1', revision: '00', effectiveDate: '', issuedBy: '', department: 'Quality Assurance' };

/** A date-only value is a calendar day, so it must not move with the time zone. Returns dd-mm-yyyy, or '' when there is none. */
function ddMMyyyy(value: string | null | undefined): string {
  if (!value) return '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-GB').replace(/\//g, '-');
}

/**
 * The company's TEST REQUEST FORM (SOP QAQN-003:F1), filled in from an approved TRF, with the product's generic name
 * added under the product name. It prints only once the TRF is approved and locked. Every print and every PDF is
 * recorded first, and nothing prints if that record cannot be made.
 *
 * The page also tells the desktop shell when it is complete (`data-print-state` on the document element), which is how
 * the shell makes a PDF from a hidden window without anyone looking at the screen.
 */
export function TrfPrint() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { state } = useServerStatus();
  const { employee } = useAuth();
  const [trf, setTrf] = useState<TrfDetail | null>(null);
  const [settings, setSettings] = useState<PrintSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [logoLoaded, setLogoLoaded] = useState(false);
  const [logoError, setLogoError] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const logoRef = useRef<HTMLImageElement>(null);
  // Fixed when the page opens, so the "printed on" line is the same on the preview and on paper.
  const printedAt = useMemo(() => new Date(), []);

  useEffect(() => {
    if (!id) return;
    if (state === 'offline') { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    void window.trf.request<TrfDetail>({ method: 'GET', path: `/api/trfs/${id}` }).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (!res.ok || !res.data) { setError(messageOf(res.data, 'This TRF could not be loaded.')); return; }
      setError(null);
      setTrf(res.data);
    });
    return () => { cancelled = true; };
  }, [id, state]);

  // If the header values cannot be read the defaults print, so the page never waits on them.
  useEffect(() => {
    void window.trf.request<PrintSettings>({ method: 'GET', path: '/api/settings/form' }).then((res) => {
      setSettings(res.ok && res.data ? { ...DEFAULT_SETTINGS, ...res.data } : DEFAULT_SETTINGS);
    });
  }, []);

  const canPrint = !!trf && !!trf.lockedAt && trf.finalApprovalStatus === 'Approved';

  // Tells the Electron main process (which makes the PDF from a hidden window) when the form is completely drawn,
  // or that it failed. Must stay above the early returns below.
  useEffect(() => {
    const root = document.documentElement;
    if (error) {
      root.dataset.printError = error;
      root.dataset.printState = 'error';
    } else if (trf && settings && (logoLoaded || logoError)) {
      root.dataset.printState = 'ready';
    } else {
      root.dataset.printState = 'loading';
    }
    return () => { delete root.dataset.printState; delete root.dataset.printError; };
  }, [trf, settings, logoLoaded, logoError, error]);

  /** Records the print in the audit trail and waits for the logo, so it is never missing from a copy. */
  async function prepare(format: 'print' | 'pdf'): Promise<boolean> {
    if (!trf || !canPrint) return false;
    setPrintError(null);
    if (logoError) { setPrintError('The company logo could not be loaded, so nothing was printed.'); return false; }
    // The server names the person from the session; the request carries no name.
    const logged = await window.trf.request({ method: 'POST', path: `/api/trfs/${trf.id}/print-log`, body: { format } });
    if (!logged.ok) {
      setPrintError(messageOf(logged.data, 'The print could not be recorded, so nothing was printed.'));
      return false;
    }
    try { await logoRef.current?.decode(); } catch { /* a missing logo is already reported above */ }
    return true;
  }

  async function doPrint() {
    setWorking(true);
    try {
      if (!(await prepare('print'))) return;
      window.print();
    } finally {
      setWorking(false);
    }
  }

  async function saveAsPdf() {
    setWorking(true);
    try {
      if (!trf || !(await prepare('pdf'))) return;
      // The main process renders this page to a PDF and asks where to save it.
      const res = await window.trf.printToPDF(trf.id, `TRF-${trf.trfNumber.replace(/[\\/:*?"<>|]+/g, '-')}.pdf`);
      if (!res.ok) setPrintError(res.message ?? 'The PDF could not be created.');
    } finally {
      setWorking(false);
    }
  }

  if (state === 'offline') return <div className="page"><OfflineNotice /></div>;
  if (loading || !settings) return <div className="page"><p className="muted">Loading…</p></div>;
  if (error || !trf) return <div className="page"><p className="error-text">{error ?? 'TRF not found.'}</p></div>;

  // The tests asked for, then any purpose written alongside them.
  const tests = [
    ...(trf.testRequestedOptionNames ?? []),
    ...(trf.testRequestedOther ? [`Other: ${trf.testRequestedOther}`] : []),
  ].filter(Boolean);
  const purpose = trf.analysisPurpose ?? '';
  const analysisLength = tests.join(', ').length + purpose.length;

  const approvedBy = trf.ardDecidedByName ?? trf.finalDecidedByName ?? '';
  const approvedAt = trf.finalDecidedAt ?? trf.ardDecidedAt ?? null;

  return (
    <div className="trf-print">
      {!canPrint && (
        <div className="trf-print__disabled-notice no-print" role="status">
          Printing is available after the final approval. This TRF is not yet approved and locked.
        </div>
      )}

      <div className="trf-form">
        {/* Header: logo | company | SOP and revision | MASTER and effective date, then TITLE | name | issued by */}
        <div className="trf-form__header trf-form__box">
          <div className="trf-form__logo">
            <img
              ref={logoRef}
              src="./logo.png"
              alt="Kawman ExAct"
              onLoad={() => setLogoLoaded(true)}
              onError={() => setLogoError(true)}
            />
          </div>
          <div className="trf-form__company">Kawman ExAct Ingredients Private Limited, Chennai</div>
          <div className="trf-form__stack">
            <div><span className="trf-form__label">SOP. No:</span><br />{settings.sopNo}</div>
            <div><span className="trf-form__label">Revision No:</span> {settings.revision}</div>
          </div>
          <div className="trf-form__stack">
            <div className="trf-form__master">MASTER</div>
            <div><span className="trf-form__label">EFFECTIVE DATE:</span> {settings.effectiveDate}</div>
          </div>

          <div className="trf-form__title-label">TITLE</div>
          <div className="trf-form__title">Test Request Form</div>
          <div className="trf-form__stack">
            <div><span className="trf-form__label">ISSUED BY:</span> {settings.issuedBy}</div>
            <div><span className="trf-form__label">Sign/Date:</span></div>
          </div>
        </div>

        {/* Details, in the paper form's order. The generic name sits under the product name. */}
        <div className="trf-form__box trf-form__grid">
          <div className="c9"><span className="trf-form__label">Product Name:</span> {trf.productName ?? ''}</div>
          <div className="c3"><span className="trf-form__label">Date:</span> {ddMMyyyy(trf.trfDate)}</div>

          <div className="c12"><span className="trf-form__label">Generic Name:</span> {trf.genericName ?? ''}</div>

          <div className="c5"><span className="trf-form__label">Batch Number:</span> {trf.batchNumber ?? ''}</div>
          <div className="c4"><span className="trf-form__label">Batch Size:</span> {trf.batchSize ?? ''}</div>
          <div className="c3"><span className="trf-form__label">Mfg Date:</span> {ddMMyyyy(trf.manufacturingDate)}</div>

          <div className="c5"><span className="trf-form__label">Market/Customer:</span> {trf.customerName ?? ''}</div>
          <div className="c4"><span className="trf-form__label">Sample Quantity:</span> {trf.sampleQuantity ?? ''}</div>
          <div className="c3"><span className="trf-form__label">Exp Date:</span> {ddMMyyyy(trf.expiryDate)}</div>

          <div className="c5"><span className="trf-form__label">Storage Condition:</span> {trf.storageCondition ?? ''}</div>
          <div className="c4"><span className="trf-form__label">Storage period:</span> {trf.storagePeriod ?? ''}</div>
          <div className="c3"><span className="trf-form__label">Pack type:</span> {trf.packType ?? ''}</div>

          <div className="c6"><span className="trf-form__label">Manufacturing Location:</span> {trf.manufacturingLocation ?? ''}</div>
          <div className="c6"><span className="trf-form__label">Pack size:</span> {trf.packSize ?? ''}</div>

          <div className="c12"><span className="trf-form__label">Label Claim:</span> {trf.labelClaim ?? ''}</div>

          <div className={`c12 trf-form__tall${analysisLength > 650 ? ' trf-form__tall--long' : ''}`}>
            <span className="trf-form__label">Analysis Required for:</span> {tests.join(', ')}
            {purpose && <div className="trf-form__purpose">{purpose}</div>}
          </div>
          <div className="c12 trf-form__remarks"><span className="trf-form__label">Remarks:</span> {trf.remarks ?? ''}</div>
        </div>

        <div className="trf-form__five trf-form__box" style={{ borderTop: 0 }}>
          <div className="head">Sampled by</div>
          <div className="head">TRF Number</div>
          <div className="head">Sample given by</div>
          <div className="head">Sample Received by</div>
          <div className="head">AR number</div>
          <div className="value">{trf.sampleSubmittedByName ?? ''}</div>
          <div className="value">{trf.trfNumber}</div>
          <div className="value">{trf.sampleGivenBy ?? ''}</div>
          <div className="value">{trf.sampleReceivedByName ?? ''}</div>
          <div className="value">{trf.ardNumber ?? ''}</div>
        </div>

        <div className="trf-form__footer trf-form__box">
          <div className="head">Prepared by</div>
          <div className="head">Approved by</div>
          <div className="trf-form__sign">
            <span className="trf-form__label">Signature/ Date</span>
            <span>{trf.createdByName ?? ''}{trf.createdAt ? `, ${ddMMyyyy(trf.createdAt)}` : ''}</span>
          </div>
          <div className="trf-form__sign">
            <span className="trf-form__label">Signature/ Date</span>
            <span>{approvedBy}{approvedBy && approvedAt ? `, ${ddMMyyyy(approvedAt)}` : ''}</span>
          </div>
          <div><span className="trf-form__label">Department:</span> {settings.department}</div>
          <div className="trf-form__page">Page 1 of 1</div>
        </div>
      </div>

      <p className="trf-print__printed-note">
        Printed from the TRF system by {employee?.fullName ?? 'Unknown'} on {ddMMyyyy(printedAt.toISOString())}{' '}
        {printedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
      </p>

      <div className="trf-print__actions no-print">
        {printError && <p className="error-text" role="alert">{printError}</p>}
        <button className="btn btn--primary" onClick={() => void doPrint()} disabled={!canPrint || working}>
          {working ? 'Working…' : 'Print'}
        </button>
        <button className="btn" onClick={() => void saveAsPdf()} disabled={!canPrint || working}>
          Save as PDF
        </button>
        <button className="btn" onClick={() => navigate(`/trfs/${trf.id}`)}>
          Back to TRF
        </button>
      </div>
    </div>
  );
}
