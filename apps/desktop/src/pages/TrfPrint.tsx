import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { TrfDetail } from '@trf/shared';
import { messageOf } from '../lib/api';
import { formatDate } from '../components/Badges';
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
        <h2>Customer &amp; Product</h2>
        <dl className="facts">
          <dt>Customer</dt><dd>{trf.customerName ?? '—'}</dd>
          <dt>Product</dt><dd>{trf.productName ?? '—'}</dd>
          <dt>Batch number</dt><dd>{trf.batchNumber ?? '—'}</dd>
          <dt>Sample quantity</dt><dd>{trf.sampleQuantity ?? '—'}</dd>
        </dl>
      </section>

      <section className="trf-print__section">
        <h2>Product Details</h2>
        <dl className="facts facts--two">
          <dt>Batch size</dt><dd>{trf.batchSize ?? '—'}</dd>
          <dt>Dosage form</dt><dd>{trf.dosageForm ?? '—'}</dd>
          <dt>Manufacturing location</dt><dd>{trf.manufacturingLocation ?? '—'}</dd>
          <dt>Label claim</dt><dd>{trf.labelClaim ?? '—'}</dd>
          <dt>Pack size</dt><dd>{trf.packSize ?? '—'}</dd>
          <dt>Pack type</dt><dd>{trf.packType ?? '—'}</dd>
          <dt>Storage condition</dt><dd>{trf.storageCondition ?? '—'}</dd>
          <dt>Storage period</dt><dd>{trf.storagePeriod ?? '—'}</dd>
          <dt>Manufacturing date</dt><dd>{formatDate(trf.manufacturingDate)}</dd>
          <dt>Expiry date</dt><dd>{formatDate(trf.expiryDate)}</dd>
        </dl>
      </section>

      <section className="trf-print__section">
        <h2>Analysis Request</h2>
        <dl className="facts">
          <dt>Sample received</dt><dd>{formatDate(trf.sampleReceivedDate)}</dd>
          <dt>Required completion</dt><dd>{formatDate(trf.requiredCompletionDate)}</dd>
          <dt>Analysis purpose</dt><dd>{trf.analysisPurpose ?? '—'}</dd>
          <dt>Sample given by</dt><dd>{trf.sampleGivenBy ?? '—'}</dd>
          <dt>Signature date</dt><dd>{formatDate(trf.signatureDate)}</dd>
          <dt>Department</dt><dd>{trf.departmentName ?? '—'}</dd>
        </dl>
      </section>

      <section className="trf-print__section">
        <h2>Requested Analysis</h2>
        <pre className="pre">{trf.requestedAnalysis ?? '—'}</pre>
        <h2>Special Instructions</h2>
        <pre className="pre">{trf.specialInstructions ?? '—'}</pre>
        {trf.remarks && (
          <>
            <h2>Remarks</h2>
            <pre className="pre">{trf.remarks}</pre>
          </>
        )}
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
