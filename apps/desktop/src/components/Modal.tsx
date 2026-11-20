import { useId, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  /** Shown while a save is in progress; blocks Escape / backdrop-close. */
  busy?: boolean;
  /** Extra class names for the dialog container (e.g. "modal--danger", "modal--wide"). */
  className?: string;
  /** The dialog content (form fields, help text, action buttons) */
  children: ReactNode;
}

/**
 * Focus selector for initial focus - prioritizes form fields only.
 * The close button (tabIndex=-1) is excluded so the first real input gets focus.
 */
const INITIAL_FOCUS_SELECTOR = 'input, select, textarea';

/**
 * Focus selector for focus trap - includes all focusable elements.
 */
const FOCUS_SELECTOR = 'input, select, textarea, [href], button:not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'; 

export function Modal({ open, onClose, title, busy = false, className, children }: ModalProps) {
  const uid = useId();
  const titleId = `modal-title${uid.replace(/:/g, '-')}`;

  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  // Keep latest callbacks in refs so the main effect doesn't re-run when they change
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  useEffect(() => {
    onCloseRef.current = onClose;
    busyRef.current = busy;
  }, [onClose, busy]);

  // Main effect: runs only when open changes
  useEffect(() => {
    if (!open) return;

    previouslyFocusedRef.current = document.activeElement as HTMLElement;
    document.body.classList.add('modal-open');

    const focusTimer = window.setTimeout(() => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      // Only focus if focus is not already inside the dialog
      if (!dialog.contains(document.activeElement)) {
        // Try form fields first (skip close button), fall back to any focusable
        const first = dialog.querySelector<HTMLElement>(INITIAL_FOCUS_SELECTOR) ??
                      dialog.querySelector<HTMLElement>(FOCUS_SELECTOR);
        if (first) first.focus();
      }
    }, 0);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busyRef.current) {
        e.preventDefault();
        onCloseRef.current();
      }
    };

    const onFocusIn = (e: FocusEvent) => {
      if (!dialogRef.current?.contains(e.target as Node)) {
        e.preventDefault();
        dialogRef.current?.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);

    return () => {
      window.clearTimeout(focusTimer);
      document.body.classList.remove('modal-open');
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
      previouslyFocusedRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="modal-backdrop"
      ref={overlayRef}
      onClick={(e) => { if (e.target === overlayRef.current && !busyRef.current) onCloseRef.current(); }}
    >
      <div
        className={`modal ${className ?? ''}`.trim()}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
      >
        {title && <h2 id={titleId}>{title}</h2>}
        {children}
        {!busy && (
          <button
            type="button"
            className="modal__close"
            aria-label="Close"
            tabIndex={-1}
            onClick={onClose}
          >
            ×
          </button>
        )}
      </div>
    </div>,
    document.body
  );
}
