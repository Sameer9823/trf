import { afterEach, describe, expect, test, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';
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

function mountChangeAnalystDialog(assignment: ArdTestAssignment) {
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
  render(<ChangeAnalystDialog assignment={assignment} employees={mockEmployees} workload={mockWorkload} onClose={onClose} onSaved={onSaved} />);
  return { calls, onSaved, onClose };
}

afterEach(() => cleanup());

describe('ChangeAnalystDialog', () => {
  test('one analyst: no extra step, payload analystIds is [replacement]', async () => {
    const assignment = makeAssignment({ id: 101, analysts: [{ id: 1, fullName: 'Analyst A', employeeCode: 'E001', departmentName: 'ARD', assignedAt: new Date().toISOString() }], analystIds: [1] });

    const { calls, onSaved } = mountChangeAnalystDialog(assignment);

    // Title shows who is being replaced
    await waitFor(() => expect(screen.getByText(/Replace Analyst A on Assay/)).toBeTruthy());

    // No "Replace" dropdown when only one analyst
    expect(screen.queryByLabelText(/Replace/)).not.toBeInTheDocument();

    // Pick replacement
    fireEvent.change(screen.getByLabelText(/New analyst/), { target: { value: '2' } });
    // Choose reason
    fireEvent.click(screen.getByRole('button', { name: 'Absent' }));
    // Submit
    fireEvent.click(screen.getByRole('button', { name: /Change analyst/ }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const patch = calls.find(c => c.method === 'PATCH');
    expect(patch).toBeTruthy();
    expect((patch!.body as any).analystIds).toEqual([2]);
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

    const { calls, onSaved } = mountChangeAnalystDialog(assignment);

    // Title shows generic replace text when multiple analysts
    await waitFor(() => expect(screen.getByText(/Replace analyst on Assay/)).toBeTruthy());

    // "Replace" dropdown is present
    const replaceSelect = screen.getByLabelText(/Replace/);
    expect(replaceSelect).toBeInTheDocument();

    // Initially submit button is disabled (no replace choice)
    const submitBtn = screen.getByRole('button', { name: /Change analyst/ });
    expect(submitBtn).toBeDisabled();

    // Select which analyst to replace (Analyst B, id=2)
    fireEvent.change(replaceSelect, { target: { value: '2' } });

    // Pick replacement (Analyst C, id=3)
    fireEvent.change(screen.getByLabelText(/New analyst/), { target: { value: '3' } });

    // Choose reason
    fireEvent.click(screen.getByRole('button', { name: 'Absent' }));

    // Now submit should be enabled
    expect(submitBtn).not.toBeDisabled();

    // Submit
    fireEvent.click(submitBtn);

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const patch = calls.find(c => c.method === 'PATCH');
    expect(patch).toBeTruthy();
    const body = patch!.body as any;
    expect(body.analystIds).toEqual([1, 3]); // A stays, B replaced by C
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

    const { onSaved } = mountChangeAnalystDialog(assignment);

    const submitBtn = screen.getByRole('button', { name: /Change analyst/ });
    expect(submitBtn).toBeDisabled();

    // Only replace choice
    fireEvent.change(screen.getByLabelText(/Replace/), { target: { value: '2' } });
    expect(submitBtn).toBeDisabled();

    // Only replacement
    fireEvent.change(screen.getByLabelText(/New analyst/), { target: { value: '3' } });
    expect(submitBtn).toBeDisabled();

    // Only reason
    fireEvent.click(screen.getByRole('button', { name: 'On leave' }));
    expect(submitBtn).toBeDisabled();

    // Replace + replacement
    fireEvent.change(screen.getByLabelText(/Replace/), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText(/New analyst/), { target: { value: '3' } });
    expect(submitBtn).toBeDisabled();

    // Replace + reason
    fireEvent.change(screen.getByLabelText(/Replace/), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'On leave' }));
    expect(submitBtn).toBeDisabled();

    // Replacement + reason
    fireEvent.change(screen.getByLabelText(/New analyst/), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'On leave' }));
    expect(submitBtn).toBeDisabled();

    // All three: enabled
    fireEvent.change(screen.getByLabelText(/Replace/), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText(/New analyst/), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'On leave' }));
    expect(submitBtn).not.toBeDisabled();
  });

  test('cannot pick an analyst already on the test (same person guard)', async () => {
    const assignment = makeAssignment({ id: 104 });

    mountChangeAnalystDialog(assignment);

    // Try to pick the same analyst
    fireEvent.change(screen.getByLabelText(/New analyst/), { target: { value: '1' } });

    // Error should show
    await waitFor(() => expect(screen.getByText(/already the assigned analyst/)).toBeTruthy());

    // Submit should remain disabled
    const submitBtn = screen.getByRole('button', { name: /Change analyst/ });
    expect(submitBtn).toBeDisabled();
  });

  test('picker excludes current analysts when there are multiple', async () => {
    const assignment = makeAssignment({
      id: 105,
      analysts: [
        { id: 1, fullName: 'Analyst A', employeeCode: 'E001', departmentName: 'ARD', assignedAt: new Date().toISOString() },
        { id: 2, fullName: 'Analyst B', employeeCode: 'E002', departmentName: 'ARD', assignedAt: new Date().toISOString() },
      ],
      analystIds: [1, 2],
    });

    mountChangeAnalystDialog(assignment);

    // Select which analyst to replace (A)
    fireEvent.change(screen.getByLabelText(/Replace/), { target: { value: '1' } });

    // The replacement dropdown should not include A or B (both are current analysts)
    const newAnalystSelect = screen.getByLabelText(/New analyst/);
    fireEvent.mouseDown(newAnalystSelect);
    const options = screen.getAllByRole('option');
    const optionValues = options.map(o => o.getAttribute('value')).filter(v => v !== '');
    expect(optionValues).not.toContain('1'); // Analyst A excluded
    expect(optionValues).not.toContain('2'); // Analyst B excluded
    expect(optionValues).toContain('3'); // Analyst C available
  });
});