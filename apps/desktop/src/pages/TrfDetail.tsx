import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { ArdWorkflowStatus, EmployeeProfile, TrfDetail, TrfStatus, TrfStatusHistoryEntry, ArdStatusHistoryEntry, TrfDocument } from '@trf/shared';
import { MESSAGES, canEditTrfPartA, canEditTrfPartB, canDeleteTrf } from '@trf/shared';
import { messageOf } from '../lib/api';
import { useAuth } from '../lib/auth';
import { OverdueBadge, PriorityBadge, StatusBadge, ArdCoaBadge, ArdReportingBadge, allowedNextStatuses, allowedNextArdStatuses, formatDate } from '../components/Badges';
import { ArdFinalStatusBadge, ArdStageBadge, RemarksStatusBadge, ArdRemarksStatusBadge } from '../components/Badges';
import { OfflineNotice } from '../components/OfflineNotice';
import { ApprovalBar } from '../components/ApprovalBar';
import { Modal } from '../components/Modal';
import { useServerStatus, type ConnectionState } from '../lib/server-status';
import { FinalStatusStepper } from './TrfForm';

type Tab = 'details' | 'history' | 'ard-history';

/** Admin-only dialog to reopen a Formulation-approved TRF. */
function ReopenFormulationDialog({ trfId, trfNumber, version,   open, onClose, onReopen, onOpen }: {
  trfId: number;
  trfNumber: string;
  version: number;
  open: boolean;
  onClose: () => void;
  onReopen: () => void;
  onOpen: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) { setReason(''); setError(null); }
  }, [open]);

  async function submit() {
    if (reason.trim().length < 10) {
      setError('The reason must be at least 10 characters.');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await window.trf.request<TrfDetail>({
      method: 'POST',
      path: `/api/trfs/${trfId}/reopen`,
      body: { version, reason: reason.trim() },
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? 'Reopen failed.');
      return;
    }
    onClose();
    onReopen();
  }

  return (
    <>
      <button className="btn btn--danger" onClick={onOpen}>Reopen Formulation</button>
      <Modal
        open={open}
        onClose={onClose}
        title={`Reopen Formulation: ${trfNumber}`}
        busy={busy}
      >
        <p className="muted">This action requires a reason (minimum 10 characters).</p>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Enter the reason for reopening…"
          rows={4}
          disabled={busy}
        />
        {error && <p className="field-error">{error}</p>}
        <div className="row modal__actions">
          <button className="btn" type="button" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="btn btn--primary btn--danger" disabled={busy || reason.trim().length < 10} onClick={submit}>
            {busy ? 'Reopening…' : 'Confirm Reopen'}
          </button>
        </div>
      </Modal>
    </>
  );
}

export function TrfDetailPage() {
   const { id } = useParams();
   const navigate = useNavigate();
   const [searchParams, setSearchParams] = useSearchParams();
  const { state } = useServerStatus();
  const { can, employee } = useAuth();

  const [trf, setTrf] = useState<TrfDetail | null>(null);
  const [history, setHistory] = useState<TrfStatusHistoryEntry[]>([]);
  const [ardHistory, setArdHistory] = useState<ArdStatusHistoryEntry[]>([]);
  const [document, setDocument] = useState<TrfDocument | null>(null);
  const [tab, setTab] = useState<Tab>('details');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);

const load = useCallback(async () => {
    setLoading(true);
    try {
      // Helper to add timeout to a promise
      const withTimeout = <T,>(promise: Promise<T>, ms: number, timeoutError: string) =>
        Promise.race([
          promise,
          new Promise<T>((_, reject) => setTimeout(() => reject(new Error(timeoutError)), ms)),
        ]);
      
      type Res<T> = { ok: boolean; status: number; data?: T; error?: string };
      // History, ARD history and the document are extras: if one is slow or fails, the TRF itself still opens.
      const optional = <T,>(promise: Promise<Res<T>>, ms: number, timeoutError: string): Promise<Res<T>> =>
        withTimeout(promise, ms, timeoutError).catch(() => ({ ok: false, status: 0 }) as Res<T>);

      // Fetch all data in parallel with 10s timeout each
      const [trfRes, historyRes, ardHistoryRes, documentRes] = await Promise.all([
        withTimeout(window.trf.request<TrfDetail>({ method: 'GET', path: `/api/trfs/${id}` }), 10000, 'TRF detail timeout'),
        optional(window.trf.request<{ items: TrfStatusHistoryEntry[] }>({ method: 'GET', path: `/api/trfs/${id}/history` }), 10000, 'History timeout'),
        optional(window.trf.request<{ items: ArdStatusHistoryEntry[] }>({ method: 'GET', path: `/api/trfs/${id}/ard-history` }), 10000, 'ARD history timeout'),
        optional(window.trf.request<TrfDocument>({ method: 'GET', path: `/api/trfs/${id}/document` }), 10000, 'Document timeout'),
      ]);
      
      setLoading(false);
      
      if (!trfRes.ok || !trfRes.data) {
        setError(trfRes.status === 0 ? MESSAGES.SERVER_UNAVAILABLE : messageOf(trfRes.data, 'This TRF could not be loaded.'));
        return;
      }
      
      setError(null);
      setTrf(trfRes.data);
      
      if (historyRes.ok && historyRes.data) {
        setHistory(historyRes.data.items);
      } else {
        setHistory([]);
      }
      
      if (ardHistoryRes.ok && ardHistoryRes.data) {
        setArdHistory(ardHistoryRes.data.items);
      } else {
        setArdHistory([]);
      }
      
      if (documentRes.ok && documentRes.data) {
        setDocument(documentRes.data);
      } else {
        setDocument(null);
      }
    } catch (err) {
      setLoading(false);
      setError((err as Error).message);
    }
  }, [id]);

  // Open the TRF: fetch it when the page appears and whenever the id changes.
  // (Nothing else calls load() on mount, so without this the page stays on "Loading…" forever.)
  useEffect(() => { void load(); }, [load]);
 
  const loadDocument = useCallback(async () => {
    if (state === 'offline') return;
    const res = await window.trf.request<TrfDocument>({ method: 'GET', path: `/api/trfs/${id}/document` });
    if (res.ok && res.data) {
      setDocument(res.data);
    } else {
      setDocument(null);
    }
  }, [id, state]);
 
  // Load document when TRF is loaded and locked (approved) - now loaded in parallel, but keep for revalidation
  useEffect(() => {
    if (trf && trf.lockedAt && trf.finalApprovalStatus === 'Approved') {
      void loadDocument();
    }
  }, [trf, loadDocument]);
 
  const isOffline = (state as ConnectionState) === 'offline';

  // Hooks must all run on every render, so these sit ABOVE the early returns below.
  // Track which TRF versions already had a PDF generated.
  const pdfGenerationAttempted = useRef<Set<number>>(new Set());
  const trfId = trf?.id;
  const trfVersion = trf?.version;

  // Generate PDF using Electron's printToPDF after final approval (non-blocking)
  const generatePdf = useCallback(async () => {
    if (isOffline || trfId === undefined || trfVersion === undefined) return;
    // Prevent duplicate generation for the same version
    if (pdfGenerationAttempted.current.has(trfVersion)) return;
    pdfGenerationAttempted.current.add(trfVersion);
    try {
      const res = await window.trf.generatePdf(trfId);
      if (!res.ok) {
        console.warn('Auto PDF generation failed:', res.message);
        // Remove from attempted set so retry can work
        pdfGenerationAttempted.current.delete(trfVersion);
        return;
      }
      // Reload document to show the new PDF
      await loadDocument();
    } catch (err) {
      console.warn('Auto PDF generation error:', err);
      pdfGenerationAttempted.current.delete(trfVersion);
    }
  }, [trfId, trfVersion, isOffline, loadDocument]);

  if (isOffline) return <div className="page"><OfflineNotice /></div>;
  if (loading) return <div className="page"><p className="muted">Loading…</p></div>;
  if (error || !trf) return <div className="page"><p className="error-text">{error ?? MESSAGES.NOT_FOUND}</p></div>;

  const currentTrf = trf;

  async function changeStatus(next: TrfStatus) {
    setBusy(true);
    setActionError(null);
    setConflict(false);
    const res = await window.trf.request<TrfDetail>({
      method: 'POST', path: `/api/trfs/${currentTrf.id}/status`,
      body: { status: next, version: currentTrf.version },
    });
    setBusy(false);
    if (!res.ok || !res.data) {
      const message = messageOf(res.data, 'The status could not be changed.');
      setActionError(message);
      setConflict(message === MESSAGES.CONFLICT);
      return;
    }
    setTrf(res.data);
  }

  async function changeArdStatus(next: ArdWorkflowStatus) {
    setBusy(true);
    setActionError(null);
    setConflict(false);
    const res = await window.trf.request<TrfDetail>({
      method: 'POST', path: `/api/trfs/${currentTrf.id}/ard-status`,
      body: { status: next, version: currentTrf.version },
    });
    setBusy(false);
    if (!res.ok || !res.data) {
      const message = messageOf(res.data, 'The ARD status could not be changed.');
      setActionError(message);
      setConflict(message === MESSAGES.CONFLICT);
      return;
    }
    setTrf(res.data);
    // If ARD workflow is completed, trigger PDF generation after final approval
    if (next === 'Completed' && res.data.finalApprovalStatus === 'Pending') {
      // The final approval will be handled by ApprovalBar, which calls onChanged
      // We'll handle PDF generation in the onChanged callback
    }
  }

  const nextStatuses = allowedNextStatuses(currentTrf.status);
  const nextArdStatuses = allowedNextArdStatuses(currentTrf.workflowStatus);
  const canEditA = employee ? canEditTrfPartA(employee) : false;
  const canEditB = employee ? canEditTrfPartB(employee) : false;
  const editable = (canEditA || canEditB) && !currentTrf.lockedAt && currentTrf.status !== 'Completed' && currentTrf.status !== 'Cancelled';
  const canDelete = employee && canDeleteTrf(employee) && currentTrf.status === 'New' && !currentTrf.lockedAt;
  const isLocked = currentTrf.lockedAt && currentTrf.finalApprovalStatus === 'Approved';

  async function doPrint() {
    if (!isLocked) return;
    setActionError(null);
    await logPrint();
    // The main process opens the print layout in a hidden window and shows the system print dialog.
    const res = await window.trf.printTrf(currentTrf.id);
    if (!res.ok) setActionError(res.message ?? 'The TRF could not be printed.');
  }

  async function saveAsPdf() {
    if (!isLocked) return;
    await logPrint();
    // Use Electron's printToPDF via main process
    const fileName = `TRF-${currentTrf.trfNumber.replace(/\//g, '-')}.pdf`;
    setActionError(null);
    const res = await window.trf.printToPDF(currentTrf.id, fileName);
    if (!res.ok) {
      setActionError(res.message ?? 'PDF generation failed.');
    } else if (!res.cancelled && res.path) {
      setNotice(`PDF saved to ${res.path}`);
    }
  }

  async function downloadPdf() {
    if (!document) return;
    await logPrint();
    setActionError(null);
    const fileName = `TRF-${currentTrf.trfNumber.replace(/\//g, '-')}.pdf`;
    try {
      // Use the configured server URL to download without an unavailable preload API.
      const { serverUrl } = await window.trf.getConfig();
      const link = window.document.createElement('a');
      link.href = `${serverUrl.replace(/\/$/, '')}/api/trfs/${currentTrf.id}/document/download`;
      link.download = fileName;
      link.rel = 'noreferrer';
      window.document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err) {
      setActionError((err as Error).message ?? 'PDF download failed.');
      return;
    }
    setNotice('PDF downloaded successfully.');
  }

  async function retryPdfGeneration() {
    // Clear the attempted flag for this version to allow retry
    pdfGenerationAttempted.current.delete(currentTrf.version);
    // For manual retry, we do want to show busy state and errors
    setBusy(true);
    setActionError(null);
    try {
      const res = await window.trf.generatePdf(currentTrf.id);
      setBusy(false);
      if (!res.ok) {
        setActionError(res.message ?? 'PDF generation failed.');
        return;
      }
      // Reload document to show the new PDF
      await loadDocument();
    } catch (err) {
      setBusy(false);
      setActionError((err as Error).message);
    }
  }

  async function logPrint() {
    const actingName = employee?.fullName ?? 'Unknown';
    await window.trf.request({ method: 'POST', path: `/api/trfs/${currentTrf.id}/print-log`, body: { printedBy: actingName } });
  }

  // PDF Status display
  const pdfStatus = document ? (
    document.status === 'generated' ? (
      <div className="pdf-status pdf-status--available">
        <span className="pdf-status__icon">✓</span>
        <span className="pdf-status__text">PDF generated on {new Date(document.generatedAt).toLocaleString()}</span>
        <button className="btn btn--primary" onClick={downloadPdf} disabled={busy}>
          Download PDF
        </button>
      </div>
    ) : document.status === 'failed' ? (
      <div className="pdf-status pdf-status--failed">
        <span className="pdf-status__icon">✗</span>
        <span className="pdf-status__text">PDF generation failed: {document.errorMessage ?? 'Unknown error'}</span>
        <button className="btn btn--primary" onClick={retryPdfGeneration} disabled={busy}>
          Retry Generation
        </button>
      </div>
    ) : (
      <div className="pdf-status pdf-status--pending">
        <span className="pdf-status__icon">⟳</span>
        <span className="pdf-status__text">PDF generation in progress…</span>
      </div>
    )
  ) : null;

  return (
    <div className="page page--wide">
      <div className="page__head">
        <h1>
          {currentTrf.trfNumber}
          <StatusBadge status={currentTrf.status} />
          {currentTrf.isOverdue && <OverdueBadge />}
        </h1>
        <div className="row">
          {editable && <a className="btn" href={`#/trfs/${currentTrf.id}/edit`}>Edit</a>}
          {editable && <a className="btn" href={`#/trfs/${currentTrf.id}/print`} onClick={() => navigate(`/trfs/${currentTrf.id}/print`)}>Print</a>}
          {isLocked && (
            <>
              <button className="btn btn--primary" onClick={doPrint} disabled={busy}>Print</button>
              <button className="btn" onClick={saveAsPdf} disabled={busy}>Save as PDF</button>
            </>
          )}
          {canDelete && (
            <button className="btn btn--danger" onClick={() => {
              if (confirm(`Delete TRF ${currentTrf.trfNumber}? This cannot be undone.`)) {
                void window.trf.request<TrfDetail>({ method: 'DELETE', path: `/api/trfs/${currentTrf.id}` })
                  .then((res) => {
                    if (res.ok) navigate('/trf');
                    else setActionError(messageOf(res.data, 'This TRF could not be deleted.'));
                  });
              }
            }}>Delete</button>
          )}
          <a className="btn" href="#/trf">Back to list</a>
        </div>
      </div>

      <ApprovalBar trf={currentTrf} employee={employee} onChanged={async () => {
        await load();
        await loadDocument();
        // If TRF is now locked (final approval approved), generate PDF
        if (currentTrf.lockedAt && currentTrf.finalApprovalStatus === 'Approved') {
          // Use setTimeout to defer PDF generation until after the render cycle
          setTimeout(() => { void generatePdf(); }, 0);
        }
      }} />

      {pdfStatus && (
        <div className="pdf-status-container" style={{ marginTop: 16, padding: 16, border: '1px solid var(--line)', borderRadius: 4, background: 'var(--panel)' }}>
          <h3 style={{ margin: '0 0 12px 0', fontSize: '14px' }}>Generated Document</h3>
          {pdfStatus}
        </div>
      )}

      {notice && (
        <div className="notice" role="status">
          <p>{notice}</p>
        </div>
      )}

      {actionError && (
        <div className="notice notice--error" role="alert">
          <p className="error-text">{actionError}</p>
          {conflict && (
            <div className="row">
              <button className="btn btn--primary" onClick={() => load()}>Reload this TRF</button>
              <span className="muted">Your change was not saved, so nothing was overwritten.</span>
            </div>
          )}
        </div>
      )}

      <div className="tabs">
        <button className={`tab ${tab === 'details' ? 'tab--active' : ''}`} onClick={() => setTab('details')}>Details</button>
        <button className={`tab ${tab === 'history' ? 'tab--active' : ''}`} onClick={() => setTab('history')}>
          History{history.length > 0 ? ` (${history.length})` : ''}
        </button>
        <button className={`tab ${tab === 'ard-history' ? 'tab--active' : ''}`} onClick={() => setTab('ard-history')}>
          ARD History{ardHistory.length > 0 ? ` (${ardHistory.length})` : ''}
        </button>
      </div>

      {tab === 'details' && (
        <div className="details-tabs">
          <section className="card card--part-a">
            <header className="card__head">
              <h2>Part A — Formulation</h2>
            </header>
            <dl className="facts facts--wide">
              <dt>TRF No.</dt><dd>{currentTrf.trfNumber}</dd>
              <dt>Date of Request</dt><dd>{formatDate(currentTrf.trfDate)}</dd>
              <dt>Product Name</dt><dd>{currentTrf.productName ?? '—'}</dd>
              <dt>Batch Number</dt><dd>{currentTrf.batchNumber ?? '—'}</dd>
              <dt>Batch Size</dt><dd>{currentTrf.batchSize ?? '—'}</dd>
              <dt>Market/Customer</dt><dd>{currentTrf.customerName ?? '—'}</dd>
              <dt>Dosage Form</dt><dd>{currentTrf.dosageFormOptionNames?.length ? currentTrf.dosageFormOptionNames.join(', ') : currentTrf.dosageForm ?? '—'}{currentTrf.dosageFormOther ? ` (${currentTrf.dosageFormOther})` : ''}</dd>
              <dt>Manufacturing Location</dt><dd>{currentTrf.manufacturingLocation ?? '—'}</dd>
              <dt>Label Claim</dt><dd>{currentTrf.labelClaim ?? '—'}</dd>
              <dt>Pack Size</dt><dd>{currentTrf.packSize ?? '—'}</dd>
              <dt>Pack Type</dt><dd>{currentTrf.packType ?? '—'}</dd>
              <dt>Storage Condition</dt><dd>{currentTrf.storageCondition ?? '—'}</dd>
              <dt>Storage Period</dt><dd>{currentTrf.storagePeriod ?? '—'}</dd>
              <dt>Manufacturing Date</dt><dd>{formatDate(currentTrf.manufacturingDate)}</dd>
              <dt>Expiry Date</dt><dd>{formatDate(currentTrf.expiryDate)}</dd>
              <dt>Test Requested</dt><dd className="pre">{currentTrf.testRequestedOptionNames?.length ? currentTrf.testRequestedOptionNames.join(', ') : (currentTrf.requestedAnalysis ?? '—')}{currentTrf.testRequestedOther ? ` (Other: ${currentTrf.testRequestedOther})` : ''}</dd>
              <dt>Test Details</dt><dd className="pre">{currentTrf.specialInstructions ?? '—'}</dd>
              <dt>Analysis Required For / Purpose</dt><dd>{currentTrf.analysisPurpose ?? '—'}</dd>
              <dt>Required Completion Date</dt><dd>{formatDate(currentTrf.requiredCompletionDate)}</dd>
              <dt>Sample Quantity</dt><dd>{currentTrf.sampleQuantity ?? '—'}</dd>
              <dt>Sample Submitted By</dt>
              <dd>{currentTrf.sampleSubmittedByName ?? (currentTrf.sampleGivenBy ? `Previously entered: ${currentTrf.sampleGivenBy}` : '—')}</dd>
              <dt>Status</dt><dd><RemarksStatusBadge status={currentTrf.remarksStatus} /></dd>
              <dt>Remarks</dt><dd className="pre">{currentTrf.remarks ?? '—'}</dd>
              <dt>Signature / Date</dt><dd>{formatDate(currentTrf.signatureDate)}</dd>
            </dl>
            {(currentTrf.formulationApprovalStatus !== 'None' || currentTrf.finalApprovalStatus !== 'None' || currentTrf.ardApprovalStatus !== 'None') && (
              <section className="card card--approvals">
                <header className="card__head">
                  <h2>Approvals</h2>
                </header>
                <dl className="facts facts--wide">
                  <dt>Formulation Approval</dt>
                  <dd>
                    <RemarksStatusBadge status={currentTrf.remarksStatus} />
                    {currentTrf.formulationDecidedByName && (
                      <span className="muted"> — Approved by {currentTrf.formulationDecidedByName}{currentTrf.formulationDecidedAt && ` on ${formatDate(currentTrf.formulationDecidedAt)}`}</span>
                    )}
                  </dd>
                  <dt>ARD Approval</dt>
                  <dd>
                    <ArdRemarksStatusBadge status={currentTrf.ardRemarksStatus} />
                    {currentTrf.ardDecidedByName && (
                      <span className="muted"> — Approved by {currentTrf.ardDecidedByName}{currentTrf.ardDecidedAt && ` on ${formatDate(currentTrf.ardDecidedAt)}`}</span>
                    )}
                  </dd>
                  <dt>Final Approval</dt>
                  <dd>
                    <ArdFinalStatusBadge status={currentTrf.finalApprovalStatus} />
                    {currentTrf.finalDecidedByName && (
                      <span className="muted"> — Approved by {currentTrf.finalDecidedByName}{currentTrf.finalDecidedAt && ` on ${formatDate(currentTrf.finalDecidedAt)}`}</span>
                    )}
                  </dd>
                  <dt>Locked</dt>
                  <dd>
                    {currentTrf.lockedAt && currentTrf.lockedByName && (
                      <span className="muted">Locked by {currentTrf.lockedByName} on {formatDate(currentTrf.lockedAt)}</span>
                    )}
                  </dd>
                </dl>
              </section>
            )}

            </section>

          <section className="card card--ard">
            <header className="card__head">
              <h2>ARD — Analysis Details</h2>
              <span className="badge badge--info">ARD</span>
            </header>
            <dl className="facts facts--wide">
              <dt>A.R. No.</dt><dd>{currentTrf.ardNumber ?? '—'}</dd>
              <dt>Stage</dt><dd><ArdStageBadge stage={currentTrf.stage} /></dd>
              <dt>Test Requested</dt><dd className="pre">{currentTrf.requestedAnalysis ?? '—'} <span className="muted">— carried forward from the Formulation request</span></dd>
              <dt>Test Details</dt><dd className="pre">{currentTrf.specialInstructions ?? '—'} <span className="muted">— carried forward from the Formulation request</span></dd>
              <dt>Analyst Name</dt><dd>{currentTrf.analystName ?? 'Not assigned'}</dd>
              <dt>Date of Analysis</dt><dd>{formatDate(currentTrf.analysisStartDate)}</dd>
              <dt>Reporting</dt><dd><ArdReportingBadge status={currentTrf.reportingStatus} /></dd>
              <dt>COA</dt><dd><ArdCoaBadge status={currentTrf.coaStatus} /></dd>
              <dt>Status</dt><dd><ArdRemarksStatusBadge status={currentTrf.ardRemarksStatus} /></dd>
              <dt>ARD Remark</dt><dd className="pre">{currentTrf.ardRemarks ?? '—'}</dd>
              <dt>TAT</dt><dd>{currentTrf.tat?.toString() ?? '—'}</dd>
              <dt>Final Status</dt><dd><ArdFinalStatusBadge status={currentTrf.workflowStatus} /></dd>
              <dt>Sample Received Date</dt><dd>{formatDate(currentTrf.sampleReceivedDate)}</dd>
              <dt>Sample Received By</dt><dd>{currentTrf.sampleReceivedByName ?? '—'}</dd>
            </dl>

            <div className="card__foot">
              <FinalStatusStepper current={currentTrf.workflowStatus} />
              {canEditB && nextArdStatuses.length > 0 && (
                <div className="row">
                  {nextArdStatuses.map((next) => (
                    <button key={next} className="btn" disabled={busy} onClick={() => changeArdStatus(next)}>
                      Move to {next}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </section>

          {can('trf.changeStatus') && (
            <section className="panel">
              <h2>Change status</h2>
              {nextStatuses.length === 0 ? (
                <p className="muted">This TRF is {currentTrf.status}. Its status cannot change further.</p>
              ) : (
                <div className="row">
                  {nextStatuses.map((next) => (
                    <button key={next} className="btn" disabled={busy} onClick={() => changeStatus(next)}>
                      Move to {next}
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* Admin-only Reopen Formulation action */}
          {can('settings.manage') && currentTrf.remarksStatus === 'Approved' && (
            <>
              <section className="panel">
                <h2>Reopen Formulation</h2>
                <p className="muted">
                  This will set the Formulation Status back to Pending, unlock Part A for editing,
                  and lock the ARD block again until re-approved. All ARD data will be preserved.
                </p>
                <ReopenFormulationDialog trfId={currentTrf.id} trfNumber={currentTrf.trfNumber} version={currentTrf.version}
                  open={reopenOpen} onOpen={() => setReopenOpen(true)} onClose={() => setReopenOpen(false)} onReopen={load} />
              </section>
            </>
          )}

        </div>      )}

      {tab === 'history' && (
        <table className="table">
          <thead>
            <tr><th>When</th><th>From</th><th>To</th><th>Changed by</th><th>Note</th></tr>
          </thead>
          <tbody>
            {history.length === 0 && (
              <tr><td colSpan={5} className="muted">No status changes recorded yet.</td></tr>
            )}
            {history.map((entry) => (
              <tr key={entry.id}>
                <td>{new Date(entry.changedAt).toLocaleString()}</td>
                <td>{entry.oldStatus ?? '—'}</td>
                <td><StatusBadge status={entry.newStatus} /></td>
                <td>{entry.changedByName ?? '—'}</td>
                <td>{entry.note ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === 'ard-history' && (
        <table className="table">
          <thead>
            <tr><th>When</th><th>From</th><th>To</th><th>Changed by</th><th>Note</th></tr>
          </thead>
          <tbody>
            {ardHistory.length === 0 && (
              <tr><td colSpan={5} className="muted">No ARD status changes recorded yet.</td></tr>
            )}
            {ardHistory.map((entry) => (
              <tr key={entry.id}>
                <td>{new Date(entry.changedAt).toLocaleString()}</td>
                <td>{entry.oldStatus ?? '—'}</td>
                <td><ArdFinalStatusBadge status={entry.newStatus} /></td>
                <td>{entry.changedByName ?? '—'}</td>
                <td>{entry.note ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
