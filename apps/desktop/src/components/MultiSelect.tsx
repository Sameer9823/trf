import { useEffect, useMemo, useRef, useState } from 'react';
import { FieldLock } from './Fields';
import type { FieldOwner } from './Fields';

export interface Option {
  id: number;
  name: string;
}

export interface MultiSelectProps {
  id: string;
  label: string;
  /** Selected option IDs. */
  value: number[];
  /** Available options. */
  options: Option[];
  /** Called with the updated list of IDs when selections change. */
  onChange: (value: number[]) => void;
  /** Called with the "Other" text field value when the Other option is used. */
  onOtherChange?: (text: string) => void;
  /** Current Other text. */
  otherValue?: string;
  disabled?: boolean;
  fieldError?: string;
  placeholder?: string;
  emptyMessage?: string;
  /** Whether to show the "Other" option. */
  showOther?: boolean;
  /** The "Other" option ID in the options list, or undefined if Other is not an option. */
  otherOptionId?: number;
  lockOwner?: FieldOwner;
}

/**
 * A searchable multi-select dropdown with chips, Select All / Clear All,
 * and an inline "Other" text field when the Other option is selected.
 */
export function MultiSelect({
  id, label, value, options, onChange, onOtherChange, otherValue,
  disabled, fieldError, placeholder = 'Search…', emptyMessage = 'No options are available.',
  showOther = false, otherOptionId, lockOwner,
}: MultiSelectProps) {
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const isOtherSelected = showOther && otherOptionId !== undefined && value.includes(otherOptionId);

  const matches = useMemo(() => {
    const needle = term.trim().toLowerCase();
    const opts = options.filter((o) => !value.includes(o.id));
    if (!needle) return opts;
    return opts.filter((o) => o.name.toLowerCase().includes(needle));
  }, [options, term, value]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
        setTerm('');
        setHighlightedIndex(-1);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  useEffect(() => {
    if (highlightedIndex >= 0 && listRef.current) {
      const option = listRef.current.children[highlightedIndex] as HTMLElement;
      if (option) option.scrollIntoView({ block: 'nearest' });
    }
  }, [highlightedIndex]);

  useEffect(() => {
    setHighlightedIndex(-1);
  }, [matches]);

  const openPanel = () => {
    if (!disabled) {
      setOpen(true);
      setHighlightedIndex(-1);
    }
  };

  const closePanel = () => {
    setOpen(false);
    setTerm('');
    setHighlightedIndex(-1);
  };

  const toggleOption = (optionId: number) => {
    const newValue = value.includes(optionId)
      ? value.filter((id) => id !== optionId)
      : [...value, optionId];
    onChange(newValue);
    if (showOther && otherOptionId !== undefined && optionId === otherOptionId) {
      onOtherChange?.('');
    }
  };

  const toggleOther = () => {
    if (otherOptionId === undefined) return;
    toggleOption(otherOptionId);
  };

  const handleSelectAll = (e: React.MouseEvent) => {
    e.preventDefault();
    onChange(options.map((o) => o.id));
    closePanel();
  };

  const handleClearAll = (e: React.MouseEvent) => {
    e.preventDefault();
    onChange([]);
    onOtherChange?.('');
    closePanel();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown') {
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
          toggleOption(option.id);
        }
        break;
      }
      case 'Escape': {
        e.preventDefault();
        closePanel();
        inputRef.current?.focus();
        break;
      }
      case 'Backspace': {
        if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
          const last = value[value.length - 1];
          if (last !== undefined && showOther && otherOptionId === last) {
            e.preventDefault();
            toggleOption(last);
          }
        }
        break;
      }
      case 'Tab': {
        closePanel();
        break;
      }
    }
  };

  const handleRemoveChip = (optionId: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onChange(value.filter((id) => id !== optionId));
    if (showOther && otherOptionId !== undefined && optionId === otherOptionId) {
      onOtherChange?.('');
    }
  };

  const handleOtherChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onOtherChange?.(e.target.value);
  };

  return (
    <div className={`field ${lockOwner ? 'field--locked' : ''}`}>
      <div className="field__head">
        <label htmlFor={id}>{label}</label>
        {lockOwner && <FieldLock owner={lockOwner} />}
      </div>
      <div className="combo-wrapper" ref={wrapperRef}>
        <div className={`multi-select ${open ? 'multi-select--open' : ''}`}>
          <div className="multi-select__chips">
            {value.length === 0 ? (
              <input
                ref={inputRef}
                id={id}
                type="text"
                className="multi-select__input"
                placeholder={placeholder}
                value={term}
                onChange={(e) => { setTerm(e.target.value); setOpen(true); setHighlightedIndex(-1); }}
                onFocus={openPanel}
                onKeyDown={handleKeyDown}
                disabled={disabled}
                aria-label={label}
              />
            ) : (
              <>
                <input
                  ref={inputRef}
                  type="text"
                  className="multi-select__input"
                  placeholder={value.length === 1 ? '' : ''}
                  value={term}
                  onChange={(e) => { setTerm(e.target.value); setOpen(true); setHighlightedIndex(-1); }}
                  onFocus={() => { if (!disabled) setOpen(true); }}
                  onKeyDown={handleKeyDown}
                  disabled={disabled}
                  aria-label={label}
                />
                {options
                  .filter((o) => value.includes(o.id))
                  .map((option) => (
                    <span key={option.id} className="chip chip--removable">
                      {option.name}
                      <button
                        type="button"
                        className="chip__remove"
                        aria-label={`Remove ${option.name}`}
                        onClick={(e) => handleRemoveChip(option.id, e)}
                      >✕</button>
                    </span>
                  ))}
              </>
            )}
            <button
              type="button"
              className="btn btn--tiny multi-select__clear"
              aria-label={`Clear ${label}`}
              tabIndex={-1}
              onClick={(e) => { e.preventDefault(); handleClearAll(e); }}
            >✕</button>
          </div>

          {open && !disabled && (
            <div className="combo__panel" ref={panelRef} role="region" aria-label={`${label} options`}>
              {matches.length === 0 && !isOtherSelected && (
                <p className="muted combo__empty">{term.trim() ? `No option matches “${term.trim()}”.` : emptyMessage}</p>
              )}
              {showOther && isOtherSelected && term === '' && (
                <div className="combo__actions">
                  <button type="button" className="combo__action-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => {}}>Select All</button>
                  <button type="button" className="combo__action-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => {}}>Clear All</button>
                </div>
              )}
              {matches.length > 0 && (
                <ul className="combo__list" ref={listRef} id={`${id}-list`} role="listbox" aria-label={`${label} options`}>
                  {matches.map((option, index) => (
                    <li
                      key={option.id}
                      role="option"
                      id={`${id}-option-${option.id}`}
                      aria-selected={value.includes(option.id)}
                      aria-highlighted={index === highlightedIndex}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => toggleOption(option.id)}
                    >
                      <button
                        type="button"
                        className={`combo__option ${value.includes(option.id) ? 'combo__option--on' : ''} ${index === highlightedIndex ? 'combo__option--highlighted' : ''}`}
                      >
                        <span className="combo__option-check">{value.includes(option.id) ? '✓' : ''}</span>
                        {option.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {showOther && !isOtherSelected && (
                <div className="combo__other">
                  <button
                    type="button"
                    className="combo__option combo__other-btn"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      if (otherOptionId !== undefined) toggleOption(otherOptionId);
                      setOpen(true);
                    }}
                  >
                    <span className="combo__option-check">{isOtherSelected ? '✓' : ''}</span>
                    Other
                  </button>
                  {isOtherSelected && (
                    <input
                      type="text"
                      className="field field--inline"
                      placeholder="Enter Other value…"
                      value={otherValue ?? ''}
                      onChange={handleOtherChange}
                    />
                  )}
                </div>
              )}
            </div>
          )}
          {showOther && isOtherSelected && (
            <div className="field field--inline multi-select__other-input">
              <input
                type="text"
                placeholder="Enter Other…"
                value={otherValue ?? ''}
                onChange={handleOtherChange}
                disabled={disabled}
              />
            </div>
          )}
        </div>
      </div>
      {fieldError && <p className="field-error">{fieldError}</p>}
    </div>
  );
}
