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
  { id: 7, employeeCode: 'EMP007', fullName: 'Aarti Sharma', designation: 'Analyst', departmentName: 'ARD', team: 'ARD' },
  { id: 8, employeeCode: 'EMP008', fullName: 'Bhavin Patel', designation: 'Executive', departmentName: 'Formulation', team: 'FRD' },
  { id: 9, employeeCode: 'EMP009', fullName: 'Chitra Nair', designation: null, departmentName: 'Quality', team: null },
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
    accountType: 'INDIVIDUAL',
    team: null,
    pinFailedAttempts: 0,
    pinLockedUntil: null,
  };
}

function adminEmployee(): EmployeeProfile {
  return { ...formulationEmployee(), fullName: 'Test Admin', username: 'testadmin', role: 'Admin', departmentId: null, departmentName: null };
}

function makeAuthValue(employee: EmployeeProfile): AuthSessionState {
  return {
    employee,
    status: 'signed-in',
    actingEmployeeId: null,
    accountId: null,
    can: () => false,
    canAccessModule: () => true,
    login: async () => ({ ok: true }),
    selectMember: async () => ({ ok: true }),
    switchUser: async () => {},
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
    sampleReceivedById: null,
    sampleReceivedByName: null,
    finalApprovalStatus: 'None',
    lockedAt: null,
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
      if (req.method === 'GET' && req.path === '/api/lookups/employees') {
        return { ok: true, status: 200, data: { items: employees } };
      }
      if (req.method === 'GET' && req.path === '/api/lookups/stages') {
        return { ok: true, status: 200, data: { items: [] } };
      }
      if (req.method === 'GET' && req.path === '/api/trfs/1') {
        return { ok: true, status: 200, data: trf };
      }
      if (req.method === 'PATCH' && req.path === '/api/trfs/1') {
        return { ok: true, status: 200, data: trf };
      }
      if (req.method === 'POST' && req.path === '/api/trfs') {
        return { ok: true, status: 201, data: trf };
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

function renderForm(trf: TrfDetail = makeTrf(), employees: EmployeeOption[] = EMPLOYEES, employee: EmployeeProfile = formulationEmployee()) {
  (window as unknown as { trf: unknown }).trf = makeTrfBridge(trf, employees);
  render(
    <AuthContext.Provider value={makeAuthValue(employee)}>
      <MemoryRouter initialEntries={['/trfs/1/edit']}>
        <Routes>
          <Route path="/trfs/:id/edit" element={<TrfForm />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

function renderCreateForm(employees: EmployeeOption[] = EMPLOYEES, employee: EmployeeProfile = formulationEmployee()) {
  (window as unknown as { trf: unknown }).trf = makeTrfBridge(makeTrf(), employees);
  render(
    <AuthContext.Provider value={makeAuthValue(employee)}>
      <MemoryRouter initialEntries={['/trfs/new']}>
        <Routes>
          <Route path="/trfs/new" element={<TrfForm />} />
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
    'Generic Name',
    'Batch Number',
    'Batch Size',
    'Market/Customer',
    'Dosage Form',
    'Manufacturing Location',
    'Label Claim',
    'Pack Size',
    'Pack Type',
    'Storage Condition (°C)',
    'Storage Period (months)',
    'Manufacturing Date',
    'Expiry Date',
    'Test Requested',
    'Test Details / Special Instructions',
    'Analysis Required For / Purpose',
    'Sample Quantity',
    'Sample Submitted By',
    'Status',
    'Approved By',
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
    'Date of Analysis',
    'Required Completion Date',
    'COA',
    'ARD Remark',
    'Final Status',
    'Approved By',
    'Sample Received Date',
    'Sample Received By',
  ]);
});

test('Sample Submitted By is a read-only field showing the current user', async () => {
  renderForm();

  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Part A — Formulation' })).toBeTruthy();
  });

  const input = screen.getByLabelText('Sample Submitted By') as HTMLInputElement;
  expect(input.tagName).toBe('INPUT');
  expect(input.readOnly).toBe(true);
  expect(input.disabled).toBe(true);
  // Shows the current user's name (from the auth context)
  expect(input.value).toBe('Test Formulation');
  expect(screen.getByText('Automatically set to your account (read-only)')).toBeTruthy();
});

test('the legacy free-text sample submitter is shown read-only as "Previously entered"', async () => {
  renderForm(makeTrf({ sampleGivenBy: 'QA Dept', sampleSubmittedById: null }));

  await waitFor(() => {
    expect(screen.getByText(/Previously entered: QA Dept/)).toBeTruthy();
  });

  // The field shows the current user's name (read-only)
  const input = screen.getByLabelText('Sample Submitted By') as HTMLInputElement;
  expect(input.readOnly).toBe(true);
  expect(input.disabled).toBe(true);
  expect(input.value).toBe('Test Formulation');
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

test('the Formulation Status field is locked for an analyst: disabled dropdown with a System lock', async () => {
  renderForm();

  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Part A — Formulation' })).toBeTruthy();
  });

  const card = screen.getByRole('heading', { name: 'Part A — Formulation' }).closest('.card') as HTMLElement;
  const statusSelect = within(card).getByLabelText('Status') as HTMLSelectElement;

  // An analyst can edit Part A but cannot change the Status — only an admin can.
  expect(statusSelect.disabled).toBe(true);

  // The field carries a System lock so the reason is visible.
  const statusField = statusSelect.closest('.field') as HTMLElement;
  expect(statusField.querySelector('.field-lock')).not.toBeNull();
  expect(statusField.querySelector('.field-lock')?.getAttribute('aria-label'))
    .toBe('Read-only for you. Set automatically by the system.');
});

test('the Formulation Status field is editable for an admin: enabled dropdown with no lock', async () => {
  renderForm(makeTrf(), EMPLOYEES, adminEmployee());

  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Part A — Formulation' })).toBeTruthy();
  });

  const card = screen.getByRole('heading', { name: 'Part A — Formulation' }).closest('.card') as HTMLElement;
  const statusSelect = within(card).getByLabelText('Status') as HTMLSelectElement;

  expect(statusSelect.disabled).toBe(false);

  const statusField = statusSelect.closest('.field') as HTMLElement;
  expect(statusField.querySelector('.field-lock')).toBeNull();
});

test('an analyst editing a TRF does not send remarksStatus to the server', async () => {
  const user = userEvent.setup();
  renderForm();

  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Part A — Formulation' })).toBeTruthy();
  });

  // The Status dropdown is locked for a non-admin.
  const card = screen.getByRole('heading', { name: 'Part A — Formulation' }).closest('.card') as HTMLElement;
  const statusSelect = within(card).getByLabelText('Status') as HTMLSelectElement;
  expect(statusSelect.disabled).toBe(true);

  await user.click(screen.getByRole('button', { name: 'Save changes' }));

  await waitFor(() => {
    expect(calls.filter((c) => c.method === 'PATCH' && c.path === '/api/trfs/1').length).toBe(1);
  });

  // The body sent by an analyst must NOT include remarksStatus.
  const patchCall = calls.find((c) => c.method === 'PATCH' && c.path === '/api/trfs/1');
  expect(patchCall).toBeDefined();
  expect(patchCall!.body).not.toHaveProperty('remarksStatus');
});

test('creating a new TRF pre-fills "Sample Submitted By" with the current employee', async () => {
  renderCreateForm();

  await waitFor(() => {
    expect(screen.getByRole('heading', { name: 'Part A — Formulation' })).toBeTruthy();
  });

  const combo = screen.getByLabelText('Sample Submitted By') as HTMLInputElement;
  await waitFor(() => {
    expect(combo.value).toBe('Test Formulation');
  });
});
