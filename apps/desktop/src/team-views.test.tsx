import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { HashRouter, MemoryRouter, Route, Routes } from 'react-router-dom';
import type { EmployeeProfile } from '@trf/shared';
import { MODULE_ACCESS } from '@trf/shared';
import { afterEach, test, expect, vi } from 'vitest';
import { AuthContext, type AuthSessionState } from './lib/auth';
import { ServerStatusContext } from './lib/server-status';
import { visibleNav } from './components/Layout';
import { ArdWorkspace } from './pages/ArdWorkspace';
import { ArdEmployeeDetail } from './pages/ArdEmployeeDetail';
import { FrdWorkspace } from './pages/FrdWorkspace';
import { FrdEmployeeDetail } from './pages/FrdEmployeeDetail';

const ME: EmployeeProfile = {
  id: 1, employeeCode: 'EMP001', fullName: 'Test User', designation: 'Executive', email: 't@example.com', username: 't',
  role: 'Admin', departmentId: null, departmentName: null, isActive: true, mustChangePassword: false, lastLoginAt: null,
  version: 1, createdAt: '2026-01-01T00:00:00Z', accountType: 'INDIVIDUAL', team: null, pinFailedAttempts: 0, pinLockedUntil: null,
};

function auth(overrides: Partial<AuthSessionState> = {}): AuthSessionState {
  return {
    employee: ME, status: 'signed-in', actingEmployeeId: 1, accountId: null,
    can: (p) => p === 'assignments.manage', canAccessModule: (m) => (MODULE_ACCESS[m] ?? []).includes(ME.role),
    login: async () => ({ ok: true }), selectMember: async () => ({ ok: true }), switchUser: async () => {}, logout: async () => {},
    ...overrides,
  };
}

const status = {
  state: 'connected' as const, health: { database: 'connected', version: '1.0.0' },
  serverUrl: 'http://localhost:4000', lastChecked: null, recheck: async () => {},
};

type Req = { ok: boolean; status?: number; data?: unknown; error?: string };

function mount(
  node: React.ReactNode,
  request: (path: string) => Req,
  session: Partial<AuthSessionState> = {},
  initialEntries: string[] = ['/'],
) {
  (window as unknown as { trf: unknown }).trf = {
    request: vi.fn(async ({ path }: { path: string }) => request(path)),
    getConfig: vi.fn(async () => ({ serverUrl: 'http://localhost:4000' })),
  };
  return render(
    <ServerStatusContext.Provider value={status as never}>
      <AuthContext.Provider value={auth(session)}>
        <MemoryRouter initialEntries={initialEntries}>{node}</MemoryRouter>
      </AuthContext.Provider>
    </ServerStatusContext.Provider>,
  );
}

/** Mounts a detail page at its :id route so useParams resolves. */
function mountDetail(node: React.ReactNode, path: string, entry: string, request: (path: string) => Req) {
  return mount(<Routes><Route path={path} element={node} /></Routes>, request, {}, [entry]);
}

afterEach(() => { cleanup(); });

function employee(role: string, team: string | null = null): EmployeeProfile {
  return { ...ME, role, team } as EmployeeProfile;
}
const canAccess = (e: EmployeeProfile | null) => (m: string) => (MODULE_ACCESS[m] ?? []).includes(e?.role ?? 'Viewer');

test('the FRD nav item shows only for Admin, GM and AGM', () => {
  for (const role of ['Admin', 'GM', 'AGM']) {
    const nav = visibleNav(employee(role), canAccess(employee(role)));
    expect(nav.some((n) => n.module === 'frd')).toBe(true);
  }
  for (const role of ['Manager', 'Analyst', 'Viewer']) {
    const nav = visibleNav(employee(role), canAccess(employee(role)));
    expect(nav.some((n) => n.module === 'frd')).toBe(false);
  }
});

test('shared team members never see the FRD item', () => {
  expect(visibleNav(employee('Manager', 'FRD'), canAccess(employee('Manager', 'FRD'))).some((n) => n.module === 'frd')).toBe(false);
  expect(visibleNav(employee('Analyst', 'ARD'), canAccess(employee('Analyst', 'ARD'))).some((n) => n.module === 'frd')).toBe(false);
});

test('Assignments is hidden for higher authorities but kept for a Manager', () => {
  expect(visibleNav(employee('Admin'), canAccess(employee('Admin'))).some((n) => n.module === 'assignments')).toBe(false);
  expect(visibleNav(employee('GM'), canAccess(employee('GM'))).some((n) => n.module === 'assignments')).toBe(false);
  expect(visibleNav(employee('AGM'), canAccess(employee('AGM'))).some((n) => n.module === 'assignments')).toBe(false);
  expect(visibleNav(employee('Manager'), canAccess(employee('Manager'))).some((n) => n.module === 'assignments')).toBe(true);
});

const ARD_ROWS = [
  { employeeId: 1, fullName: 'Asha Rao', employeeCode: 'ARD-001', designation: null, assignedTrfs: 4, testsAssigned: 12, assigned: 2, inProgress: 3, submitted: 2, approved: 5, rejected: 0, overdue: 5, completedTests: 4 },
  { employeeId: 2, fullName: 'Ben Roy', employeeCode: 'ARD-002', designation: null, assignedTrfs: 0, testsAssigned: 0, assigned: 0, inProgress: 0, submitted: 0, approved: 0, rejected: 0, overdue: 0, completedTests: 0 },
  { employeeId: 3, fullName: 'Cara Lin', employeeCode: 'ARD-003', designation: null, assignedTrfs: 1, testsAssigned: 3, assigned: 0, inProgress: 1, submitted: 0, approved: 1, rejected: 0, overdue: 1, completedTests: 1 },
];

test('the ARD list renders every employee including zeros, sorts and searches', async () => {
  mount(<ArdWorkspace />, () => ({ ok: true, data: { items: ARD_ROWS } }));
  expect(await screen.findByText('Asha Rao')).toBeTruthy();
  expect(screen.getByText('Ben Roy')).toBeTruthy();
  const benRow = screen.getByText('Ben Roy').closest('tr')!;
  expect(benRow.className).toContain('row--muted');
  // Default sort: overdue high to low, so Asha (5) is the first row.
  const firstRow = document.querySelector('tbody tr')!;
  expect(firstRow.textContent).toContain('Asha Rao');
  // Search narrows to one.
  fireEvent.change(screen.getByLabelText('Search employee'), { target: { value: 'cara' } });
  expect(screen.getByText('Cara Lin')).toBeTruthy();
  expect(screen.queryByText('Asha Rao')).toBeNull();
});

test('clicking an ARD row opens the employee detail page', async () => {
  (window as unknown as { trf: unknown }).trf = {
    request: vi.fn(async () => ({ ok: true, data: { items: ARD_ROWS } })),
    getConfig: vi.fn(async () => ({ serverUrl: 'http://localhost:4000' })),
  };
  window.location.hash = '#/ard';
  render(
    <ServerStatusContext.Provider value={status as never}>
      <AuthContext.Provider value={auth({})}>
        <HashRouter>
          <Routes>
            <Route path="/ard" element={<ArdWorkspace />} />
            <Route path="/ard/employee/:id" element={<div>DETAIL {window.location.hash}</div>} />
          </Routes>
        </HashRouter>
      </AuthContext.Provider>
    </ServerStatusContext.Provider>,
  );
  const links = await screen.findAllByText('View work →');
  fireEvent.click(links[0]);
  expect(await screen.findByText(/DETAIL/)).toBeTruthy();
});

const ARD_DETAIL = {
  summary: { employeeId: 1, fullName: 'Asha Rao', employeeCode: 'ARD-001', designation: 'Senior Chemist', assignedTrfs: 4, testsAssigned: 30, assigned: 2, inProgress: 3, submitted: 2, approved: 5, rejected: 1, overdue: 1, completedTests: 20 },
  items: Array.from({ length: 25 }, (_, i) => ({ trfId: i + 1, trfNumber: `TRF-${i + 1}`, arNumber: `AR-${i + 1}`, productName: 'Prod', testName: 'pH', testStatus: 'In Progress', reviewStatus: null, assignedDate: null, dueDate: null, isDelayed: false })),
  total: 30, page: 1, pageSize: 25, pageCount: 2,
};

test('the ARD detail shows summary, pagination, filter and search', async () => {
  mountDetail(<ArdEmployeeDetail />, '/ard/employee/:id', '/ard/employee/1', () => ({ ok: true, data: ARD_DETAIL }));
  expect(await screen.findByText('Asha Rao')).toBeTruthy();
  expect(screen.getByText('30')).toBeTruthy();
  expect(screen.getByText(/page 1 of 2/)).toBeTruthy();
  expect(screen.getByLabelText('Filter by status')).toBeTruthy();
  expect(screen.getByLabelText('Search tests')).toBeTruthy();
});

test('the ARD detail shows an error state with a retry button', async () => {
  mountDetail(<ArdEmployeeDetail />, '/ard/employee/:id', '/ard/employee/1', () => ({ ok: false, status: 500, error: 'Boom' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByText('Try again')).toBeTruthy();
});

test('the ARD detail shows an empty state when there are no tests', async () => {
  mountDetail(<ArdEmployeeDetail />, '/ard/employee/:id', '/ard/employee/1', () => ({ ok: true, data: { ...ARD_DETAIL, items: [], total: 0, pageCount: 1 } }));
  expect(await screen.findByText('No tests')).toBeTruthy();
});

test('an unknown ARD employee id shows a not-found state', async () => {
  mountDetail(<ArdEmployeeDetail />, '/ard/employee/:id', '/ard/employee/999', () => ({ ok: false, status: 404 }));
  expect(await screen.findByText('Employee not found')).toBeTruthy();
});

const FRD_ROWS = [
  { employeeId: 1, fullName: 'Rajesh Kumar', employeeCode: 'FRD-001', designation: null, trfsCreated: 10, new: 2, assigned: 1, inProgress: 3, analysisCompleted: 1, coaPending: 0, completed: 3, cancelled: 0, createdThisMonth: 4, lastCreatedAt: '2026-11-20T00:00:00.000Z' },
  { employeeId: 2, fullName: 'Sneha Reddy', employeeCode: 'FRD-002', designation: null, trfsCreated: 0, new: 0, assigned: 0, inProgress: 0, analysisCompleted: 0, coaPending: 0, completed: 0, cancelled: 0, createdThisMonth: 0, lastCreatedAt: null },
];

test('the FRD list renders every employee including zero-TRF, sorts and searches', async () => {
  mount(<FrdWorkspace />, () => ({ ok: true, data: { items: FRD_ROWS } }));
  expect(await screen.findByText('Rajesh Kumar')).toBeTruthy();
  const sneha = screen.getByText('Sneha Reddy').closest('tr')!;
  expect(sneha.className).toContain('row--muted');
  expect(document.querySelector('tbody tr')!.textContent).toContain('Rajesh Kumar');
  fireEvent.change(screen.getByLabelText('Search employee'), { target: { value: 'sneha' } });
  expect(screen.getByText('Sneha Reddy')).toBeTruthy();
  expect(screen.queryByText('Rajesh Kumar')).toBeNull();
});

const FRD_DETAIL = {
  summary: { employeeId: 1, fullName: 'Rajesh Kumar', employeeCode: 'FRD-001', designation: null, trfsCreated: 30, new: 2, assigned: 1, inProgress: 3, analysisCompleted: 1, coaPending: 0, completed: 23, cancelled: 0, createdThisMonth: 4, lastCreatedAt: null },
  items: Array.from({ length: 25 }, (_, i) => ({ trfId: i + 1, trfNumber: `TRF-${i + 1}`, trfDate: '2026-11-20', productName: 'Prod', customerName: 'Cust', batchNumber: 'B1', status: 'New', priority: 'Normal', assignedAnalystNames: null, dueDate: null })),
  total: 30, page: 1, pageSize: 25, pageCount: 2,
};

test('the FRD detail shows summary, pagination, filter and search', async () => {
  mountDetail(<FrdEmployeeDetail />, '/frd/employee/:id', '/frd/employee/1', () => ({ ok: true, data: FRD_DETAIL }));
  expect(await screen.findByText('Rajesh Kumar')).toBeTruthy();
  expect(screen.getByText(/page 1 of 2/)).toBeTruthy();
  expect(screen.getByLabelText('Filter by status')).toBeTruthy();
  expect(screen.getByLabelText('Search TRFs')).toBeTruthy();
});

test('an unknown FRD employee id shows a not-found state', async () => {
  mountDetail(<FrdEmployeeDetail />, '/frd/employee/:id', '/frd/employee/999', () => ({ ok: false, status: 404 }));
  expect(await screen.findByText('Employee not found')).toBeTruthy();
});