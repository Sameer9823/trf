import { useEffect, useMemo, useRef, useState } from 'react';
import type { EmployeeOption } from '@trf/shared';
import { employeeOptionLabel } from '@trf/shared';
import { FieldLock } from './Fields';
import type { FieldOwner } from './Fields';

export interface EmployeeSelectProps {
  /** The id of the <label> for this control. */
  id: string;
  label: string;
  /** The selected employee id as a string, or '' when nothing is selected. */
  value: string;
  options: EmployeeOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  fieldError?: string;
  placeholder?: string;
  /** Shown when the list itself is empty, e.g. "No employees are available." */
  emptyMessage?: string;
  /** The option that is selected but is not in the list, e.g. a deactivated employee. */
  selectedOption?: EmployeeOption | null;
  /** Set when the signed-in user may not change this field. */
  lockOwner?: FieldOwner;
}

/**
 * A searchable employee dropdown. The list holds every active employee, the
 * search box narrows it by name, designation or department, and the chosen
 * employee is shown with their name and department so the user knows who they
 * picked.
 */
export function EmployeeSelect({
  id, label, value, options, onChange, disabled, fieldError, placeholder,
  emptyMessage = 'No employees are available.', selectedOption, lockOwner,
}: EmployeeSelectProps) {
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const selected = useMemo(
    () => options.find((o) => String(o.id) === value) ?? (value && selectedOption ? selectedOption : null),
    [options, value, selectedOption],
  );

  const matches = useMemo(() => {
    const needle = term.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((o) =>
      o.fullName.toLowerCase().includes(needle)
      || (o.designation ?? '').toLowerCase().includes(needle)
      || (o.departmentName ?? '').toLowerCase().includes(needle));
  }, [options, term]);

  // The search box shows the selected name until the user starts typing.
  const [editing, setEditing] = useState(false);
  const boxText = editing ? term : (selected ? selected.fullName : '');

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return (
    <div className={`field ${lockOwner ? 'field--locked' : ''}`} ref={boxRef}>
      <div className="field__head">
        <label htmlFor={id}>{label}</label>
        {lockOwner && <FieldLock owner={lockOwner} />}
      </div>
      <div className="combo">
        <input
          id={id}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          autoComplete="off"
          disabled={disabled}
          placeholder={placeholder ?? 'Search an employee…'}
          value={boxText}
          onFocus={() => { setEditing(true); setOpen(true); }}
          onChange={(e) => { setTerm(e.target.value); setEditing(true); setOpen(true); }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setOpen(false); setEditing(false); }
          }}
          onBlur={() => { setEditing(false); setTerm(''); }}
        />
        {selected && !disabled && (
          <button
            type="button"
            className="btn btn--tiny combo__clear"
            aria-label={`Clear ${label}`}
            onClick={() => { onChange(''); setTerm(''); setEditing(false); }}
          >✕</button>
        )}
      </div>

      {open && !disabled && (
        <div className="combo__panel">
          {options.length === 0 && <p className="muted combo__empty">{emptyMessage}</p>}
          {options.length > 0 && matches.length === 0 && (
            <p className="muted combo__empty">No employee matches “{term.trim()}”.</p>
          )}
          {matches.length > 0 && (
            <ul className="combo__list" id={`${id}-list`} role="listbox" aria-label={`${label} options`}>
              {matches.map((option) => (
                <li
                  key={option.id}
                  role="option"
                  aria-selected={String(option.id) === value}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onChange(String(option.id));
                    setEditing(false);
                    setTerm('');
                    setOpen(false);
                  }}
                >
                  <button
                    type="button"
                    className={`combo__option ${String(option.id) === value ? 'combo__option--on' : ''}`}
                  >
                    {employeeOptionLabel(option)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {fieldError && <p className="field-error">{fieldError}</p>}
    </div>
  );
}
