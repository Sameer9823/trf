import { useState } from 'react';
import type { EmployeeProfile, TrfDetail } from '@trf/shared';
import { canApproveFormulation, canApproveArd, canReopenLockedTrf, isAdminDesignation } from '@trf/shared';
import { messageOf } from '../lib/api';
import { Icons } from './Icons';
import { Modal } from './Modal';

type Action = 'submit-to-agm' | 'approve-formulation' | 'reject-formulation' | 'agm-complete' | 'agm-reject' | 'unlock' | 'complete-and-lock';

const ACTION_TRACK: Record<Action, 'FORMULATION' | 'ARD' | undefined> = {
  'submit-to-agm': 'ARD',
  'approve-formulation': 'FORMULATION',
  'reject-formulation': 'FORMULATION',
  'agm-complete': 'ARD',
  'agm-reject': 'ARD',
  'complete-and-lock': 'ARD',
  unlock: undefined,
};

function canPerform(action: Action, employee: EmployeeProfile | null): boolean {
  if (action === 'unlock') return canReopenLockedTrf(employee?.role);
  if (action === 'submit-to-agm') return employee?.role === 'Admin' || employee?.role === 'Manager' || employee?.role === 'AGM';
  const track = ACTION_TRACK[action];
  if (track === 'FORMULATION') return canApproveFormulation(employee?.role);
  if (track === 'ARD') {
    if (action === 'agm-complete' || action === 'agm-reject' || action === 'complete-and-lock') {
      return employee?.role === 'Admin' && isAdminDesignation(employee?.designation);
    }
    return canApproveArd(employee?.role);
  }
  return false;
}

const COPY: Record<Action, { title: string; confirm: string; needsReason: boolean; hint: string }> = {
  'submit-to-agm': { title: 'Submit to AGM', confirm: 'Submit', needsReason: false, hint: 'Submits the completed ARD work for final approval by an AGM.' },
  'approve-formulation': { title: 'Approve this request', confirm: 'Approve', needsReason: false, hint: 'ARD work opens as soon as you approve.' },
  'reject-formulation': { title: 'Reject this request', confirm: 'Reject', needsReason: true, hint: 'Say why, so the Formulation team knows what to fix.' },
  'agm-complete': { title: 'Complete and lock TRF', confirm: 'Complete & Lock', needsReason: false, hint: 'Approves the final approval and locks the TRF.' },
  'agm-reject': { title: 'Send back to ARD', confirm: 'Send back', needsReason: true, hint: 'ARD reopens at In Progress and completes again when ready.' },
  'complete-and-lock': { title: 'Complete and lock TRF', confirm: 'Complete and lock', needsReason: false, hint: 'Sets Final Status to Completed, then approves and locks the TRF in one step.' },
  unlock: { title: 'Unlock this TRF', confirm: 'Unlock', needsReason: true, hint: 'The reason is kept in the audit trail. ARD work reopens at In Progress and needs a fresh final approval.' },
};

/**
 * Where a TRF stands in the approval, and what the signed-in person may do about it.
 * GM approves Formulation requests; AGM approves ARD final approvals; an
 * administrator can do either. Everyone else sees the state without any buttons.
 */
export function ApprovalBar({ trf, employee, onChanged }: { trf: TrfDetail; employee: EmployeeProfile | null; onChanged: () => void }) {
  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const formulationPending = trf.remarksStatus === 'Pending';
  const finalPending = trf.finalApprovalStatus === 'Pending';
  const locked = !!trf.lockedAt;

  let tone: 'pending' | 'locked' | 'rejected' | null = null;
  let title = '';
  let detail = '';
  let buttons: { action: Action; label: string; primary?: boolean }[] = [];

   if (locked) {
    tone = 'locked'; title = 'Approved and locked';
    const lockedBy = trf.lockedByName ?? trf.finalDecidedByName ?? 'an administrator';
    detail = `Approved by ${lockedBy}. Nothing can change until an authorized approver unlocks it.`;
    buttons = [{ action: 'unlock', label: 'Unlock' }];
  } else if (trf.remarksStatus === 'Rejected') {
    tone = 'rejected';
    title = 'Request rejected';
    detail = `Rejected by ${trf.formulationDecidedByName ?? 'an administrator'}. Formulation can correct it; a GM or administrator can then approve it.`;
    buttons = [{ action: 'approve-formulation', label: 'Approve', primary: true }];
  } else if (formulationPending) {
    tone = 'pending';
    title = 'Waiting for approval';
    detail = 'ARD work opens once a GM (or administrator) approves this request.';
    buttons = [{ action: 'approve-formulation', label: 'Approve', primary: true }, { action: 'reject-formulation', label: 'Reject' }];
  } else if (finalPending) {
    tone = 'pending';
    title = 'ARD is complete: waiting for final approval';
    detail = 'Approving locks the TRF.';
    // If workflowStatus is not yet Completed, show submit-to-agm and complete-and-lock
    if (trf.workflowStatus !== 'Completed') {
      buttons = [{ action: 'complete-and-lock', label: 'Complete & Lock', primary: true }, { action: 'submit-to-agm', label: 'Submit to AGM' }, { action: 'agm-reject', label: 'Send back' }];
    } else {
      // WorkflowStatus is Completed: AGM can complete or reject
      buttons = [{ action: 'agm-complete', label: 'Complete & Lock', primary: true }, { action: 'agm-reject', label: 'Send back' }];
    }
  } else if (trf.finalApprovalStatus === 'Rejected') {
    tone = 'rejected';
    title = 'Sent back to ARD';
    detail = `${trf.finalDecidedByName ?? 'An administrator'} asked for more work. ARD completes again when ready.`;
  } else if (trf.workflowStatus === 'Completed' && !finalPending && !locked && trf.remarksStatus === 'Approved') {
    // Workflow is completed but not yet submitted to AGM
    tone = 'pending';
    title = 'ARD is complete: ready to submit';
    detail = 'Submit the completed work to an AGM for final approval.';
    buttons = [{ action: 'submit-to-agm', label: 'Submit to AGM', primary: true }];
  }

  if (!tone) return null;

  async function submit() {
    if (!action) return;
    const copy = COPY[action];
    if (copy.needsReason && reason.trim().length < (action === 'unlock' ? 10 : 3)) {
      setError(action === 'unlock' ? 'The reason must be at least 10 characters.' : 'Please give a reason.');
      return;
    }
    setBusy(true);
    setError(null);
    let res;
    if (action === 'submit-to-agm') {
      res = await window.trf.request<TrfDetail>({
        method: 'POST', path: `/api/trfs/${trf.id}/ard-submit`,
        body: { version: trf.version, note: reason.trim() || null },
      });
    } else if (action === 'complete-and-lock') {
      // Step 1: Set workflowStatus to Completed
      const statusRes = await window.trf.request<TrfDetail>({
        method: 'POST', path: `/api/trfs/${trf.id}/ard-status`,
        body: { status: 'Completed', version: trf.version },
      });
      if (!statusRes.ok || !statusRes.data) {
        setBusy(false);
        setError(messageOf(statusRes.data, 'Could not complete the TRF.'));
        return;
      }
      // Step 2: Submit to AGM
      const submitRes = await window.trf.request<TrfDetail>({
        method: 'POST', path: `/api/trfs/${trf.id}/ard-submit`,
        body: { version: statusRes.data.version, note: reason.trim() || null },
      });
      if (!submitRes.ok || !submitRes.data) {
        setBusy(false);
        setError(messageOf(submitRes.data, 'Could not submit to AGM.'));
        return;
      }
      // Step 3: Approve the final approval (lock the TRF)
      res = await window.trf.request<TrfDetail>({
        method: 'POST', path: `/api/trfs/${trf.id}/agm-complete`,
        body: { decision: 'Approved', version: submitRes.data.version, reason: null },
      });
    } else if (action === 'unlock') {
      res = await window.trf.request<TrfDetail>({ method: 'POST', path: `/api/trfs/${trf.id}/unlock`, body: { version: trf.version, reason: reason.trim() } });
    } else if (action === 'agm-complete') {
      res = await window.trf.request<TrfDetail>({
        method: 'POST', path: `/api/trfs/${trf.id}/agm-complete`,
        body: { decision: 'Approved', version: trf.version, reason: null },
      });
    } else if (action === 'agm-reject') {
      res = await window.trf.request<TrfDetail>({
        method: 'POST', path: `/api/trfs/${trf.id}/agm-complete`,
        body: { decision: 'Rejected', version: trf.version, reason: reason.trim() || null },
      });
    } else {
      const act = action as Action;
      const track = act.includes('final') ? 'ARD' : 'FORMULATION';
      res = await window.trf.request<TrfDetail>({
        method: 'POST', path: `/api/trfs/${trf.id}/decision`,
        body: { track, decision: act.startsWith('approve') ? 'Approved' : 'Rejected', version: trf.version, reason: reason.trim() || null },
      });
    }
    setBusy(false);
    if (!res.ok) {
      setError(messageOf(res.data, 'That could not be saved.'));
      return;
    }
    setAction(null);
    setReason('');
    onChanged();
  }

  return (
    <>
      <div className={`approval-bar approval-bar--${tone}`} role="status">
        <span className="approval-bar__icon" aria-hidden>{tone === 'locked' ? Icons.lock : Icons.approvals}</span>
        <span className="approval-bar__text"><strong>{title}</strong><span>{detail}</span></span>
         {employee ? buttons.filter((b) => canPerform(b.action, employee)).length > 0 && (
          <span className="approval-bar__actions">
            {buttons.filter((b) => canPerform(b.action, employee)).map((b) => (
              <button key={b.action} type="button" className={`btn ${b.primary ? 'btn--primary' : ''}`}
                onClick={() => { setAction(b.action); setReason(''); setError(null); }}>
                {b.label}
              </button>
            ))}
          </span>
        ) : null}
      </div>

      <Modal
        open={action !== null}
        onClose={() => !busy && setAction(null)}
        title={action ? `${COPY[action].title}: ${trf.trfNumber}` : ''}
        busy={busy}
      >
        {action && (
          <>
            <p className="muted">{COPY[action].hint}</p>
            {COPY[action].needsReason && (
              <label className="field">
                <span>Reason</span>
                <textarea rows={4} value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
            )}
            {error && <p className="error-text" role="alert">{error}</p>}
            <div className="row modal__actions">
              <button type="button" className="btn" disabled={busy} onClick={() => setAction(null)}>Cancel</button>
              <button type="button" className={`btn btn--primary ${action.startsWith('reject') || action === 'unlock' ? 'btn--danger' : ''}`}
                disabled={busy} onClick={() => void submit()}>
                {busy ? 'Saving…' : COPY[action].confirm}
              </button>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
