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
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

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
      || (o.departmentName ?? '').toLowerCase().includes(needle)
      || (o.team ?? '').toLowerCase().includes(needle));
  }, [options, term]);

  // The search box shows the selected name until the user starts typing.
  const [editing, setEditing] = useState(false);
  const boxText = editing ? term : (selected ? selected.fullName : '');

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
        setEditing(false);
        setTerm('');
        setHighlightedIndex(-1);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // Scroll highlighted option into view
  useEffect(() => {
    if (highlightedIndex >= 0 && listRef.current) {
      const option = listRef.current.children[highlightedIndex] as HTMLElement;
      if (option) {
        option.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [highlightedIndex]);

  // Reset highlighted index when matches change
  useEffect(() => {
    setHighlightedIndex(-1);
  }, [matches]);

  const openPanel = () => {
    if (!disabled) {
      setOpen(true);
      setEditing(true);
      setHighlightedIndex(-1);
    }
  };

  const closePanel = () => {
    setOpen(false);
    setEditing(false);
    setTerm('');
    setHighlightedIndex(-1);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        openPanel();
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        setHighlightedIndex((prev) => {
          const next = prev + 1;
          return next < matches.length ? next : prev;
        });
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        setHighlightedIndex((prev) => {
          const next = prev - 1;
          return next >= 0 ? next : prev;
        });
        break;
      }
      case 'Enter': {
        if (highlightedIndex >= 0 && matches[highlightedIndex]) {
          e.preventDefault();
          const option = matches[highlightedIndex];
          onChange(String(option.id));
          closePanel();
        }
        break;
      }
      case 'Escape': {
        e.preventDefault();
        closePanel();
        inputRef.current?.focus();
        break;
      }
      case 'Tab': {
        // Let tab close and move focus naturally
        closePanel();
        break;
      }
    }
  };

  const handleClear = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onChange('');
    closePanel();
    inputRef.current?.focus();
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTerm(e.target.value);
    setEditing(true);
    setOpen(true);
    setHighlightedIndex(-1);
  };

  const handleFocus = () => {
    if (!editing && !disabled) {
      setOpen(true);
      setHighlightedIndex(-1);
    }
  };

  return (
    <div className={`field ${lockOwner ? 'field--locked' : ''}`}>
      <div className="field__head">
        <label htmlFor={id}>{label}</label>
        {lockOwner && <FieldLock owner={lockOwner} />}
      </div>
      <div className="combo-wrapper" ref={wrapperRef}>
        <div className="combo">
          <input
            ref={inputRef}
            id={id}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            aria-activedescendant={highlightedIndex >= 0 && matches[highlightedIndex] ? `${id}-option-${matches[highlightedIndex].id}` : undefined}
            autoComplete="off"
            disabled={disabled}
            placeholder={placeholder ?? 'Search an employee…'}
            value={boxText}
            onFocus={handleFocus}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onBlur={(e) => {
              // Delay closing to allow click on options
              setTimeout(() => {
                if (document.activeElement !== inputRef.current && !panelRef.current?.contains(document.activeElement)) {
                  setEditing(false);
                  setTerm('');
                  setOpen(false);
                  setHighlightedIndex(-1);
                }
              }, 100);
            }}
          />
          {selected && !disabled && (
            <button
              type="button"
              className="btn btn--tiny combo__clear"
              aria-label={`Clear ${label}`}
              tabIndex={-1}
              onMouseDown={handleClear}
            >✕</button>
          )}
        </div>

        {open && !disabled && (
          <div className="combo__panel" ref={panelRef} role="region" aria-label={`${label} options`}>
            {options.length === 0 && <p className="muted combo__empty">{emptyMessage}</p>}
            {options.length > 0 && matches.length === 0 && (
              <p className="muted combo__empty">No employee matches “{term.trim()}”.</p>
            )}
            {matches.length > 0 && (
              <ul className="combo__list" ref={listRef} id={`${id}-list`} role="listbox" aria-label={`${label} options`}>
                {matches.map((option, index) => (
                  <li
                    key={option.id}
                    role="option"
                    id={`${id}-option-${option.id}`}
                    aria-selected={String(option.id) === value}
                    aria-highlighted={index === highlightedIndex}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      onChange(String(option.id));
                      closePanel();
                    }}
                  >
                    <button
                      type="button"
                      className={`combo__option ${String(option.id) === value ? 'combo__option--on' : ''} ${index === highlightedIndex ? 'combo__option--highlighted' : ''}`}
                    >
                      {employeeOptionLabel(option)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {fieldError && <p className="field-error">{fieldError}</p>}
    </div>
  );
}