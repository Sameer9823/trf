import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { TrfDetail } from '@trf/shared';
import { messageOf } from '../lib/api';
import { formatDate, RemarksStatusBadge, ArdRemarksStatusBadge, ArdStageBadge, ArdReportingBadge, ArdFinalStatusBadge } from '../components/Badges';
import { useAuth } from '../lib/auth';
import { OfflineNotice } from '../components/OfflineNotice';
import { useServerStatus } from '../lib/server-status';

export function TrfPrint() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { state } = useServerStatus();
  const { employee } = useAuth();
  const [trf, setTrf] = useState<TrfDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id || state === 'offline') return;
    let cancelled = false;
    void window.trf.request<TrfDetail>({ method: 'GET', path: `/api/trfs/${id}` }).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (!res.ok || !res.data) { setError(messageOf(res.data, 'This TRF could not be loaded.')); return; }
      setTrf(res.data);
    });
    return () => { cancelled = true; };
  }, [id, state]);

  useEffect(() => {
    function onAfterPrint() { window.close(); }
    if (window.matchMedia) {
      const mediaQueryList = window.matchMedia('print');
      mediaQueryList.addListener((mql) => { if (mql.matches) onAfterPrint(); });
    }
  }, []);

  if (state === 'offline') return <div className="page"><OfflineNotice /></div>;
  if (loading) return <div className="page"><p className="muted">Loading…</p></div>;
  if (error || !trf) return <div className="page"><p className="error-text">{error ?? 'TRF not found.'}</p></div>;

  return (
    <div className="trf-print">
      <header className="trf-print__head">
        <h1>TEST REQUEST FORM</h1>
        <div className="trf-print__meta">
          <span><strong>TRF No.</strong> {trf.trfNumber}</span>
          <span><strong>Date</strong> {formatDate(trf.trfDate)}</span>
          <span><strong>Priority</strong> {trf.priority}</span>
          <span><strong>Version</strong> {trf.version}</span>
        </div>
      </header>

      <section className="trf-print__section">
        <h2>Part A — Formulation</h2>
        <dl className="facts facts--two">
          <dt>TRF No.</dt><dd>{trf.trfNumber}</dd>
          <dt>Date of Request</dt><dd>{formatDate(trf.trfDate)}</dd>
          <dt>Product Name</dt><dd>{trf.productName ?? '—'}</dd>
          <dt>Batch Number</dt><dd>{trf.batchNumber ?? '—'}</dd>
          <dt>Batch Size</dt><dd>{trf.batchSize ?? '—'}</dd>
          <dt>Market/Customer</dt><dd>{trf.customerName ?? '—'}</dd>
          <dt>Dosage Form</dt><dd>{trf.dosageForm ?? '—'}</dd>
          <dt>Manufacturing Location</dt><dd>{trf.manufacturingLocation ?? '—'}</dd>
          <dt>Label Claim</dt><dd>{trf.labelClaim ?? '—'}</dd>
          <dt>Pack Size</dt><dd>{trf.packSize ?? '—'}</dd>
          <dt>Pack Type</dt><dd>{trf.packType ?? '—'}</dd>
          <dt>Storage Condition</dt><dd>{trf.storageCondition ?? '—'}</dd>
          <dt>Storage Period</dt><dd>{trf.storagePeriod ?? '—'}</dd>
          <dt>Manufacturing Date</dt><dd>{formatDate(trf.manufacturingDate)}</dd>
          <dt>Expiry Date</dt><dd>{formatDate(trf.expiryDate)}</dd>
          <dt>Test Requested</dt><dd className="pre">{trf.requestedAnalysis ?? '—'}</dd>
          <dt>Test Details</dt><dd className="pre">{trf.specialInstructions ?? '—'}</dd>
          <dt>Analysis Required For / Purpose</dt><dd>{trf.analysisPurpose ?? '—'}</dd>
          <dt>Required Completion Date</dt><dd>{formatDate(trf.requiredCompletionDate)}</dd>
          <dt>Sample Quantity</dt><dd>{trf.sampleQuantity ?? '—'}</dd>
          <dt>Sample Submitted By</dt>
          <dd>{trf.sampleSubmittedByName ?? (trf.sampleGivenBy ? `Previously entered: ${trf.sampleGivenBy}` : '—')}</dd>
          <dt>Status</dt><dd><RemarksStatusBadge status={trf.remarksStatus} /></dd>
          <dt>Remarks</dt><dd className="pre">{trf.remarks ?? '—'}</dd>
          <dt>Signature / Date</dt><dd>{formatDate(trf.signatureDate)}</dd>
        </dl>
      </section>

      <section className="trf-print__section trf-print__section--ard">
        <h2>ARD — Analysis Details</h2>
        <dl className="facts facts--two">
          <dt>A.R. No.</dt><dd>{trf.ardNumber ?? '—'}</dd>
          <dt>Stage</dt><dd><ArdStageBadge stage={trf.stage} /></dd>
          <dt>Test Requested</dt><dd className="pre">{trf.requestedAnalysis ?? '—'} <span className="muted">— carried forward from the Formulation request</span></dd>
          <dt>Test Details</dt><dd className="pre">{trf.specialInstructions ?? '—'} <span className="muted">— carried forward from the Formulation request</span></dd>
          <dt>Analyst Name</dt><dd>{trf.analystName ?? 'Not assigned'}</dd>
          <dt>Date of Analysis</dt><dd>{formatDate(trf.analysisStartDate)}</dd>
          <dt>Reporting</dt><dd><ArdReportingBadge status={trf.reportingStatus} /></dd>
          <dt>COA</dt><dd>{trf.coaStatus}</dd>
          <dt>Status</dt><dd><ArdRemarksStatusBadge status={trf.ardRemarksStatus} /></dd>
          <dt>ARD Remark</dt><dd className="pre">{trf.ardRemarks ?? '—'}</dd>
          <dt>TAT</dt><dd>{trf.tat?.toString() ?? '—'}</dd>
          <dt>Final Status</dt><dd><ArdFinalStatusBadge status={trf.workflowStatus} /></dd>
          <dt>Sample Received Date</dt><dd>{formatDate(trf.sampleReceivedDate)}</dd>
        </dl>
      </section>

      <section className="trf-print__section">
        <h2>Requested Analysis</h2>
        <pre className="pre">{trf.requestedAnalysis ?? '—'}</pre>
        <h2>Special Instructions</h2>
        <pre className="pre">{trf.specialInstructions ?? '—'}</pre>
        <h2>Remarks</h2>
        <pre className="pre">{trf.remarks ?? '—'}</pre>
      </section>

      <footer className="trf-print__foot">
        <div>
          <strong>Prepared by</strong>
          <span>{trf.createdByName ?? employee?.fullName ?? '—'}</span>
        </div>
        <div>
          <strong>Assigned to</strong>
          <span>{trf.assignedEmployeeName ?? 'Not assigned'}</span>
        </div>
        <div className="trf-print__sig">
          <span>_________________________</span>
          <span>Signature</span>
        </div>
      </footer>

      <div className="trf-print__actions">
        <button className="btn btn--primary" onClick={() => window.trf.printTrf()}>Print</button>
        <button className="btn" onClick={() => navigate(`/trfs/${trf.id}`)}>Back to TRF</button>
      </div>
    </div>
  );
}
