import { render, screen, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { DashboardPayload, EmployeeProfile } from '@trf/shared';
import { afterEach, test, expect, vi } from 'vitest';
import { AuthContext, type AuthSessionState } from '../lib/auth';
import { ServerStatusContext } from '../lib/server-status';
import { Dashboard } from './Dashboard';

/**
 * The dashboard shows only server-counted figures, links every card to the list
 * behind it, labels the signed-in role's scope, and keeps the offline/loading/
 * error paths. These checks pin the figures, the deep links and the scope label.
 */

// jsdom has no ResizeObserver; recharts' ResponsiveContainer needs one to mount.
if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const ME: EmployeeProfile = {
  id: 5, employeeCode: 'EMP005', fullName: 'Ketan Sharma', designation: 'Executive', email: 'k@example.com', username: 'ketan',
  role: 'Analyst', departmentId: 2, departmentName: 'ARD', isActive: true, mustChangePassword: false, lastLoginAt: null, version: 1,
  createdAt: '2026-01-01T00:00:00Z', accountType: 'INDIVIDUAL', team: null, pinFailedAttempts: 0, pinLockedUntil: null,
};

function auth(overrides: Partial<AuthSessionState> = {}): AuthSessionState {
  return {
    employee: ME, status: 'signed-in', actingEmployeeId: 5, accountId: null, can: () => true, canAccessModule: () => true,
    login: async () => ({ ok: true }), selectMember: async () => ({ ok: true }), switchUser: async () => {}, logout: async () => {},
    ...overrides,
  };
}

function payload(overrides: Partial<DashboardPayload> = {}): DashboardPayload {
  return {
    scope: 'all',
    totals: {
      trfTotal: 40, trfNew: 5, trfAssigned: 8, trfInProgress: 10, trfAnalysisCompleted: 4,
      trfCoaPending: 3, trfCompleted: 25, trfCancelled: 1, trfOverdue: 6,
      analysisOpenTests: 12, analysisDelayedTests: 4, coaAwaitingIssue: 3, coaIssued: 20,
    },
    trfStatus: [
      { status: 'New', count: 5 }, { status: 'Assigned', count: 8 }, { status: 'In Progress', count: 10 },
      { status: 'Analysis Completed', count: 4 }, { status: 'COA Pending', count: 3 },
      { status: 'Completed', count: 25 }, { status: 'Cancelled', count: 1 },
    ],
    analysisStatus: [
      { status: 'Assigned', count: 6 }, { status: 'In Progress', count: 6 },
      { status: 'Completed', count: 30 }, { status: 'Re-test Required', count: 2 },
    ],
    coaStatus: [
      { status: 'Draft', count: 2 }, { status: 'Under Review', count: 1 }, { status: 'Issued', count: 20 },
    ],
    monthlyTrfs: [
      { month: '2026-01', label: 'Jan', count: 2 }, { month: '2026-02', label: 'Feb', count: 3 },
      { month: '2026-03', label: 'Mar', count: 1 }, { month: '2026-04', label: 'Apr', count: 4 },
      { month: '2026-05', label: 'May', count: 2 }, { month: '2026-06', label: 'Jun', count: 5 },
      { month: '2026-07', label: 'Jul', count: 3 }, { month: '2026-08', label: 'Aug', count: 6 },
      { month: '2026-09', label: 'Sep', count: 2 }, { month: '2026-10', label: 'Oct', count: 4 },
      { month: '2026-11', label: 'Nov', count: 3 }, { month: '2026-12', label: 'Dec', count: 5 },
    ],
    workload: [
      { employeeId: 1, employeeName: 'Asha Rao', assigned: 5, inProgress: 3, passed: 10, failed: 1, delayed: 2 },
      { employeeId: 2, employeeName: 'Ben Roy', assigned: 4, inProgress: 2, passed: 8, failed: 0, delayed: 1 },
    ],
    trfByEmployee: [
      { employeeId: 1, employeeName: 'Asha Rao', completed: 12, total: 20 },
      { employeeId: 2, employeeName: 'Ben Roy', completed: 5, total: 15 },
    ],
    generatedAt: '2026-11-24T09:00:00Z',
    ...overrides,
  };
}

function mount(data: DashboardPayload, session: Partial<AuthSessionState> = {}) {
  (window as unknown as { trf: unknown }).trf = {
    request: vi.fn(async () => ({ ok: true, status: 200, data })),
    viewPdf: vi.fn(async () => ({ ok: true })),
    downloadBlob: vi.fn(async () => ({ ok: true })),
  };
  const status = { state: 'connected' as const, health: { database: 'connected', version: '1.0.0' }, serverUrl: 'http://localhost:4000', lastChecked: new Date('2026-11-24T09:05:00'), recheck: async () => {} };
  return render(
    <ServerStatusContext.Provider value={status as never}>
      <AuthContext.Provider value={auth(session)}>
        <MemoryRouter><Dashboard /></MemoryRouter>
      </AuthContext.Provider>
    </ServerStatusContext.Provider>,
  );
}

afterEach(() => { cleanup(); });

test('shows the server-counted headline figures, scope and banner', async () => {
  mount(payload());
  // Banner greeting uses the first name and names the role.
  expect(await screen.findByText(/Good (morning|afternoon|evening), Ketan/)).toBeTruthy();
  expect(screen.getByText(/Every TRF, test and certificate in the system\./)).toBeTruthy();
  expect(screen.getByText('TRFs in scope')).toBeTruthy();
  // The completion ring is trfCompleted / trfTotal = 25/40 = 63%.
  expect(screen.getByText('63%')).toBeTruthy();
  // KPI labels are present.
  expect(screen.getByText('Certificates to issue')).toBeTruthy();
  expect(screen.getAllByText('Overdue').length).toBeGreaterThan(0);
});

test('every card links to the filtered list behind it', async () => {
  mount(payload());
  await screen.findByText('TRFs in scope');
  expect(screen.getByTitle('Show the trfs list').getAttribute('href')).toBe('/trf');
  // Both the Completed KPI and the Completed pipeline stage point at the same filtered list.
  expect(screen.getAllByTitle('Show the completed list')
    .some((a) => a.getAttribute('href') === '/trf?status=Completed')).toBe(true);
  // Attention deep-links with the same filter the list reads.
  expect(screen.getByRole('link', { name: /Overdue TRFs/ }).getAttribute('href')).toBe('/trf?overdueOnly=true');
});

test('the pipeline shows every TRF stage with counts', async () => {
  mount(payload());
  await screen.findByText('TRFs in scope');
  for (const label of ['New', 'Assigned', 'In Progress', 'Analysis Completed', 'COA Pending', 'Completed']) {
    expect(screen.getAllByText(label).length).toBeGreaterThan(0);
  }
});

test('status charts expose a keyboard/AT-friendly legend that opens the list', async () => {
  mount(payload());
  await screen.findByText('TRFs in scope');
  // The chart is aria-hidden; the legend button carries the number and the link.
  expect(screen.getByRole('button', { name: 'New: 5. Show the list.' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Completed: 25. Show the list.' })).toBeTruthy();
});

test('completed-by-employee is ranked with progress bars', async () => {
  mount(payload());
  await screen.findByText('TRFs in scope');
  expect(screen.getByText('Asha Rao')).toBeTruthy();
  const bar = screen.getByRole('progressbar', { name: /Asha Rao: 12 of 20/ });
  expect(bar.getAttribute('aria-valuenow')).toBe('12');
});

test('the own-scope wording is used for a personal dashboard', async () => {
  mount(payload({ scope: 'own' }));
  expect(await screen.findByText(/Your team's TRFs, tests and certificates\./)).toBeTruthy();
  expect(screen.getByText('Your analyst results')).toBeTruthy();
  expect(screen.getByText('Your TRFs completed')).toBeTruthy();
});

test('an empty period shows a helpful message instead of a bare axis', async () => {
  mount(payload({
    monthlyTrfs: Array.from({ length: 12 }, (_, i) => ({ month: `2026-${String(i + 1).padStart(2, '0')}`, label: `M${i + 1}`, count: 0 })),
    workload: [], trfByEmployee: [], trfStatus: [], analysisStatus: [], coaStatus: [],
  }));
  expect(await screen.findByText('No TRFs in this period yet.')).toBeTruthy();
  expect(screen.getByText('No analyst results in this period yet.')).toBeTruthy();
  expect(screen.getByText('No TRFs assigned to anyone in this scope yet.')).toBeTruthy();
});