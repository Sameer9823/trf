import { afterEach, describe, expect, test, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { BulkReassignDialog } from './ArdEmployeeDetail';

interface Call { method: string; path: string; body?: unknown }

const OPEN_TESTS = [
  { assignmentId: 101, assignmentVersion: 3, trfId: 1, trfNumber: 'TRF/2026/0001', arNumber: null, productName: 'P1', testName: 'Assay', testStatus: 'Assigned', reviewStatus: null, assignedDate: null, dueDate: null, isDelayed: false },
  { assignmentId: 102, assignmentVersion: 1, trfId: 2, trfNumber: 'TRF/2026/0002', arNumber: null, productName: 'P2', testName: 'Moisture', testStatus: 'In Progress', reviewStatus: null, assignedDate: null, dueDate: null, isDelayed: false },
  // A completed test must NOT be part of the bulk move.
  { assignmentId: 103, assignmentVersion: 9, trfId: 3, trfNumber: 'TRF/2026/0003', arNumber: null, productName: 'P3', testName: 'pH', testStatus: 'Completed', reviewStatus: 'Approved', assignedDate: null, dueDate: null, isDelayed: false },
];

function mount() {
  const calls: Call[] = [];
  (window as unknown as { trf: unknown }).trf = {
    request: async (req: Call) => {
      calls.push(req);
      if (req.method === 'GET' && /\/api\/ard-assignments\/employees\/\d+/.test(req.path)) {
        return { ok: true, status: 200, data: { items: OPEN_TESTS, total: 3, page: 1, pageSize: 200, pageCount: 1, summary: {} } };
      }
      if (req.method === 'GET' && req.path === '/api/lookups/ard-analysts') {
        return { ok: true, status: 200, data: { items: [{ id: 9, fullName: 'New Analyst' }] } };
      }
      if (req.method === 'POST' && req.path === '/api/ard-assignments/reassign-bulk') {
        return { ok: true, status: 200, data: { items: [] } };
      }
      return { ok: false, status: 404, error: 'not found' };
    },
  };
  const onSaved = vi.fn(async () => {});
  const onClose = vi.fn();
  render(<BulkReassignDialog employeeId={5} employeeName="Absent Analyst" onClose={onClose} onSaved={onSaved} />);
  return { calls, onSaved, onClose };
}

afterEach(() => cleanup());

describe('BulkReassignDialog', () => {
  test('the Reassign button is disabled until a reason and a replacement are chosen', async () => {
    mount();
    const button = await screen.findByRole('button', { name: /reassign all/i }) as HTMLButtonElement;
    // Only the two open tests are listed (the completed one is excluded).
    await waitFor(() => expect(screen.getByText(/2 open test/i)).toBeTruthy());
    expect(button.disabled).toBe(true);

    // Pick a replacement but no reason: still disabled.
    fireEvent.change(screen.getByLabelText(/replacement analyst/i), { target: { value: '9' } });
    expect(button.disabled).toBe(true);

    // Choose a reason: now enabled.
    fireEvent.click(screen.getByRole('button', { name: 'Absent' }));
    expect(button.disabled).toBe(false);
  });

  test('the bulk flow posts one reason and the open tests to reassign-bulk', async () => {
    const { calls, onSaved } = mount();
    await screen.findByText(/2 open test/i);
    fireEvent.change(screen.getByLabelText(/replacement analyst/i), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: 'On leave' }));
    fireEvent.click(screen.getByRole('button', { name: /reassign all/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/ard-assignments/reassign-bulk');
    expect(post).toBeTruthy();
    const body = post!.body as { reason: string; items: { assignmentId: number; version: number; analystIds: number[] }[] };
    expect(body.reason).toBe('On leave');
    expect(body.items.map((i) => i.assignmentId).sort()).toEqual([101, 102]);
    expect(body.items.every((i) => i.analystIds[0] === 9)).toBe(true);
  });
});