import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { TrfDetail } from '@trf/shared';
import { messageOf } from '../lib/api';
import { formatDate } from '../components/Badges';
import { useAuth } from '../lib/auth';
import { OfflineNotice } from '../components/OfflineNotice';
import { useServerStatus } from '../lib/server-status';

interface PrintSettings {
  sopNo: string;
  revision: string;
  effectiveDate: string;
  issuedBy: string;
  department: string;
}

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
  const printRef = useRef<HTMLDivElement>(null);
  const hasAutoPrinted = useRef(false);

  useEffect(() => {
    if (!id || state === 'offline') return;
    let cancelled = false;
    void window.trf.request<TrfDetail>({ method: 'GET', path: `/api/trfs/${id}` }).then((res) => {
      if (cancelled) return;
      if (!res.ok || !res.data) { setError(messageOf(res.data, 'This TRF could not be loaded.')); setLoading(false); return; }
      setTrf(res.data);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [id, state]);

  useEffect(() => {
    // /api/settings/form only needs trf.view permission
    void window.trf.request<PrintSettings>({ method: 'GET', path: '/api/settings/form' })
      .then((res) => {
        if (res.ok && res.data) {
          setSettings(res.data);
        } else {
          // Never leave the page stuck on "Loading settings…": print with blank header values.
          setSettings({ sopNo: '', revision: '', effectiveDate: '', issuedBy: '', department: 'Quality Assurance' });
        }
      });
  }, []);

  const canPrint = trf?.lockedAt && trf?.finalApprovalStatus === 'Approved';

  // Tells the Electron main process (which prints this page from a hidden window) when the
  // form is completely drawn, or that it failed. Must stay above the early returns below.
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

  // Auto-print when page loads in a new window (for Print button)
  useEffect(() => {
    if (canPrint && !loading && !hasAutoPrinted.current && window.opener) {
      hasAutoPrinted.current = true;
      // Wait for fonts/logo to load, then print
      const timer = setTimeout(() => {
        window.print();
        // Close window after print dialog
        setTimeout(() => window.close(), 2000);
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [canPrint, loading]);

  async function doPrint() {
    if (!canPrint) return;
    await logPrint();
    window.print();
  }

  async function saveAsPdf() {
    if (!canPrint) return;
    await logPrint();
    // The main process renders this page to a PDF and asks where to save it.
    const fileName = `TRF-${trf!.trfNumber.replace(/[\\/:*?"<>|]+/g, '-')}.pdf`;
    const res = await window.trf.printToPDF(trf!.id, fileName);
    if (!res.ok) window.alert(res.message ?? 'The PDF could not be created.');
  }

  async function downloadPdf() {
    if (!trf) return;
    await logPrint();
    const fileName = `TRF-${trf.trfNumber.replace(/[\\/:*?"<>|]+/g, '-')}.pdf`;
    const res = await window.trf.printToPDF(trf.id, fileName);
    if (!res.ok) window.alert(res.message ?? 'The PDF could not be created.');
  }

  async function logPrint() {
    if (!trf) return;
    const actingName = employee?.fullName ?? 'Unknown';
    await window.trf.request({ method: 'POST', path: `/api/trfs/${trf.id}/print-log`, body: { printedBy: actingName } });
  }

  const handleLogoLoad = () => setLogoLoaded(true);
  const handleLogoError = () => setLogoError(true);

  if (state === 'offline') return <div className="page"><OfflineNotice /></div>;
  if (loading) return <div className="page"><p className="muted">Loading…</p></div>;
  if (error || !trf) return <div className="page"><p className="error-text">{error ?? 'TRF not found.'}</p></div>;
  if (!settings) return <div className="page"><p className="muted">Loading settings…</p></div>;

  const ddMMyyyy = (dateStr: string | null | undefined) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}-${month}-${year}`;
  };

  // Build test requested list including Other
  const testRequestedList = [
    ...trf.testRequestedOptionNames ?? [],
    ...(trf.testRequestedOther ? [`Other: ${trf.testRequestedOther}`] : [])
  ].filter(Boolean);

  return (
    <div className="trf-print" ref={printRef}>
      <table className="trf-print__header-table">
        <thead>
          <tr>
            <th className="trf-print__logo-cell" rowSpan={3}>
              <img
                src="./logo.png"
                alt="Kawman ExAct"
                className="trf-print__logo"
                onLoad={handleLogoLoad}
                onError={handleLogoError}
              />
            </th>
            <th className="trf-print__company-cell" colSpan={2}>
              KAWMAN EXACT INGREDIENTS PRIVATE LIMITED, CHENNAI
            </th>
          </tr>
          <tr>
            <td className="trf-print__sop-cell">
              <table className="trf-print__sop-inner">
                <tbody>
                  <tr>
                    <td><strong>SOP. No:</strong></td>
                    <td>{settings.sopNo}</td>
                    <td><strong>Revision No:</strong></td>
                    <td>{settings.revision}</td>
                  </tr>
                  <tr>
                    <td><strong>Effective Date:</strong></td>
                    <td>{settings.effectiveDate}</td>
                    <td><strong>Issued By / Sign/Date:</strong></td>
                    <td>{settings.issuedBy}</td>
                  </tr>
                </tbody>
              </table>
            </td>
            <td className="trf-print__master-cell">
              <div className="trf-print__master-box">MASTER</div>
            </td>
          </tr>
          <tr>
            <td className="trf-print__title-cell" colSpan={3}>
              <span className="trf-print__title">TEST REQUEST FORM</span>
            </td>
          </tr>
        </thead>
      </table>

      <table className="trf-print__details-table">
        <tbody>
          <tr>
            <td className="trf-print__label">Date</td>
            <td>{ddMMyyyy(trf.trfDate)}</td>
          </tr>
          <tr>
            <td className="trf-print__label">Product Name</td>
            <td colSpan={3}>{trf.productName ?? ''}</td>
          </tr>
          <tr>
            <td className="trf-print__label">Generic Name</td>
            <td colSpan={3}>{trf.genericName ?? ''}</td>
          </tr>
          <tr>
            <td className="trf-print__label">Batch Number</td>
            <td>{trf.batchNumber ?? ''}</td>
            <td className="trf-print__label">Batch Size</td>
            <td>{trf.batchSize ?? ''}</td>
            <td className="trf-print__label">Mfg Date</td>
            <td>{ddMMyyyy(trf.manufacturingDate)}</td>
          </tr>
          <tr>
            <td className="trf-print__label">Market/Customer</td>
            <td>{trf.customerName ?? ''}</td>
            <td className="trf-print__label">Sample Quantity</td>
            <td>{trf.sampleQuantity ?? ''}</td>
            <td className="trf-print__label">Exp Date</td>
            <td>{ddMMyyyy(trf.expiryDate)}</td>
          </tr>
          <tr>
            <td className="trf-print__label">Storage Condition</td>
            <td>{trf.storageCondition ?? ''}</td>
            <td className="trf-print__label">Storage period</td>
            <td>{trf.storagePeriod ?? ''}</td>
            <td className="trf-print__label">Pack type</td>
            <td>{trf.packType ?? ''}</td>
          </tr>
          <tr>
            <td className="trf-print__label">Manufacturing Location</td>
            <td>{trf.manufacturingLocation ?? ''}</td>
            <td className="trf-print__label">Pack size</td>
            <td>{trf.packSize ?? ''}</td>
          </tr>
          <tr>
            <td className="trf-print__label">Label Claim</td>
            <td colSpan={5}>{trf.labelClaim ?? ''}</td>
          </tr>
          <tr>
            <td className="trf-print__label">Dosage Form</td>
            <td colSpan={5}>
              <div className="trf-print__tall-cell">
                {trf.dosageFormOptionNames?.length ? trf.dosageFormOptionNames.join(', ') : trf.dosageForm ?? ''}
                {trf.dosageFormOther ? ` (Other: ${trf.dosageFormOther})` : ''}
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      {/* Analysis Required For section with all selected tests */}
      <table className="trf-print__details-table">
        <tbody>
          <tr>
            <td className="trf-print__label">Analysis Required For</td>
            <td colSpan={5}>
              <div className="trf-print__tall-cell">
                {testRequestedList.length > 0 ? (
                  <ul className="trf-print__test-list">
                    {testRequestedList.map((test, index) => (
                      <li key={index}>{test}</li>
                    ))}
                  </ul>
                ) : (
                  <span className="trf-print__empty">—</span>
                )}
              </div>
            </td>
          </tr>
          <tr>
            <td className="trf-print__label">Analysis Required For / Purpose</td>
            <td colSpan={5}>
              <div className="trf-print__tall-cell">{trf.analysisPurpose ?? ''}</div>
            </td>
          </tr>
          <tr>
            <td className="trf-print__label">Remarks</td>
            <td colSpan={5}>
              <div className="trf-print__remarks-cell">{trf.remarks ?? ''}</div>
            </td>
          </tr>
        </tbody>
      </table>

      <table className="trf-print__five-cell-table">
        <thead>
          <tr>
            <th>Sampled by</th>
            <th>TRF Number</th>
            <th>Sample given by</th>
            <th>Sample Received by</th>
            <th>AR number</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{trf.sampleSubmittedByName ?? trf.sampleGivenBy ?? ''}</td>
            <td>{trf.trfNumber}</td>
            <td>{trf.sampleGivenBy ?? ''}</td>
            <td>{trf.sampleReceivedByName ?? ''}</td>
            <td>{trf.ardNumber ?? ''}</td>
          </tr>
        </tbody>
      </table>

      <table className="trf-print__footer-table">
        <tbody>
          <tr>
            <td className="trf-print__sig-label" rowSpan={3}>Signature/ Date</td>
            <td className="trf-print__prepared-label">Prepared by</td>
            <td className="trf-print__prepared-value">{trf.createdByName ?? ''}</td>
            <td className="trf-print__approved-label">Approved by (Formulation)</td>
            <td className="trf-print__approved-value">{trf.formulationDecidedByName ?? ''}</td>
          </tr>
          <tr>
            <td className="trf-print__sig-line"></td>
            <td className="trf-print__sig-line"></td>
          </tr>
          <tr>
            <td className="trf-print__date-label">Date: {ddMMyyyy(trf.createdAt)}</td>
            <td className="trf-print__date-label">Date: {ddMMyyyy(trf.formulationDecidedAt)}</td>
          </tr>
          <tr>
            <td className="trf-print__sig-label" rowSpan={3}>Signature/ Date</td>
            <td className="trf-print__prepared-label">Prepared by (ARD)</td>
            <td className="trf-print__prepared-value">{trf.analystName ?? ''}</td>
            <td className="trf-print__approved-label">Approved by (ARD)</td>
            <td className="trf-print__approved-value">{trf.ardDecidedByName ?? trf.finalDecidedByName ?? ''}</td>
          </tr>
          <tr>
            <td className="trf-print__sig-line"></td>
            <td className="trf-print__sig-line"></td>
          </tr>
          <tr>
            <td className="trf-print__date-label">Date: {ddMMyyyy(trf.analysisStartDate)}</td>
            <td className="trf-print__date-label">Date: {ddMMyyyy(trf.finalDecidedAt ?? trf.ardDecidedAt)}</td>
          </tr>
          <tr>
            <td className="trf-print__dept-cell" colSpan={5}>
              <span>Department: {settings.department}</span>
              <span className="trf-print__page-info">Page 1 of 1</span>
            </td>
          </tr>
        </tbody>
      </table>

      <div className="trf-print__printed-note">
        Printed from the TRF system by {employee?.fullName ?? 'Unknown'} on {ddMMyyyy(new Date().toISOString())} {new Date().toLocaleTimeString()}
      </div>

      {!canPrint && (
        <div className="trf-print__disabled-notice">
          Printing is available after the final approval.
        </div>
      )}

      <div className="trf-print__actions no-print">
        <button className="btn btn--primary" onClick={doPrint} disabled={!canPrint}>
          Print
        </button>
        <button className="btn" onClick={saveAsPdf} disabled={!canPrint}>
          Save as PDF
        </button>
        <button className="btn" onClick={downloadPdf} disabled={!canPrint}>
          Download PDF
        </button>
        <button className="btn" onClick={() => navigate(`/trfs/${trf.id}`)}>
          Back to TRF
        </button>
      </div>
    </div>
  );
}