import { afterEach, describe, expect, test, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { ChangeAnalystDialog } from './TrfForm';
import type { ArdTestAssignment, EmployeeOption } from '@trf/shared';

interface Call { method: string; path: string; body?: unknown }

const mockEmployees: EmployeeOption[] = [
  { id: 1, employeeCode: 'E001', fullName: 'Analyst A', designation: 'Analyst', departmentName: 'ARD', team: 'ARD' },
  { id: 2, employeeCode: 'E002', fullName: 'Analyst B', designation: 'Analyst', departmentName: 'ARD', team: 'ARD' },
  { id: 3, employeeCode: 'E003', fullName: 'Analyst C', designation: 'Analyst', departmentName: 'ARD', team: 'ARD' },
];

const mockWorkload: Record<number, number> = { 1: 2, 2: 1, 3: 0 };

function makeAssignment(overrides: Partial<ArdTestAssignment> = {}): ArdTestAssignment {
  return {
    id: 101,
    trfId: 1,
    testRequestedOptionId: 1,
    testName: 'Assay',
    status: 'Assigned',
    assignedBy: 1,
    assignedAt: new Date().toISOString(),
    dueDate: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 3,
    analysts: [{ id: 1, fullName: 'Analyst A', employeeCode: 'E001', departmentName: 'ARD', assignedAt: new Date().toISOString() }],
    analystIds: [1],
    resultValue: null,
    resultText: null,
    unit: null,
    methodUsed: null,
    specification: null,
    lowerLimit: null,
    upperLimit: null,
    outcome: null,
    remarks: null,
    enteredBy: null,
    enteredByName: null,
    enteredAt: null,
    reviewStatus: null,
    submittedAt: null,
    reviewedBy: null,
    reviewedByName: null,
    reviewedAt: null,
    reviewReason: null,
    resultMode: null,
    fileName: null,
    fileSize: null,
    analysisStartDate: null,
    completionDate: null,
    completedBy: null,
    completedByName: null,
    ...overrides,
  };
}

function mountChangeAnalystDialog(assignment: ArdTestAssignment, employees = mockEmployees) {
  const calls: Call[] = [];
  (window as unknown as { trf: unknown }).trf = {
    request: async (req: Call) => {
      calls.push(req);
      if (req.method === 'PATCH' && req.path.startsWith('/api/ard-assignments/')) {
        return { ok: true, status: 200, data: { ...assignment, analystIds: (req.body as any).analystIds, version: assignment.version + 1 } };
      }
      return { ok: false, status: 404, error: 'not found' };
    },
  };
  const onSaved = vi.fn(async () => {});
  const onClose = vi.fn();
  const { unmount } = render(<ChangeAnalystDialog assignment={assignment} employees={employees} workload={mockWorkload} onClose={onClose} onSaved={onSaved} />);
  return { calls, onSaved, onClose, unmount };
}

afterEach(() => cleanup());

describe('ChangeAnalystDialog', () => {
  test('one analyst: no extra step, payload analystIds is [replacement]', async () => {
    const assignment = makeAssignment({ id: 101, analysts: [{ id: 1, fullName: 'Analyst A', employeeCode: 'E001', departmentName: 'ARD', assignedAt: new Date().toISOString() }], analystIds: [1] });

    const { calls, onSaved, unmount } = mountChangeAnalystDialog(assignment);

    // Title shows who is being replaced
    await waitFor(() => expect(screen.getByText(/Replace Analyst A on Assay/)).toBeTruthy());

    // No "Replace" dropdown when only one analyst
    expect(screen.queryByLabelText(/Replace/)).not.toBeInTheDocument();

    // Pick replacement
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/New analyst/), { target: { value: '2' } });
    });
    // Choose reason
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Absent' }));
    });
    // Submit
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Change analyst/ }));
    });

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const patch = calls.find(c => c.method === 'PATCH');
    expect(patch).toBeTruthy();
    expect((patch!.body as any).analystIds).toEqual([2]);
    unmount();
  });

  test('two analysts A and B, replace B with C: payload is [A, C] and A is not dropped', async () => {
    const assignment = makeAssignment({
      id: 102,
      analysts: [
        { id: 1, fullName: 'Analyst A', employeeCode: 'E001', departmentName: 'ARD', assignedAt: new Date().toISOString() },
        { id: 2, fullName: 'Analyst B', employeeCode: 'E002', departmentName: 'ARD', assignedAt: new Date().toISOString() },
      ],
      analystIds: [1, 2],
    });

    const { calls, onSaved, unmount } = mountChangeAnalystDialog(assignment);

    // Title shows generic replace text when multiple analysts
    await waitFor(() => expect(screen.getByText(/Replace analyst on Assay/)).toBeTruthy());

    // "Replace" dropdown is present
    const replaceSelect = screen.getByLabelText(/Replace/);
    expect(replaceSelect).toBeInTheDocument();

    // Initially submit button is disabled (no replace choice)
    const submitBtn = screen.getByRole('button', { name: /Change analyst/ });
    expect(submitBtn).toBeDisabled();

    // Select which analyst to replace (Analyst B, id=2)
    await act(async () => {
      fireEvent.change(replaceSelect, { target: { value: '2' } });
    });

    // Pick replacement (Analyst C, id=3)
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/New analyst/), { target: { value: '3' } });
    });

    // Choose reason
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Absent' }));
    });

    // Now submit should be enabled
    expect(submitBtn).not.toBeDisabled();

    // Submit
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const patch = calls.find(c => c.method === 'PATCH');
    expect(patch).toBeTruthy();
    const body = patch!.body as any;
    expect(body.analystIds).toEqual([1, 3]); // A stays, B replaced by C
    unmount();
  });

  test('submit button stays disabled until a replace choice (when there are two), a replacement and a reason are set', async () => {
    const assignment = makeAssignment({
      id: 103,
      analysts: [
        { id: 1, fullName: 'Analyst A', employeeCode: 'E001', departmentName: 'ARD', assignedAt: new Date().toISOString() },
        { id: 2, fullName: 'Analyst B', employeeCode: 'E002', departmentName: 'ARD', assignedAt: new Date().toISOString() },
      ],
      analystIds: [1, 2],
    });

    // Test each condition separately with fresh mounts
    {
      const { unmount } = mountChangeAnalystDialog(assignment);
      const submitBtn = screen.getByRole('button', { name: /Change analyst/ });
      expect(submitBtn).toBeDisabled();
      await act(async () => {
        fireEvent.change(screen.getByLabelText(/Replace/), { target: { value: '2' } });
      });
      expect(submitBtn).toBeDisabled();
      unmount();
    }

    {
      const { unmount } = mountChangeAnalystDialog(assignment);
      const submitBtn = screen.getByRole('button', { name: /Change analyst/ });
      await act(async () => {
        fireEvent.change(screen.getByLabelText(/New analyst/), { target: { value: '3' } });
      });
      expect(submitBtn).toBeDisabled();
      unmount();
    }

    {
      const { unmount } = mountChangeAnalystDialog(assignment);
      const submitBtn = screen.getByRole('button', { name: /Change analyst/ });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'On leave' }));
      });
      expect(submitBtn).toBeDisabled();
      unmount();
    }

    {
      const { unmount } = mountChangeAnalystDialog(assignment);
      const submitBtn = screen.getByRole('button', { name: /Change analyst/ });
      await act(async () => {
        fireEvent.change(screen.getByLabelText(/Replace/), { target: { value: '2' } });
        fireEvent.change(screen.getByLabelText(/New analyst/), { target: { value: '3' } });
      });
      expect(submitBtn).toBeDisabled();
      unmount();
    }

    {
      const { unmount } = mountChangeAnalystDialog(assignment);
      const submitBtn = screen.getByRole('button', { name: /Change analyst/ });
      await act(async () => {
        fireEvent.change(screen.getByLabelText(/Replace/), { target: { value: '2' } });
        fireEvent.click(screen.getByRole('button', { name: 'On leave' }));
      });
      expect(submitBtn).toBeDisabled();
      unmount();
    }

    {
      const { unmount } = mountChangeAnalystDialog(assignment);
      const submitBtn = screen.getByRole('button', { name: /Change analyst/ });
      await act(async () => {
        fireEvent.change(screen.getByLabelText(/New analyst/), { target: { value: '3' } });
        fireEvent.click(screen.getByRole('button', { name: 'On leave' }));
      });
      expect(submitBtn).toBeDisabled();
      unmount();
    }

    // All three: enabled
    const { unmount } = mountChangeAnalystDialog(assignment);
    const submitBtn = screen.getByRole('button', { name: /Change analyst/ });
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/Replace/), { target: { value: '2' } });
      fireEvent.change(screen.getByLabelText(/New analyst/), { target: { value: '3' } });
      fireEvent.click(screen.getByRole('button', { name: 'On leave' }));
    });
    expect(submitBtn).not.toBeDisabled();
    unmount();
  });

  test('cannot pick an analyst already on the test (same person guard)', async () => {
    const assignment = makeAssignment({ id: 104 });

    const { unmount } = mountChangeAnalystDialog(assignment);

    // Try to pick the same analyst
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/New analyst/), { target: { value: '1' } });
    });

    // Error should show
    await waitFor(() => expect(screen.getByText(/already the assigned analyst/)).toBeTruthy());

    // Submit should remain disabled
    const submitBtn = screen.getByRole('button', { name: /Change analyst/ });
    expect(submitBtn).toBeDisabled();
    unmount();
  });

  test('picker excludes current analysts when there are multiple (parent component filters)', async () => {
    // The parent component (TrfForm) filters the employees list before passing to the dialog
    // So the dialog receives only non-current analysts. This test verifies the dialog
    // works correctly with a pre-filtered list.
    const assignment = makeAssignment({
      id: 105,
      analysts: [
        { id: 1, fullName: 'Analyst A', employeeCode: 'E001', departmentName: 'ARD', assignedAt: new Date().toISOString() },
        { id: 2, fullName: 'Analyst B', employeeCode: 'E002', departmentName: 'ARD', assignedAt: new Date().toISOString() },
      ],
      analystIds: [1, 2],
    });

    // Simulate parent filtering: only pass Analyst C (not A or B)
    const filteredEmployees = mockEmployees.filter(e => ![1, 2].includes(e.id));
    const { unmount } = mountChangeAnalystDialog(assignment, filteredEmployees);

    // Select which analyst to replace (A)
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/Replace/), { target: { value: '1' } });
    });

    // The replacement dropdown should only have Analyst C (id=3)
    const newAnalystSelect = screen.getByLabelText(/New analyst/);
    await act(async () => {
      fireEvent.mouseDown(newAnalystSelect);
    });
    // Get options only from the "New analyst" select
    const newAnalystOptions = newAnalystSelect.querySelectorAll('option');
    const optionValues = Array.from(newAnalystOptions).map(o => o.getAttribute('value')).filter(v => v !== '');
    expect(optionValues).not.toContain('1'); // Analyst A excluded
    expect(optionValues).not.toContain('2'); // Analyst B excluded
    expect(optionValues).toContain('3'); // Analyst C available
    unmount();
  });
});