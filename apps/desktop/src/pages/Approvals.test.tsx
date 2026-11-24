import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { EmployeeProfile } from '@trf/shared';
import { afterEach, test, expect, vi } from 'vitest';
import { AuthContext, type AuthSessionState } from '../lib/auth';
import { Approvals } from './Approvals';

afterEach(() => {
  cleanup();
  delete (window as unknown as { trf?: unknown }).trf;
});

const ADMIN: EmployeeProfile = {
  id: 9, employeeCode: 'EMP009', fullName: 'Asha Rao', designation: 'AGM', email: 'asha@example.com', username: 'asha',
  role: 'Admin', departmentId: 2, departmentName: 'ARD', isActive: true, mustChangePassword: false, lastLoginAt: null, version: 1,
  createdAt: '2026-01-01T00:00:00Z', accountType: 'INDIVIDUAL', team: null, pinFailedAttempts: 0, pinLockedUntil: null,
};

const ANALYST: EmployeeProfile = { ...ADMIN, id: 3, fullName: 'Ketan Sharma', designation: 'Executive', role: 'Analyst' };

function auth(employee: EmployeeProfile): AuthSessionState {
  return {
    employee, status: 'signed-in', actingEmployeeId: employee.id, accountId: null, can: () => true, canAccessModule: () => true,
    login: async () => ({ ok: true }), selectMember: async () => ({ ok: true }), switchUser: async () => {}, logout: async () => {},
  };
}

interface Call { method: string; path: string }

function mount(opts: { employee?: EmployeeProfile; trfs?: unknown[]; results?: unknown[] } = {}) {
  const calls: Call[] = [];
  const employee = opts.employee ?? ADMIN;
  (window as unknown as { trf: unknown }).trf = {
    request: async (req: Call) => {
      calls.push(req);
      if (req.path.startsWith('/api/trfs')) return { ok: true, status: 200, data: { items: opts.trfs ?? [] } };
      if (req.path === '/api/ard-assignments/result-reviews') return { ok: true, status: 200, data: { items: opts.results ?? [] } };
      return { ok: false, status: 404, error: 'not found' };
    },
  };
  const utils = render(
    <AuthContext.Provider value={auth(employee)}>
      <MemoryRouter><Approvals /></MemoryRouter>
    </AuthContext.Provider>,
  );
  return { ...utils, calls };
}

const TRF = {
  id: 1, trfNumber: 'TRF/2026/0001', trfDate: '2026-01-05', ardNumber: 'ARD/2026/0001',
  productName: 'Vitamin C', batchNumber: 'B-1', remarksStatus: 'Pending',
};

const RESULT = {
  assignmentId: 11, assignmentVersion: 1, trfId: 1, trfNumber: 'TRF/2026/0001', arNumber: 'ARD/2026/0001',
  productName: 'Vitamin C', batchNumber: 'B-1', testName: 'Assay', resultValue: '99.5', resultText: null,
  unit: '%', outcome: 'Pass', submittedAt: null, submittedByName: 'Asha Rao', resultMode: 'text', fileName: null,
};

test('renders each queue as its own card, each table inside a .table-wrap', async () => {
  const { container } = mount({ trfs: [TRF], results: [RESULT] });
  await screen.findByText('Assay');

  const cards = container.querySelectorAll('.list-card');
  expect(cards.length).toBe(2);
  cards.forEach((card) => {
    expect(card.querySelector('.list-card__head h2')).not.toBeNull();
    const wrap = card.querySelector('.table-wrap');
    expect(wrap).not.toBeNull();
    expect(wrap!.querySelector('table.table')).not.toBeNull();
  });
});

test('shows an independent empty state in each card when both queues are empty', async () => {
  const { container } = mount({ trfs: [], results: [] });
  await screen.findByText('No results waiting');
  await screen.findByText('Nothing is waiting');

  const cards = container.querySelectorAll('.list-card');
  expect(cards.length).toBe(2);
  cards.forEach((card) => {
    expect(card.querySelector('.empty')).not.toBeNull();
    expect(card.querySelector('table.table')).toBeNull();
  });
});

test('a non-administrator sees only the approval queue, and the results endpoint is not called', async () => {
  const { container, calls } = mount({ employee: ANALYST, trfs: [] });
  await screen.findByText('Nothing is waiting');

  expect(container.querySelectorAll('.list-card').length).toBe(1);
  expect(calls.some((c) => c.path === '/api/ard-assignments/result-reviews')).toBe(false);
});