import { useCallback, useEffect, useState } from 'react';
import type { ArdResultOutcome, ArdResultReviewStatus, ArdTestAssignment } from '@trf/shared';
import { ARD_RESULT_OUTCOMES, bulletList } from '@trf/shared';
import { fieldsOf, messageOf } from '../lib/api';
import { formatDate } from './Badges';
import { Modal } from './Modal';

/**
 * A "View PDF" button that downloads the result PDF through the main process
 * (tokens stay there) and lets the user save/open it.
 */
export function ResultFileButton({ assignmentId, fileName }: { assignmentId: number; fileName: string | null }) {
  if (!fileName) return null;
  return (
    <button
      type="button"
      className="btn btn--sm"
      onClick={() => void window.trf.downloadBlob(`/api/ard-assignments/${assignmentId}/result-file`, fileName)}
    >
      View PDF
    </button>
  );
}

/**
 * Test results: the assigned employee submits a result, an AGM approves or rejects it. Once every test on a TRF is
 * approved, the AGM completes the TRF from the approval bar.
 */

const REVIEW_LABEL: Record<ArdResultReviewStatus, string> = {
  Submitted: 'Waiting for AGM review',
  Approved: 'Approved',
  Rejected: 'Rejected',
};
const REVIEW_CLASS: Record<ArdResultReviewStatus, string> = {
  Submitted: 'badge--warn',
  Approved: 'badge--ok',
  Rejected: 'badge--danger',
};

export function ResultReviewBadge({ status }: { status: ArdResultReviewStatus | null | undefined }) {
  if (!status) return <span className="muted">No result yet</span>;
  return <span className={`badge ${REVIEW_CLASS[status]}`}>{REVIEW_LABEL[status]}</span>;
}

const today = () => new Date().toISOString().slice(0, 10);

export interface SubmitTarget {
  assignmentId: number;
  version: number;
  testName: string;
  trfNumber: string;
  analysisStartDate?: string | null;
  /** Fields of an earlier, rejected submission, so the employee corrects it rather than retyping it. */
  previous?: Partial<ArdTestAssignment> | null;
  /** A PDF already uploaded for this test, so the form shows it instead of asking again. */
  fileName?: string | null;
  fileSize?: number | null;
  resultMode?: 'text' | 'pdf' | null;
}

/** The form the assigned employee fills in to submit a test result. */
export function SubmitResultModal({ target, onClose, onSubmitted }: {
  target: SubmitTarget | null;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [form, setForm] = useState({
    resultValue: '', unit: '', resultText: '', methodUsed: '', specification: '',
    outcome: 'Pass' as ArdResultOutcome, remarks: '', analysisStartDate: today(), completionDate: today(),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [resultMode, setResultMode] = useState<'text' | 'pdf'>('text');
  const [uploadedFile, setUploadedFile] = useState<{ fileName: string; fileSize: number } | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!target) return;
    // A PDF uploaded earlier is still on the server; show it so the employee can
    // submit again without picking the file twice.
    const attached = target.resultMode === 'pdf' && target.fileName
      ? { fileName: target.fileName, fileSize: target.fileSize ?? 0 }
      : null;
    setResultMode(attached ? 'pdf' : 'text');
    setUploadedFile(attached);
    setUploading(false);
    const p = target.previous;
    setForm({
      resultValue: p?.resultValue ?? '', unit: p?.unit ?? '', resultText: p?.resultText ?? '', methodUsed: p?.methodUsed ?? '',
      specification: p?.specification ?? '',
      outcome: (p?.outcome as ArdResultOutcome | null | undefined) ?? 'Pass', remarks: p?.remarks ?? '',
      analysisStartDate: target.analysisStartDate ?? today(), completionDate: today(),
    });
    setError(null);
    setFieldErrors({});
  }, [target]);

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function uploadFile() {
    if (!target) return;
    setUploading(true);
    setError(null);
    const res = await window.trf.uploadResultFile(target.assignmentId);
    setUploading(false);
    if (!res.ok) {
      if (!res.cancelled) setError(res.message ?? 'Could not upload the PDF.');
      return;
    }
    if (res.fileName && res.fileSize != null) {
      setUploadedFile({ fileName: res.fileName, fileSize: res.fileSize });
    }
  }

  async function submit() {
    if (!target) return;
    if (resultMode === 'text' && !form.resultValue.trim() && !form.resultText.trim()) {
      setFieldErrors({ resultValue: 'Enter the result value or the result text.' });
      return;
    }
    if (resultMode === 'pdf' && !uploadedFile) {
      setError('Upload a PDF file first, then submit.');
      return;
    }
    setBusy(true);
    setError(null);
    setFieldErrors({});
    const res = await window.trf.request<ArdTestAssignment>({
      method: 'POST', path: `/api/ard-assignments/${target.assignmentId}/result`,
      body: {
        version: target.version,
        resultMode,
        resultValue: form.resultValue || null,
        resultText: form.resultText || null,
        unit: form.unit || null,
        methodUsed: form.methodUsed || null, specification: form.specification || null,
        outcome: form.outcome, remarks: form.remarks || null,
        analysisStartDate: form.analysisStartDate || null, completionDate: form.completionDate || null,
      },
    });
    setBusy(false);
    if (!res.ok) {
      setError(messageOf(res.data, 'The result could not be submitted.'));
      setFieldErrors(fieldsOf(res.data));
      return;
    }
    onSubmitted();
    onClose();
  }

  return (
    <Modal open={!!target} onClose={onClose} busy={busy} className="modal--wide modal--result"
      title={target ? `Submit result: ${target.testName} (${target.trfNumber})` : undefined}>
      <div className="result-modal">
        <div className="result-modal__intro">
          <span className="result-modal__icon">{resultMode === 'pdf' ? '📄' : '📝'}</span>
          <p className="muted">
            An AGM reviews this result. The test is completed once they approve it; if they reject it you will be asked to correct and submit it again.
          </p>
        </div>

        {/* Result input mode switch */}
        <div className="field">
          <label>Result input</label>
          <div className="segmented segmented--lg">
            <button type="button" className={resultMode === 'text' ? 'segmented__btn segmented__btn--active' : 'segmented__btn'}
              onClick={() => { setResultMode('text'); setError(null); }} disabled={busy}>
              <span className="segmented__icon">📝</span> Text
            </button>
            <button type="button" className={resultMode === 'pdf' ? 'segmented__btn segmented__btn--active' : 'segmented__btn'}
              onClick={() => { setResultMode('pdf'); setError(null); }} disabled={busy}>
              <span className="segmented__icon">📄</span> Upload PDF
            </button>
          </div>
        </div>

        {resultMode === 'pdf' && (
          <div className="field">
            <label>PDF result file</label>
            {uploadedFile ? (
              <div className="file-upload file-upload--success">
                <span className="file-upload__icon">📄</span>
                <div className="file-upload__info">
                  <strong>{uploadedFile.fileName}</strong>
                  <span className="muted">{(uploadedFile.fileSize / 1024).toFixed(1)} KB</span>
                </div>
                <button type="button" className="btn btn--sm" onClick={() => void uploadFile()} disabled={uploading || busy}>
                  {uploading ? 'Uploading…' : 'Replace'}
                </button>
              </div>
            ) : (
              <button type="button" className="file-upload file-upload--drop" onClick={() => void uploadFile()} disabled={uploading || busy}>
                <span className="file-upload__icon">📂</span>
                <span>{uploading ? 'Uploading…' : 'Choose a PDF file (max 10 MB)'}</span>
              </button>
            )}
          </div>
        )}

        <div className="form-section">
          <h3 className="form-section__title">Result</h3>
          <div className="field-pair">
            <div className="field">
              <label htmlFor="rs-value">
                Result value {resultMode === 'text' ? '*' : <span className="label-hint">(optional with a PDF)</span>}
              </label>
              <input id="rs-value" value={form.resultValue} onChange={set('resultValue')} disabled={busy} placeholder="e.g. 99.5" />
              {fieldErrors.resultValue && <p className="field-error">{fieldErrors.resultValue}</p>}
            </div>
            <div className="field">
              <label htmlFor="rs-unit">Unit</label>
              <input id="rs-unit" value={form.unit} onChange={set('unit')} disabled={busy} placeholder="e.g. %, mg/g, ppm" />
            </div>
          </div>
          <div className="field">
            <label htmlFor="rs-text">Result text <span className="label-hint">(for descriptive results)</span></label>
            <textarea id="rs-text" rows={3} value={form.resultText} onChange={set('resultText')} disabled={busy} placeholder="Paste the report or finding here…" />
          </div>
        </div>

        <div className="form-section">
          <h3 className="form-section__title">Analysis details</h3>
          <div className="field-pair">
            <div className="field">
              <label htmlFor="rs-method">Method used</label>
              <input id="rs-method" value={form.methodUsed} onChange={set('methodUsed')} disabled={busy} placeholder="e.g. HPLC" />
            </div>
            <div className="field">
              <label htmlFor="rs-spec">Specification</label>
              <input id="rs-spec" value={form.specification} onChange={set('specification')} disabled={busy} placeholder="e.g. 98.0 - 102.0" />
            </div>
          </div>
          <div className="field-pair">
            <div className="field">
              <label htmlFor="rs-outcome">Outcome *</label>
              <select id="rs-outcome" value={form.outcome} onChange={set('outcome')} disabled={busy}>
                {ARD_RESULT_OUTCOMES.map((o) => <option key={o} value={o}>{o === 'NA' ? 'Not applicable' : o}</option>)}
              </select>
            </div>
            <div className="field" />
          </div>
          <div className="field-pair">
            <div className="field">
              <label htmlFor="rs-start">Analysis start date</label>
              <input id="rs-start" type="date" value={form.analysisStartDate} onChange={set('analysisStartDate')} disabled={busy} />
            </div>
            <div className="field">
              <label htmlFor="rs-done">Completion date</label>
              <input id="rs-done" type="date" value={form.completionDate} onChange={set('completionDate')} disabled={busy} />
              {fieldErrors.completionDate && <p className="field-error">{fieldErrors.completionDate}</p>}
            </div>
          </div>
        </div>

        <div className="field">
          <label htmlFor="rs-remarks">Remarks <span className="label-hint">(optional notes for the reviewer)</span></label>
          <textarea id="rs-remarks" rows={2} value={form.remarks} onChange={set('remarks')} disabled={busy} placeholder="Add any notes for the AGM reviewer…" />
        </div>

        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="row modal__actions">
          <button className="btn" type="button" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" type="button" disabled={busy || uploading} onClick={() => void submit()}>
            {busy ? 'Submitting…' : 'Submit for AGM review'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export interface ReviewTarget {
  assignmentId: number;
  version: number;
  testName: string;
  trfNumber: string;
  resultValue: string | null;
  resultText: string | null;
  unit: string | null;
  outcome: ArdResultOutcome | null;
  submittedByName: string | null;
  /** PDF result file (when the analyst attached one). */
  fileName?: string | null;
  resultMode?: 'text' | 'pdf' | null;
  /** Structured fields from the form, shown next to the document. */
  methodUsed?: string | null;
  specification?: string | null;
  remarks?: string | null;
  analysisStartDate?: string | null;
  completionDate?: string | null;
}

/** The AGM's decision on one submitted result: approve it, or reject it with a reason. */
export function ReviewResultModal({ target, onClose, onDone }: {
  target: ReviewTarget | null;
  onClose: () => void;
  onDone: (readyForCompletion: boolean) => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (target) { setRejecting(false); setReason(''); setError(null); } }, [target]);

  async function decide(decision: 'Approved' | 'Rejected') {
    if (!target) return;
    if (decision === 'Rejected' && reason.trim().length < 10) {
      setError('Give a reason of at least 10 characters, so the employee knows what to correct.');
      return;
    }
    setBusy(true);
    setError(null);
    const res = await window.trf.request<{ readyForCompletion: boolean }>({
      method: 'POST', path: `/api/ard-assignments/${target.assignmentId}/result/review`,
      body: { version: target.version, decision, reason: reason.trim() || null },
    });
    setBusy(false);
    if (!res.ok) { setError(messageOf(res.data, 'The decision could not be saved.')); return; }
    onDone(!!res.data?.readyForCompletion);
    onClose();
  }

  return (
    <Modal open={!!target} onClose={onClose} busy={busy}
      title={target ? `Review result: ${target.testName} (${target.trfNumber})` : undefined}>
      {target && (
        <dl className="facts">
          <dt>Result</dt>
          <dd>
            {[target.resultValue, target.unit].filter(Boolean).join(' ') || target.resultText
              || (target.resultMode === 'pdf' ? 'See attached PDF' : '—')}
          </dd>
          {target.fileName && (
            <>
              <dt>Result file</dt>
              <dd><ResultFileButton assignmentId={target.assignmentId} fileName={target.fileName} /></dd>
            </>
          )}
          <dt>Outcome</dt><dd>{target.outcome ?? '—'}</dd>
          {target.methodUsed && <><dt>Method</dt><dd>{target.methodUsed}</dd></>}
          {target.specification && <><dt>Specification</dt><dd>{target.specification}</dd></>}
          {target.analysisStartDate && <><dt>Analysis start</dt><dd>{formatDate(target.analysisStartDate)}</dd></>}
          {target.completionDate && <><dt>Completion</dt><dd>{formatDate(target.completionDate)}</dd></>}
          {target.remarks && <><dt>Remarks</dt><dd>{target.remarks}</dd></>}
          <dt>Submitted by</dt><dd>{target.submittedByName ?? '—'}</dd>
        </dl>
      )}
      {rejecting && (
        <div className="field">
          <label htmlFor="rr-reason">Reason for rejection *</label>
          <textarea id="rr-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy}
            placeholder="What must the employee correct?" />
        </div>
      )}
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="row modal__actions">
        <button className="btn" type="button" disabled={busy} onClick={onClose}>Cancel</button>
        {!rejecting ? (
          <>
            <button className="btn btn--danger" type="button" disabled={busy} onClick={() => setRejecting(true)}>Reject…</button>
            <button className="btn btn--primary" type="button" disabled={busy} onClick={() => void decide('Approved')}>
              {busy ? 'Saving…' : 'Approve result'}
            </button>
          </>
        ) : (
          <button className="btn btn--danger" type="button" disabled={busy || reason.trim().length < 10} onClick={() => void decide('Rejected')}>
            {busy ? 'Saving…' : 'Confirm rejection'}
          </button>
        )}
      </div>
    </Modal>
  );
}

/** Every test on a TRF with its result and review. An AGM approves or rejects submitted results from here. */
export function TestResultsCard({ trfId, trfNumber, canReview, onChanged }: {
  trfId: number;
  trfNumber: string;
  canReview: boolean;
  /** Called after a decision, so the page can reload the TRF (the last approval moves it to final approval). */
  onChanged: () => void;
}) {
  const [items, setItems] = useState<ArdTestAssignment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<ReviewTarget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await window.trf.request<{ items: ArdTestAssignment[] }>({ method: 'GET', path: `/api/ard-assignments/trfs/${trfId}` });
    if (!res.ok || !res.data) { setError('The test results could not be loaded.'); return; }
    setError(null);
    setItems(res.data.items);
  }, [trfId]);

  useEffect(() => { void load(); }, [load]);

  const tests = (items ?? []).filter((a) => a.status !== 'Cancelled');
  if (items && tests.length === 0) return null;

  const approvedCount = tests.filter((a) => a.reviewStatus === 'Approved').length;
  const blockingCount = tests.filter((a) => a.reviewStatus === 'Submitted').length;
  const totalTests = tests.length;

  return (
    <section className="card card--results">
      <header className="card__head">
        <h2>Test results</h2>
        <span className="badge badge--info">ARD</span>
      </header>
      {totalTests > 0 && (
        <p className="muted">
          {approvedCount} of {totalTests} tests approved
          {blockingCount > 0 && ` · ${blockingCount} waiting for AGM review`}
        </p>
      )}
      {error && <p className="error-text" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      {items === null && !error && <p className="muted">Loading…</p>}
      {items && (
        <table className="table">
          <thead>
            <tr><th>Test</th><th>Assigned to</th><th>Result</th><th>Outcome</th><th>Review</th><th /></tr>
          </thead>
          <tbody>
            {tests.map((a) => {
              const value = [a.resultValue, a.unit].filter(Boolean).join(' ') || a.resultText || '';
              return (
                <tr key={a.id}>
                  <td>{a.testName}</td>
                  <td className="cell-bullets">{bulletList(a.analysts?.map((x) => x.fullName) ?? []) || '—'}</td>
                  <td>
                    {a.resultMode === 'pdf' && a.fileName ? (
                      <ResultFileButton assignmentId={a.id} fileName={a.fileName} />
                    ) : (
                      value || <span className="muted">—</span>
                    )}
                    {a.enteredByName && (value || a.resultMode === 'pdf') && <div className="muted">by {a.enteredByName}{a.submittedAt ? `, ${formatDate(a.submittedAt)}` : ''}</div>}
                  </td>
                  <td>{a.outcome ?? '—'}</td>
                  <td>
                    <ResultReviewBadge status={a.reviewStatus} />
                    {a.reviewStatus === 'Rejected' && a.reviewReason && <div className="muted">{a.reviewReason}</div>}
                    {a.reviewedByName && a.reviewStatus !== 'Submitted' && (
                      <div className="muted">{a.reviewedByName}{a.reviewedAt ? `, ${formatDate(a.reviewedAt)}` : ''}</div>
                    )}
                  </td>
                  <td>
                    {canReview && a.reviewStatus === 'Submitted' && (
                      <button className="btn btn--primary" onClick={() => setReviewing({
                        assignmentId: a.id, version: a.version, testName: a.testName, trfNumber,
                        resultValue: a.resultValue ?? null, resultText: a.resultText ?? null, unit: a.unit ?? null,
                        outcome: (a.outcome as ArdResultOutcome | null) ?? null, submittedByName: a.enteredByName ?? null,
                        fileName: a.fileName ?? null, resultMode: a.resultMode ?? null,
                        methodUsed: a.methodUsed ?? null, specification: a.specification ?? null, remarks: a.remarks ?? null,
                        analysisStartDate: a.analysisStartDate ?? null, completionDate: a.completionDate ?? null,
                      })}>Review</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <ReviewResultModal target={reviewing} onClose={() => setReviewing(null)} onDone={(ready) => {
        setNotice(ready ? 'Every test result is approved. The TRF is now ready for you to complete.' : null);
        void load();
        onChanged();
      }} />
    </section>
  );
}
