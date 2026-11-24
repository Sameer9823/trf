import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { AnalystAssignedTest, EmployeeProfile } from '@trf/shared';
import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import { AuthContext, type AuthSessionState } from '../lib/auth';
import { ServerStatusContext } from '../lib/server-status';
import { EmployeeDashboard } from './EmployeeDashboard';

// jsdom has no ResizeObserver; recharts' ResponsiveContainer needs one to mount.
// A no-op stub lets the chart mount (empty) so the rest of the page can be checked.
if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

/**
 * The ARD employee dashboard is a glanceable view of one employee's tests: the
 * headline counts, completion, a work queue with the everyday actions, and the
 * date-range / status / search filters that scope it. These checks pin the parts
 * the employee acts on so a redesign cannot quietly drop an action or a count.
 */

interface Call { method: string; path: string; body?: unknown }

const ME: EmployeeProfile = {
  id: 5, employeeCode: 'EMP005', fullName: 'Ketan Sharma', designation: 'Executive', email: 'k@example.com', username: 'ketan',
  role: 'Analyst', departmentId: 2, departmentName: 'ARD', isActive: true, mustChangePassword: false, lastLoginAt: null, version: 1,
  createdAt: '2026-01-01T00:00:00Z', accountType: 'SHARED_TEAM', team: 'ARD', pinFailedAttempts: 0, pinLockedUntil: null,
};

function auth(): AuthSessionState {
  return {
    employee: ME, status: 'signed-in', actingEmployeeId: 5, accountId: 2, can: () => true, canAccessModule: () => true,
    login: async () => ({ ok: true }), selectMember: async () => ({ ok: true }), switchUser: async () => {}, logout: async () => {},
  };
}

/** A local-time ISO stamp at 09:00, `n` days ago, so date-range maths is stable. */
function at(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

function item(over: Partial<AnalystAssignedTest> & { assignmentId: number }): AnalystAssignedTest {
  return {
    trfId: 1, trfNumber: `TRF/2026/000${over.assignmentId}`, arNumber: 'ARD/2026/0004',
    productName: 'Vitamin C', genericName: 'Ascorbic acid', batchNumber: 'B-1', testName: 'Assay',
    testStatus: 'Assigned', assignedAt: at(0), assignedBy: 2, dueDate: at(-3),
    analystId: 5, analystName: ME.fullName, analystCode: ME.employeeCode, analystDepartment: 'ARD',
    ...over,
  } as AnalystAssignedTest;
}

const ITEMS: AnalystAssignedTest[] = [
  item({ assignmentId: 11, trfNumber: 'TRF/2026/0001', testName: 'Assay', testStatus: 'Assigned' }),
  item({ assignmentId: 12, trfNumber: 'TRF/2026/0002', testName: 'Moisture', testStatus: 'In Progress' }),
  item({
    assignmentId: 13, trfNumber: 'TRF/2026/0003', testName: 'Dissolution', testStatus: 'Completed',
    reviewStatus: 'Approved', resultMode: 'pdf', fileName: 'dissolution.pdf', fileSize: 2048,
    analysisStartDate: at(2), completionDate: at(0),
  }),
  item({
    assignmentId: 14, trfNumber: 'TRF/2026/0004', testName: 'pH', testStatus: 'Assigned',
    assignedAt: at(10), reviewStatus: 'Rejected', reviewReason: 'Value outside the specification; recheck the reading.',
  }),
];

function mount(items: AnalystAssignedTest[] = ITEMS) {
  const calls: Call[] = [];
  const viewPdf = vi.fn(async () => ({ ok: true }));
  (window as unknown as { trf: unknown }).trf = {
    request: async (req: Call) => {
      calls.push(req);
      if (req.method === 'GET' && req.path === '/api/ard-assignments/employee-dashboard') {
        return { ok: true, status: 200, data: { items } };
      }
      if (req.method === 'PATCH' && /\/status$/.test(req.path)) {
        return { ok: true, status: 200, data: { ok: true } };
      }
      return { ok: false, status: 404, error: 'not found' };
    },
    viewPdf,
    downloadBlob: vi.fn(async () => ({ ok: true })),
  };
  const status = { state: 'connected' as const, health: null, serverUrl: 'http://localhost:4000', lastChecked: null, recheck: async () => {} };
  const utils = render(
    <ServerStatusContext.Provider value={status}>
      <AuthContext.Provider value={auth()}>
        <MemoryRouter><EmployeeDashboard /></MemoryRouter>
      </AuthContext.Provider>
    </ServerStatusContext.Provider>,
  );
  return { ...utils, calls, viewPdf };
}

const rows = (container: HTMLElement) => container.querySelectorAll('tbody tr').length;

beforeEach(() => { /* fresh window.trf per mount */ });
afterEach(() => { cleanup(); });

test('loads the tests into headline counts and the work queue', async () => {
  const { container } = mount();
  await screen.findByText('TRF/2026/0003');
  expect(rows(container)).toBe(4);
  // One of four completed, with a measured two-day turnaround.
  expect(screen.getByText('Avg. turnaround')).toBeTruthy();
  expect(screen.getByText('2.0d')).toBeTruthy();
  expect(screen.getByText('25%')).toBeTruthy(); // completion ring
});

test('Mark In Progress saves the new status and reloads', async () => {
  const user = userEvent.setup();
  const { container, calls } = mount();
  const row = (await screen.findByText('TRF/2026/0001')).closest('tr')!;
  await user.click(within(row).getByRole('button', { name: 'Mark In Progress' }));
  await waitFor(() => {
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.path).toBe('/api/ard-assignments/11/status');
    expect((patch?.body as { status?: string })?.status).toBe('In Progress');
  });
  // The queue is reloaded after the change.
  await waitFor(() => expect(calls.filter((c) => c.path === '/api/ard-assignments/employee-dashboard').length).toBeGreaterThan(1));
  expect(rows(container)).toBe(4);
});

test('the date range narrows the queue to the chosen window', async () => {
  const user = userEvent.setup();
  const { container } = mount();
  await screen.findByText('TRF/2026/0004');
  expect(rows(container)).toBe(4);
  // The tenth-day-old assignment falls outside "Today".
  await user.click(screen.getByRole('button', { name: 'Today' }));
  await waitFor(() => expect(rows(container)).toBe(3));
  expect(screen.queryByText('TRF/2026/0004')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'All' }));
  await waitFor(() => expect(rows(container)).toBe(4));
});

test('the status filter and the search narrow the queue', async () => {
  const user = userEvent.setup();
  const { container } = mount();
  await screen.findByText('TRF/2026/0001');

  await user.selectOptions(screen.getByLabelText('Filter by status'), 'Completed');
  await waitFor(() => expect(rows(container)).toBe(1));
  expect(screen.getByText('TRF/2026/0003')).toBeTruthy();

  await user.selectOptions(screen.getByLabelText('Filter by status'), 'all');
  await user.type(screen.getByLabelText('Search your tests'), '0001');
  await waitFor(() => expect(rows(container)).toBe(1));
  expect(screen.getByText('TRF/2026/0001')).toBeTruthy();
});

test('viewing a PDF result is noted in the recent activity', async () => {
  const user = userEvent.setup();
  mount();
  const view = await screen.findByRole('button', { name: /view pdf/i });
  await user.click(view);
  await waitFor(() => expect(screen.getByText('Viewed PDF for Dissolution')).toBeTruthy());
});