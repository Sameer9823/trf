import type { ReactNode } from 'react';

export type FieldOwner = 'Formulation' | 'ARD' | 'System';

const OWNER_HINT: Record<FieldOwner, string> = {
  Formulation: 'Owned by the Formulation team.',
  ARD: 'Owned by the ARD team.',
  System: 'Set automatically by the system.',
};

/**
 * The padlock that marks a field the signed-in user may not change. The
 * tooltip names the owner, so it is clear who to ask.
 */
export function FieldLock({ owner }: { owner: FieldOwner }) {
  return (
    <span
      className="field-lock"
      title={`Read-only for you. ${OWNER_HINT[owner]}`}
      aria-label={`Read-only for you. ${OWNER_HINT[owner]}`}
      role="img"
    >
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M4.5 7V5a3.5 3.5 0 1 1 7 0v2h.5A1.5 1.5 0 0 1 13.5 8.5v5A1.5 1.5 0 0 1 12 15H4a1.5 1.5 0 0 1-1.5-1.5v-5A1.5 1.5 0 0 1 4 7h.5Zm2 0h3V5a1.5 1.5 0 0 0-3 0v2Z" />
      </svg>
    </span>
  );
}

export interface FieldProps {
  htmlFor: string;
  label: string;
  children: ReactNode;
  /** Set when the signed-in user may not change this field. */
  lockOwner?: FieldOwner;
  error?: string;
  hint?: ReactNode;
  className?: string;
}

/**
 * One labelled field. The label, the control, the inline error and the lock
 * icon always sit in the same place, so every field on the form reads the
 * same way.
 */
export function Field({ htmlFor, label, children, lockOwner, error, hint, className }: FieldProps) {
  return (
    <div className={`field ${className ?? ''} ${lockOwner ? 'field--locked' : ''}`}>
      <div className="field__head">
        <label htmlFor={htmlFor}>{label}</label>
        {lockOwner && <FieldLock owner={lockOwner} />}
      </div>
      {children}
      {hint && <p className="field-hint">{hint}</p>}
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}
