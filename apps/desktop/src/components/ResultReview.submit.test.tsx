import { render, cleanup } from '@testing-library/react';
import { afterEach, test, expect, vi } from 'vitest';
import { SubmitResultModal, type SubmitTarget } from './ResultReview';

afterEach(() => {
  cleanup();
  delete (window as unknown as { trf?: unknown }).trf;
});

const TARGET: SubmitTarget = {
  assignmentId: 11,
  version: 1,
  testName: 'Assay',
  trfNumber: 'TRF/2026/0001',
};

function mount() {
  (window as unknown as { trf: unknown }).trf = {
    request: vi.fn(async () => ({ ok: true, status: 200, data: {} })),
    uploadResultFile: vi.fn(async () => ({ ok: true })),
    viewPdf: vi.fn(async () => ({ ok: true })),
    downloadBlob: vi.fn(async () => ({ ok: true })),
  };
  return render(<SubmitResultModal target={TARGET} onClose={() => {}} onSubmitted={() => {}} />);
}

test('the footer sits outside the scrolling body and every field stays reachable', () => {
  mount();
  const dialog = document.querySelector('.modal--scroll')!;
  expect(dialog).not.toBeNull();

  const body = dialog.querySelector('.modal__body')!;
  const footer = dialog.querySelector('.modal__footer')!;
  expect(body).not.toBeNull();
  expect(footer).not.toBeNull();
  // Actions are pinned, not nested in the region that scrolls.
  expect(body.contains(footer)).toBe(false);
  expect(footer.parentElement).toBe(dialog);

  // The Outcome select and date fields that the old sticky footer used to hide
  // all live inside the scrolling body, so they can be scrolled to and used.
  for (const id of ['rs-value', 'rs-unit', 'rs-text', 'rs-method', 'rs-spec', 'rs-outcome', 'rs-start', 'rs-done', 'rs-remarks']) {
    const el = dialog.querySelector(`#${id}`)!;
    expect(el).not.toBeNull();
    expect(body.contains(el)).toBe(true);
  }
});

test('the intro icon is an SVG rather than an emoji', () => {
  mount();
  const icon = document.querySelector('.result-modal__icon')!;
  expect(icon).not.toBeNull();
  expect(icon.querySelector('svg')).not.toBeNull();
  expect(icon.textContent).not.toContain('📄');
});