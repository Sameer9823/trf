import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { EmployeeOption, EmployeeProfile, TrfDetail } from '@trf/shared';
import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import { AuthContext } from '../lib/auth';
import type { AuthSessionState } from '../lib/auth';
import { TrfForm } from './TrfForm';

/**
 * The TRF screen is one record on one page: Part A is filled in by the
 * Formulation team and the ARD block starts below it. These tests check that
 * the fields really appear in the agreed order, and that "Sample Submitted By"
 * is a searchable employee dropdown rather than a free-text box.
 */

interface RecordedRequest {
  method: string;
  path: string;
  body?: unknown;
}

const calls: RecordedRequest[] = [];

const EMPLOYEES: EmployeeOption[] = [
  { id: 7, fullName: 'Aarti Sharma', designation: 'Analyst', departmentName: 'ARD' },
  { id: 8, fullName: 'Bhavin Patel', designation: 'Executive', departmentName: 'Formulation' },
  { id: 9, fullName: 'Chitra Nair', designation: null, departmentName: 'Quality' },
];

function formulationEmployee(): EmployeeProfile {
  return {
    id: 1,
    employeeCode: 'EMP001',
    fullName: 'Test Formulation',
    designation: null,
    email: 'test@example.com',
    username: 'testform',
    role: 'Analyst',
    departmentId: 1,
    departmentName: 'Formulation',
    isActive: true,
    mustChangePassword: false,
    lastLoginAt: null,
    version: 1,
    createdAt: '2026-01-01T00:00:00Z',
  };
}

function makeAuthValue(employee: EmployeeProfile): AuthSessionState {
  return {
    employee,
    status: 'signed-in',
    can: () => false,
    canAccessModule: () => true,
    login: async () => ({ ok: true }),
    logout: async () => {},
  };
}

function makeTrf(overrides: Partial<TrfDetail> = {}): TrfDetail {
  return {
    id: 1,
    trfNumber: 'TRF-2026-00001',
    trfDate: '2026-02-01',
    customerId: 1,
    customerName: 'Test Customer',
    productId: 2,
    productName: 'Test Product',
    batchNumber: 'B-1',
    priority: 'Normal',
    status: 'New',
    requiredCompletionDate: '2026-03-01',
    assignedEmployeeId: null,
    assignedEmployeeName: null,
    departmentId: 1,
    departmentName: 'Formulation',
    isOverdue: false,
    createdAt: '2026-02-01T00:00:00Z',
    updatedAt: '2026-02-01T00:00:00Z',
    version: 1,
    sampleQuantity: '100 g',
    sampleReceivedDate: null,
    requestedAnalysis: 'Assay',
    specialInstructions: 'Keep cold',
    remarks: null,
    createdBy: 1,
    createdByName: 'Test Formulation',
    batchSize: '1000',
    dosageForm: 'Tablet',
    manufacturingLocation: 'Plant A',
    labelClaim: '100mg',
    packSize: '500',
    packType: 'Bottle',
    storageCondition: '2-8C',
    storagePeriod: '24 months',
    manufacturingDate: '2026-01-15',
    expiryDate: '2028-01-15',
    analysisPurpose: 'Stability',
    sampleGivenBy: null,
    sampleSubmittedById: null,
    sampleSubmittedByName: null,
    signatureDate: null,
    ardNumber: 'ARD-2026-00001',
    ardAnalystId: null,
    stage: 'Sample Received',
    analystName: null,
    analysisStartDate: null,
    reportingStatus: 'Pending',
    coaStatus: 'Pending',
    tat: null,
    workflowStatus: 'Received',
    remarksStatus: 'Pending',
    sampleReceivedBy: null,
    sampleReceivedByName: null,
    ardRemarksStatus: 'Pending',
    ardRemarks: null,
    finalizedAt: null,
    deletedAt: null,
    ...overrides,
  } as TrfDetail;
}

function makeTrfBridge(trf: TrfDetail, employees: EmployeeOption[] = EMPLOYEES) {
  return {
    getConfig: async () => ({ serverUrl: 'http://localhost:4000' }),
    setServerUrl: async () => ({ ok: true as const, serverUrl: 'http://localhost:4000' }),
    request: async (req: { method: string; path: string; body?: unknown }): Promise<{
      ok: boolean; status: number; data?: unknown; error?: string;
    }> => {
      calls.push({ method: req.method, path: req.path, body: req.body });
      if (req.method === 'GET' && req.path === '/api/lookups/customers') {
        return { ok: true, status: 200, data: { items: [] } };
      }
      if (req.method === 'GET' && req.path === '/api/lookups/products') {
        return { ok: true, status: 200, data: { items: [] } };
      }
      if (req.method === 'GET' && req.path === '/api/employees/for-select') {
        return { ok: true, status: 200, data: { items: employees } };
      }
      if (req.method === 'GET' && req.path === '/api/trfs/1') {
        return { ok: true, status: 200, data: trf };
      }
      if (req.method === 'PATCH' && req.path === '/api/trfs/1') {
        return { ok: true, status: 200, data: trf };
      }
      return { ok: false, status: 404, error: 'Not found' };
    },
    login: async () => ({ ok: false as const, status: 401, error: 'Not implemented' }),
    logout: async () => ({ ok: true as const }),
    session: async () => ({ ok: true as const, signedIn: true }),
    printCoa: async () => ({ ok: false as const }),
    printTrf: async () => ({ ok: false as const }),
    exportReport: async () => ({ ok: false as const }),
    onSignedOut: () => () => {},
  };
}

function renderForm(trf: TrfDetail = makeTrf(), employees: EmployeeOption[] = EMPLOYEES) {
  (window as unknown as { trf: unknown }).trf = makeTrfBridge(trf, employees);
  render(
    <AuthContext.Provider value={makeAuthValue(formulationEmployee())}>
      <MemoryRouter initialEntries={['/trfs/1/edit']}>
        <Routes>
          <Route path="/trfs/:id/edit" element={<TrfForm />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

/** The labels of the fields of one card, in the order they are rendered. */
function labelsOf(cardTitle: string): string[] {
  const card = screen.getByRole('heading', { name: cardTitle }).closest('.card');
  if (!card) throw new Error(`the card "${cardTitle}" is missing`);
  return Array.from(card.querySelectorAll('.field__head label'))
    .map((el) => (el.textContent ?? '').replace('*', '').trim());
}

beforeEach(() => {
  calls.length = 0;
  cleanup();
});

afterEach(() => {
  cleanup();
});

test('the TRF screen has the Part A card first and the ARD card second', async () => {
  renderForm();

  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Part A — Formulation' })).toBeTruthy();
  });

  const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
  expect(headings.indexOf('Part A — Formulation')).toBeLessThan(headings.indexOf('ARD — Analysis Details'));
});

test('the Part A fields are in the agreed order', async () => {
  renderForm();

  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Part A — Formulation' })).toBeTruthy();
  });

  expect(labelsOf('Part A — Formulation')).toEqual([
    'TRF No.',
    'Date of Request',
    'Product Name',
    'Batch Number',
    'Batch Size',
    'Market/Customer',
    'Dosage Form',
    'Manufacturing Location',
    'Label Claim',
    'Pack Size',
    'Pack Type',
    'Storage Condition',
    'Storage Period',
    'Manufacturing Date',
    'Expiry Date',
    'Test Requested',
    'Test Details / Special Instructions',
    'Analysis Required For / Purpose',
    'Required Completion Date',
    'Sample Quantity',
    'Sample Submitted By',
    'Status',
    'Remarks',
    'Signature / Date',
  ]);
});

test('the ARD block fields are in the agreed order', async () => {
  renderForm();

  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'ARD — Analysis Details' })).toBeTruthy();
  });

  expect(labelsOf('ARD — Analysis Details')).toEqual([
    'A.R. No.',
    'Stage',
    'Test Requested',
    'Test Details',
    'Analyst Name',
    'Date of Analysis',
    'Reporting',
    'COA',
    'Status',
    'ARD Remark',
    'TAT',
    'Final Status',
    'Sample Received By',
    'Sample Received Date',
  ]);
});

test('Sample Submitted By is a searchable employee dropdown, not a free-text box', async () => {
  const user = userEvent.setup();
  renderForm();

  await waitFor(() => {
    expect(calls.some((c) => c.path === '/api/employees/for-select')).toBe(true);
  });

  const combo = screen.getByLabelText('Sample Submitted By') as HTMLInputElement;
  expect(combo.tagName).toBe('INPUT');
  expect(combo.getAttribute('role')).toBe('combobox');

  await user.click(combo);
  await user.type(combo, 'bha');

  const list = screen.getByRole('listbox', { name: 'Sample Submitted By options' });
  const options = within(list).getAllByRole('option');
  expect(options).toHaveLength(1);
  expect(options[0].textContent).toContain('Bhavin Patel');
  // The option shows the name and the department.
  expect(options[0].textContent).toContain('Formulation');
});

test('picking an employee in the Sample Submitted By dropdown keeps the choice', async () => {
  const user = userEvent.setup();
  renderForm();

  await waitFor(() => {
    expect(calls.some((c) => c.path === '/api/employees/for-select')).toBe(true);
  });

  const combo = screen.getByLabelText('Sample Submitted By');
  await user.click(combo);
  const list = screen.getByRole('listbox', { name: 'Sample Submitted By options' });
  await user.click(within(list).getByRole('option', { name: /Chitra Nair/ }));

  await waitFor(() => {
    expect((screen.getByLabelText('Sample Submitted By') as HTMLInputElement).value).toBe('Chitra Nair');
  });
});

test('the legacy free-text sample submitter is shown read-only as "Previously entered"', async () => {
  renderForm(makeTrf({ sampleGivenBy: 'QA Dept', sampleSubmittedById: null }));

  await waitFor(() => {
    expect(screen.getByText(/Previously entered: QA Dept/)).toBeTruthy();
  });

  // The dropdown is empty, because no employee has been picked yet.
  const combo = screen.getByLabelText('Sample Submitted By') as HTMLInputElement;
  expect(combo.value).toBe('');
});

test('an empty employee list shows a clear message instead of an empty box', async () => {
  const user = userEvent.setup();
  renderForm(makeTrf(), []);

  await waitFor(() => {
    expect(calls.some((c) => c.path === '/api/employees/for-select')).toBe(true);
  });

  await user.click(screen.getByLabelText('Sample Submitted By'));
  expect(screen.getByText('No employees are available to pick.')).toBeTruthy();
});

test('the read-only fields carry a lock that names the owner', async () => {
  renderForm();

  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Part A — Formulation' })).toBeTruthy();
  });

  const locks = screen.getAllByLabelText(/Read-only for you\. Set automatically by the system\./);
  expect(locks.length).toBeGreaterThan(0);

  const trfNumber = screen.getByLabelText('TRF No.') as HTMLInputElement;
  expect(trfNumber.readOnly).toBe(true);
  expect(trfNumber.disabled).toBe(true);
});
