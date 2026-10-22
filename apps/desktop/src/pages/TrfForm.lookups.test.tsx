import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { Customer, Product, EmployeeProfile, StageOption } from '@trf/shared';
import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import { AuthContext } from '../lib/auth';
import type { AuthSessionState } from '../lib/auth';
import { TrfForm } from './TrfForm';

interface RecordedRequest {
  method: string;
  path: string;
  body?: unknown;
}

const calls: RecordedRequest[] = [];
const consoleErrors: string[] = [];
let consoleErrorSpy: ReturnType<typeof vi.spyOn> | null = null;

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

function ardEmployee(): EmployeeProfile {
  return {
    ...formulationEmployee(),
    id: 2,
    employeeCode: 'EMP002',
    fullName: 'Test ARD',
    username: 'testard',
    departmentId: 2,
    departmentName: 'ARD',
  };
}

function managerEmployee(): EmployeeProfile {
  return {
    ...formulationEmployee(),
    id: 3,
    employeeCode: 'EMP003',
    fullName: 'Test Manager',
    username: 'testmgr',
    role: 'Manager',
    departmentId: 2,
    departmentName: 'ARD',
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

interface MockStore {
  customers: Customer[];
  products: Product[];
  stages: StageOption[];
  nextCustomerId: number;
  nextProductId: number;
  nextStageId: number;
}

function makeStore(initial: Partial<MockStore> = {}): MockStore {
  return {
    customers: initial.customers ?? [],
    products: initial.products ?? [],
    stages: initial.stages ?? [{ id: 1, name: 'Initial', isActive: true }],
    nextCustomerId: initial.nextCustomerId ?? 100,
    nextProductId: initial.nextProductId ?? 200,
    nextStageId: initial.nextStageId ?? 10,
  };
}

function makeTrfBridge(store: MockStore) {
  return {
    getConfig: async () => ({ serverUrl: 'http://localhost:4000' }),
    setServerUrl: async () => ({ ok: true as const, serverUrl: 'http://localhost:4000' }),
    request: async (req: { method: string; path: string; body?: unknown }): Promise<{
      ok: boolean; status: number; data?: unknown; error?: string;
    }> => {
      calls.push({ method: req.method, path: req.path, body: req.body });

      if (req.method === 'GET' && req.path === '/api/lookups/customers') {
        return { ok: true, status: 200, data: { items: store.customers } };
      }
      if (req.method === 'GET' && req.path === '/api/lookups/products') {
        return { ok: true, status: 200, data: { items: store.products } };
      }
      if (req.method === 'GET' && req.path === '/api/employees/assignable') {
        return { ok: true, status: 200, data: { items: [] } };
      }
      if (req.method === 'POST' && req.path === '/api/lookups/customers') {
        const b = req.body as { name?: string; code?: string | null };
        const customer: Customer = {
          id: store.nextCustomerId++,
          name: b?.name?.trim() ?? 'New Customer',
          code: b?.code ?? null,
          contactPerson: null,
          email: null,
          phone: null,
          address: null,
          isActive: true,
        };
        store.customers.push(customer);
        return { ok: true, status: 201, data: customer };
      }
      if (req.method === 'POST' && req.path === '/api/lookups/products') {
        const b = req.body as { name?: string; code?: string | null };
        const product: Product = {
          id: store.nextProductId++,
          name: b?.name?.trim() ?? 'New Product',
          code: b?.code ?? null,
          description: null,
          isActive: true,
        };
        store.products.push(product);
        return { ok: true, status: 201, data: product };
      }
      if (req.method === 'GET' && req.path === '/api/lookups/stages') {
        return { ok: true, status: 200, data: { items: store.stages } };
      }
      if (req.method === 'POST' && req.path === '/api/lookups/stages') {
        const b = req.body as { name?: string };
        const name = b?.name?.trim() ?? '';
        const existing = store.stages.find((s) => s.name.toLowerCase() === name.toLowerCase());
        if (existing) return { ok: true, status: 200, data: { item: existing, duplicate: true } };
        const created: StageOption = { id: store.nextStageId++, name, isActive: true };
        store.stages.push(created);
        return { ok: true, status: 201, data: { item: created, duplicate: false } };
      }
      if (req.method === 'POST' && req.path === '/api/trfs') {
        return { ok: true, status: 201, data: { id: 1, trfNumber: 'TRF-2026-00001', status: 'New', version: 1 } };
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

function renderForm(store: MockStore = makeStore(), employee: EmployeeProfile = formulationEmployee()) {
  const bridge = makeTrfBridge(store);
  (window as unknown as { trf: unknown }).trf = bridge;
  render(
    <AuthContext.Provider value={makeAuthValue(employee)}>
      <MemoryRouter initialEntries={['/trfs/new']}>
        <TrfForm />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

function countRequests(method: string, path: string): number {
  return calls.filter((c) => c.method === method && c.path === path).length;
}

function hasValidationError(): boolean {
  return screen.queryAllByText(/select a customer from the list|select a product from the list/i).length > 0;
}

beforeEach(() => {
  calls.length = 0;
  consoleErrors.length = 0;
  cleanup();
  consoleErrorSpy = vi.spyOn(console, 'error');
  consoleErrorSpy.mockImplementation((msg: unknown, ...args: unknown[]) => {
    const text = typeof msg === 'string' ? msg : String(msg);
    consoleErrors.push(text);
  });
});

afterEach(() => {
  consoleErrorSpy?.mockRestore();
  consoleErrorSpy = null;
  cleanup();
});

test('adding a customer inline creates only the customer and selects it', async () => {
  const user = userEvent.setup();
  renderForm();

  await waitFor(() => {
    expect(countRequests('GET', '/api/lookups/customers')).toBeGreaterThan(0);
  });

  await user.click(screen.getByText('+ New customer'));

  const nameInput = screen.getByLabelText(/new customer name/i);
  await user.type(nameInput, 'Acme Corp');
  await user.click(screen.getByRole('button', { name: 'Add' }));

  await waitFor(() => {
    expect(countRequests('POST', '/api/lookups/customers')).toBe(1);
  });

  const customerSelect = screen.getByLabelText(/customer/i) as HTMLSelectElement;
  await waitFor(() => {
    expect(customerSelect.value).toBe('100');
  });

  expect(countRequests('POST', '/api/trfs')).toBe(0);

  await waitFor(() => {
    expect(hasValidationError()).toBe(false);
  });
});

test('pressing Enter in the quick-add name box adds the record and does not save the TRF', async () => {
  const user = userEvent.setup();
  renderForm();

  await waitFor(() => {
    expect(countRequests('GET', '/api/lookups/customers')).toBeGreaterThan(0);
  });

  await user.click(screen.getByText('+ New customer'));

  const nameInput = screen.getByLabelText(/new customer name/i);
  await user.type(nameInput, 'Enter Customer{enter}');

  await waitFor(() => {
    expect(countRequests('POST', '/api/lookups/customers')).toBe(1);
  });

  await waitFor(() => {
    expect(countRequests('POST', '/api/trfs')).toBe(0);
  });

  await waitFor(() => {
    expect(hasValidationError()).toBe(false);
  });
});

test('choosing a product keeps it selected', async () => {
  const user = userEvent.setup();
  const seedProduct: Product = {
    id: 5, name: 'Seeded Product', code: 'SEED', description: null, isActive: true,
  };
  renderForm(makeStore({ products: [seedProduct] }));

  await waitFor(() => {
    expect(countRequests('GET', '/api/lookups/products')).toBeGreaterThan(0);
  });

  const productSelect = screen.getByLabelText(/product/i) as HTMLSelectElement;
  await user.selectOptions(productSelect, '5');

  expect(productSelect.value).toBe('5');
});

test('"Other (type new)" on Product adds the product, selects it, and does not save the TRF', async () => {
  const user = userEvent.setup();
  const seedProduct: Product = {
    id: 5, name: 'Seeded Product', code: 'SEED', description: null, isActive: true,
  };
  renderForm(makeStore({ products: [seedProduct] }));

  await waitFor(() => {
    expect(countRequests('GET', '/api/lookups/products')).toBeGreaterThan(0);
  });

  const productSelect = screen.getByLabelText(/product/i) as HTMLSelectElement;
  await user.selectOptions(productSelect, '__other__');

  const nameInput = screen.getByLabelText(/new product name/i);
  await user.type(nameInput, 'Custom Product');
  await user.click(screen.getByRole('button', { name: 'Add' }));

  await waitFor(() => {
    expect(countRequests('POST', '/api/lookups/products')).toBe(1);
  });

  await waitFor(() => {
    expect(productSelect.value).toBe('200');
  });

  expect(countRequests('POST', '/api/trfs')).toBe(0);

  await waitFor(() => {
    expect(hasValidationError()).toBe(false);
  });
});

test('adding a customer shows no "Select a product/customer from the list" errors on the TRF form', async () => {
  const user = userEvent.setup();
  renderForm();

  await waitFor(() => {
    expect(countRequests('GET', '/api/lookups/customers')).toBeGreaterThan(0);
  });

  await user.click(screen.getByText('+ New customer'));

  const nameInput = screen.getByLabelText(/new customer name/i);
  await user.type(nameInput, 'ErrorCheck Customer');
  await user.click(screen.getByRole('button', { name: 'Add' }));

  await waitFor(() => {
    expect(countRequests('POST', '/api/lookups/customers')).toBe(1);
  });
  await waitFor(() => {
    expect(countRequests('GET', '/api/lookups/customers')).toBeGreaterThan(1);
  });

  await waitFor(() => {
    expect(hasValidationError()).toBe(false);
  });
});

test('with customer and product already chosen, adding another product makes zero POST /api/trfs calls', async () => {
  const user = userEvent.setup();
  const seedCustomer: Customer = {
    id: 10, name: 'Seeded Customer', code: 'CUST', contactPerson: null, email: null,
    phone: null, address: null, isActive: true,
  };
  const seedProduct: Product = {
    id: 20, name: 'Seeded Product', code: 'PROD', description: null, isActive: true,
  };
  const store = makeStore({ customers: [seedCustomer], products: [seedProduct] });
  renderForm(store);

  await waitFor(() => {
    expect(countRequests('GET', '/api/lookups/customers')).toBeGreaterThan(0);
  });

  await user.selectOptions(screen.getByLabelText(/customer/i), '10');
  await user.selectOptions(screen.getByLabelText(/product/i), '20');

  await user.click(screen.getByText('+ New product'));

  const nameInput = screen.getByLabelText(/new product name/i);
  await user.type(nameInput, 'Third Product');
  await user.click(screen.getByRole('button', { name: 'Add' }));

  await waitFor(() => {
    expect(countRequests('POST', '/api/lookups/products')).toBe(1);
  });

  expect(countRequests('POST', '/api/trfs')).toBe(0);
});

test('no <form> is nested inside another <form> (validateDOMNesting fix)', async () => {
  const user = userEvent.setup();
  renderForm();

  await waitFor(() => {
    expect(countRequests('GET', '/api/lookups/customers')).toBeGreaterThan(0);
  });

  await user.click(screen.getByText('+ New customer'));

  const forms = document.querySelectorAll('form');
  for (const form of forms) {
    expect(form.querySelector('form')).toBeNull();
  }

  const nestingWarnings = consoleErrors.filter(
    (e) => e.includes('validateDOMNesting') && e.toLowerCase().includes('form'),
  );
  expect(nestingWarnings).toHaveLength(0);
});

test('Stage dropdown offers "Initial" and "Other (type new)"', async () => {
  const user = userEvent.setup();
  renderForm(makeStore(), managerEmployee());

  await waitFor(() => {
    expect(countRequests('GET', '/api/lookups/stages')).toBeGreaterThan(0);
  });

  const stageSelect = screen.getByLabelText('Stage') as HTMLSelectElement;
  await waitFor(() => {
    expect(stageSelect.options.length).toBeGreaterThanOrEqual(2);
  });
  const names = Array.from(stageSelect.options).map((o) => o.value);
  expect(names).toContain('Initial');
  expect(names).toContain('Other (type new)');
});

test('adding a stage via "Other (type new)" creates it once, selects it, and does not save the TRF', async () => {
  const user = userEvent.setup();
  renderForm(makeStore(), managerEmployee());

  await waitFor(() => {
    expect(countRequests('GET', '/api/lookups/stages')).toBeGreaterThan(0);
  });

  const stageSelect = screen.getByLabelText('Stage') as HTMLSelectElement;
  await user.selectOptions(stageSelect, 'Other (type new)');

  const nameInput = screen.getByPlaceholderText('New stage name');
  await user.type(nameInput, 'Sample Preparation');
  await user.click(screen.getByRole('button', { name: 'Add' }));

  await waitFor(() => {
    expect(countRequests('POST', '/api/lookups/stages')).toBe(1);
  });

  await waitFor(() => {
    expect((screen.getByLabelText('Stage') as HTMLSelectElement).value).toBe('Sample Preparation');
  });

  // Adding a stage does not save the TRF itself.
  expect(countRequests('POST', '/api/trfs')).toBe(0);
});

test('adding a stage that already exists reuses it and selects it', async () => {
  const user = userEvent.setup();
  renderForm(makeStore({ stages: [{ id: 1, name: 'Initial', isActive: true }, { id: 2, name: 'Sample Preparation', isActive: true }] }), managerEmployee());

  await waitFor(() => {
    expect(countRequests('GET', '/api/lookups/stages')).toBeGreaterThan(0);
  });

  const stageSelect = screen.getByLabelText('Stage') as HTMLSelectElement;
  await user.selectOptions(stageSelect, 'Other (type new)');

  const nameInput = screen.getByPlaceholderText('New stage name');
  await user.type(nameInput, 'sample preparation');
  await user.click(screen.getByRole('button', { name: 'Add' }));

  await waitFor(() => {
    expect(countRequests('POST', '/api/lookups/stages')).toBe(1);
  });

  await waitFor(() => {
    expect((screen.getByLabelText('Stage') as HTMLSelectElement).value).toBe('Sample Preparation');
  });
  expect(countRequests('POST', '/api/trfs')).toBe(0);
});
