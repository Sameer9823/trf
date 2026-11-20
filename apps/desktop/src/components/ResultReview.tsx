import { useCallback, useEffect, useState } from 'react';
import type { ArdResultOutcome, ArdResultReviewStatus, ArdTestAssignment } from '@trf/shared';
import { ARD_RESULT_OUTCOMES } from '@trf/shared';
import { fieldsOf, messageOf } from '../lib/api';
import { formatDate } from './Badges';
import { Modal } from './Modal';

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
}

/** The form the assigned employee fills in to submit a test result. */
export function SubmitResultModal({ target, onClose, onSubmitted }: {
  target: SubmitTarget | null;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [form, setForm] = useState({
    resultValue: '', unit: '', resultText: '', methodUsed: '', specification: '', lowerLimit: '', upperLimit: '',
    outcome: 'Pass' as ArdResultOutcome, remarks: '', analysisStartDate: today(), completionDate: today(),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!target) return;
    const p = target.previous;
    setForm({
      resultValue: p?.resultValue ?? '', unit: p?.unit ?? '', resultText: p?.resultText ?? '', methodUsed: p?.methodUsed ?? '',
      specification: p?.specification ?? '', lowerLimit: p?.lowerLimit ?? '', upperLimit: p?.upperLimit ?? '',
      outcome: (p?.outcome as ArdResultOutcome | null | undefined) ?? 'Pass', remarks: p?.remarks ?? '',
      analysisStartDate: target.analysisStartDate ?? today(), completionDate: today(),
    });
    setError(null);
    setFieldErrors({});
  }, [target]);

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit() {
    if (!target) return;
    if (!form.resultValue.trim() && !form.resultText.trim()) {
      setFieldErrors({ resultValue: 'Enter the result value or the result text.' });
      return;
    }
    setBusy(true);
    setError(null);
    setFieldErrors({});
    const res = await window.trf.request<ArdTestAssignment>({
      method: 'POST', path: `/api/ard-assignments/${target.assignmentId}/result`,
      body: {
        version: target.version,
        resultValue: form.resultValue || null, resultText: form.resultText || null, unit: form.unit || null,
        methodUsed: form.methodUsed || null, specification: form.specification || null,
        lowerLimit: form.lowerLimit || null, upperLimit: form.upperLimit || null,
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
    <Modal open={!!target} onClose={onClose} busy={busy} className="modal--wide"
      title={target ? `Submit result: ${target.testName} (${target.trfNumber})` : undefined}>
      <p className="muted">
        An AGM reviews this result. The test is completed once they approve it; if they reject it you will be asked to correct and submit it again.
      </p>
      <div className="field-pair">
        <div className="field">
          <label htmlFor="rs-value">Result value *</label>
          <input id="rs-value" value={form.resultValue} onChange={set('resultValue')} disabled={busy} />
          {fieldErrors.resultValue && <p className="field-error">{fieldErrors.resultValue}</p>}
        </div>
        <div className="field">
          <label htmlFor="rs-unit">Unit</label>
          <input id="rs-unit" value={form.unit} onChange={set('unit')} disabled={busy} placeholder="e.g. %, mg/g, ppm" />
        </div>
      </div>
      <div className="field">
        <label htmlFor="rs-text">Result text (for descriptive results)</label>
        <textarea id="rs-text" rows={2} value={form.resultText} onChange={set('resultText')} disabled={busy} />
      </div>
      <div className="field-pair">
        <div className="field">
          <label htmlFor="rs-method">Method used</label>
          <input id="rs-method" value={form.methodUsed} onChange={set('methodUsed')} disabled={busy} />
        </div>
        <div className="field">
          <label htmlFor="rs-spec">Specification</label>
          <input id="rs-spec" value={form.specification} onChange={set('specification')} disabled={busy} />
        </div>
        <div className="field">
          <label htmlFor="rs-lower">Lower limit</label>
          <input id="rs-lower" value={form.lowerLimit} onChange={set('lowerLimit')} disabled={busy} />
        </div>
        <div className="field">
          <label htmlFor="rs-upper">Upper limit</label>
          <input id="rs-upper" value={form.upperLimit} onChange={set('upperLimit')} disabled={busy} />
        </div>
        <div className="field">
          <label htmlFor="rs-outcome">Outcome *</label>
          <select id="rs-outcome" value={form.outcome} onChange={set('outcome')} disabled={busy}>
            {ARD_RESULT_OUTCOMES.map((o) => <option key={o} value={o}>{o === 'NA' ? 'Not applicable' : o}</option>)}
          </select>
        </div>
        <div className="field" />
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
      <div className="field">
        <label htmlFor="rs-remarks">Remarks</label>
        <textarea id="rs-remarks" rows={2} value={form.remarks} onChange={set('remarks')} disabled={busy} />
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="row modal__actions">
        <button className="btn" type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="btn btn--primary" type="button" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Submitting…' : 'Submit for AGM review'}
        </button>
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
          <dd>{[target.resultValue, target.unit].filter(Boolean).join(' ') || target.resultText || '—'}</dd>
          <dt>Outcome</dt><dd>{target.outcome ?? '—'}</dd>
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

  return (
    <section className="card card--results">
      <header className="card__head">
        <h2>Test results</h2>
        <span className="badge badge--info">ARD</span>
      </header>
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
                  <td>{a.analysts?.map((x) => x.fullName).join(', ') || '—'}</td>
                  <td>
                    {value || <span className="muted">—</span>}
                    {a.enteredByName && value && <div className="muted">by {a.enteredByName}{a.submittedAt ? `, ${formatDate(a.submittedAt)}` : ''}</div>}
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
