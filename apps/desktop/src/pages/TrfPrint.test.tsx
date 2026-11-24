import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { writeFileSync, readFileSync } from 'node:fs';
import type { EmployeeProfile, TrfDetail } from '@trf/shared';
import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import { AuthContext } from '../lib/auth';
import { ServerStatusContext } from '../lib/server-status';
import type { AuthSessionState } from '../lib/auth';
import { TrfPrint } from './TrfPrint';

/**
 * The printed TRF reproduces the company's paper form. It prints only once the TRF is approved and
 * locked, every print is recorded before it happens, and the form names the administrator who gave
 * the final approval, not the person who issued the form.
 */

interface Call { method: string; path: string; body?: unknown }
const calls: Call[] = [];

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

function trf(overrides: Partial<TrfDetail> = {}): TrfDetail {
  return {
    id: 1, trfNumber: 'TRF/2026/0012', trfDate: '2026-10-23', customerName: 'Acme Foods', productName: 'Vitamin C Beadlets', genericName: 'Ascorbic acid',
    batchNumber: 'B-77', batchSize: '1000 kg', sampleQuantity: '200 g', packType: 'Drum', packSize: '25 kg', storageCondition: '25 C',
    storagePeriod: '24 months', manufacturingLocation: 'Chennai', labelClaim: '100 mg', analysisPurpose: 'Release testing.', testRequestedOptionNames: ['Assay', 'Moisture'], testRequestedOther: 'Particle size',
    manufacturingDate: '2026-09-01', expiryDate: '2028-09-01', remarks: 'Keep cold', sampleGivenBy: 'Stores', sampleSubmittedByName: 'Bhavin Patel',
    sampleReceivedByName: 'Ketan Sharma', ardNumber: 'ARD/2026/0004', createdByName: 'Bhavin Patel', createdAt: '2026-10-23T05:00:00Z',
    ardDecidedByName: 'Meena Rao', finalDecidedByName: 'Meena Rao', finalDecidedAt: '2026-10-26T10:30:00Z', finalApprovalStatus: 'Approved', lockedAt: '2026-10-26T10:30:00Z',
    ...overrides,
  } as TrfDetail;
}

function mount(record: TrfDetail, bridge: Partial<Record<string, unknown>> = {}) {
  (window as unknown as { trf: unknown }).trf = {
    request: async (req: Call) => {
      calls.push(req);
      if (req.method === 'GET' && req.path === '/api/trfs/1') return { ok: true, status: 200, data: record };
      if (req.method === 'GET' && req.path === '/api/settings/form') {
        return { ok: true, status: 200, data: { sopNo: 'QAQN-003:F1', revision: '00', effectiveDate: '20/01/26', issuedBy: 'Quality Head', department: 'Quality Assurance' } };
      }
      if (req.method === 'POST' && req.path === '/api/trfs/1/print-log') return { ok: true, status: 200, data: { ok: true } };
      return { ok: false, status: 404 };
    },
    printTrf: vi.fn(async () => ({ ok: true })),
    printToPDF: vi.fn(async () => ({ ok: true, path: 'C:/x.pdf' })),
    ...bridge,
  };
  // jsdom does not decode images.
  Object.defineProperty(HTMLImageElement.prototype, 'decode', { configurable: true, value: () => Promise.resolve() });
  const status = { state: 'connected' as const, health: null, serverUrl: 'http://localhost:4000', lastChecked: null, recheck: async () => {} };
  return render(
    <ServerStatusContext.Provider value={status}>
      <AuthContext.Provider value={auth()}>
        <MemoryRouter initialEntries={['/trfs/1/print']}>
          <Routes><Route path="/trfs/:id/print" element={<TrfPrint />} /></Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </ServerStatusContext.Provider>,
  );
}

beforeEach(() => { calls.length = 0; });
afterEach(() => { cleanup(); });

test('the form carries the paper form\'s labels, in the paper form\'s order, with the generic name under the product name', async () => {
  mount(trf());
  await screen.findByText('Test Request Form');
  const text = document.body.textContent ?? '';
  const order = ['SOP. No:', 'Revision No:', 'MASTER', 'EFFECTIVE DATE:', 'TITLE', 'Test Request Form', 'ISSUED BY:', 'Sign/Date:',
    'Product Name:', 'Date:', 'Generic Name:', 'Batch Number:', 'Batch Size:', 'Mfg Date:', 'Market/Customer:', 'Sample Quantity:', 'Exp Date:',
    'Storage Condition:', 'Storage period:', 'Pack type:', 'Manufacturing Location:', 'Pack size:', 'Label Claim:', 'Analysis Required for:',
    'Remarks:', 'Sampled by', 'TRF Number', 'Sample Received by', 'AR number', 'Prepared by', 'Approved by',
    'Signature/ Date', 'Department:', 'Page 1 of 1'];
  let at = -1;
  for (const label of order) {
    const next = text.indexOf(label, at + 1);
    expect(next, `${label} should follow the one before it`).toBeGreaterThan(at);
    at = next;
  }
});

test('the printed form does not show Sample given by', async () => {
  mount(trf());
  await screen.findByText('Test Request Form');
  const body = document.body.textContent ?? '';
  expect(body).not.toContain('Sample given by');
  expect(body).not.toContain('Stores');                 // the TRF's sampleGivenBy value is not printed
  expect(body).toContain('Sampled by');
  expect(body).toContain('TRF Number');
  expect(body).toContain('Sample Received by');
  expect(body).toContain('AR number');
});

test('the sample row has exactly four cells after removing Sample given by', async () => {
  mount(trf());
  await screen.findByText('Test Request Form');
  const row = document.querySelector('.trf-form__five');
  expect(row).toBeTruthy();
  const heads = row!.querySelectorAll('.head');
  expect(heads.length).toBe(4);
  expect(Array.from(heads).map((h) => h.textContent)).toEqual(
    ['Sampled by', 'TRF Number', 'Sample Received by', 'AR number'],
  );
});

test('the printed root uses the sheet class and is not the entry form', async () => {
  mount(trf());
  await screen.findByText('Test Request Form');
  const root = document.querySelector('.trf-print');
  expect(root?.querySelector('.trf-sheet')).toBeTruthy();
  expect(root?.querySelector('.trf-form')).toBeFalsy();
});

test('the sample-cells row has no inline border-top override, so the box draws its own top line', async () => {
  mount(trf());
  await screen.findByText('Test Request Form');
  const row = document.querySelector('.trf-form__five');
  expect(row).toBeTruthy();
  expect((row as HTMLElement).style.borderTop).toBe('');
});

test('the printed-form root rule has no flex gap and the entry form keeps its own class', async () => {
  const css = readFileSync(`${process.cwd()}/src/styles.css`, 'utf8');
  const sheetRule = css.match(/\.trf-sheet\s*\{[^}]*\}/);
  expect(sheetRule, 'the printed form needs a .trf-sheet rule').toBeTruthy();
  expect(sheetRule![0]).not.toMatch(/gap/);
  expect(sheetRule![0]).not.toMatch(/display:\s*flex/);
  expect(css).toContain('.trf-form { display: flex; flex-direction: column; gap: 16px; padding-bottom: 8px; }');
});

test('the entry form keeps its own .trf-form class and the printed form does not use it', async () => {
  const css = readFileSync(`${process.cwd()}/src/styles.css`, 'utf8');
  expect(css).toContain('.trf-form { display: flex; flex-direction: column; gap: 16px; padding-bottom: 8px; }');
  expect(css).toMatch(/\.trf-sheet\s*\{[^}]*display:\s*block/);
  expect(css).not.toMatch(/\.trf-sheet\s*\{[^}]*gap/);
  expect(css).not.toMatch(/\.trf-sheet\s*\{[^}]*display:\s*flex/);
  mount(trf());
  await screen.findByText('Test Request Form');
  const root = document.querySelector('.trf-print');
  expect(root?.querySelector('.trf-sheet')).toBeTruthy();
  expect(root?.querySelector('.trf-form')).toBeFalsy();
});

test('the values come from the TRF, the dates keep their calendar day, and Approved by is the final approver', async () => {
  mount(trf());
  await screen.findByText('Test Request Form');
  const body = document.body.textContent ?? '';
  expect(body).toContain('23-10-2026');          // the TRF date, not shifted by the time zone
  expect(body).toContain('01-09-2028');
  expect(body).toContain('TRF/2026/0012');
  expect(body).toContain('Ascorbic acid');
  expect(body).toContain('• Assay');               // each requested test is its own bullet
  expect(body).toContain('• Moisture');
  expect(body).toContain('• Other: Particle size');
  expect(body).toContain('Release testing.');       // the product's generic name
  expect(body).toContain('QAQN-003:F1');          // the controlled form's number
  expect(body).toContain('ARD/2026/0004');
  const footer = document.querySelector('.trf-form__footer')?.textContent ?? '';
  expect(footer).toContain('Prepared by');
  expect(footer).toContain('Approved by');
  expect(footer).toContain('Signature/ Date');
  expect((footer.match(/Signature\/ Date/g) ?? []).length).toBe(2);
  expect(footer).toContain('Department:');
  expect(footer).not.toContain('Quality Head');        // who issued the form is not who approved the TRF
  expect(footer).not.toContain('Meena Rao');            // the approver is signed by hand, not printed
  expect(footer).not.toContain('Bhavin Patel');         // the creator is signed by hand, not printed
  expect(footer).not.toContain('26-10-2026');           // the approval date is signed by hand, not printed
  expect(footer).not.toContain('23-10-2026');           // the creation date is signed by hand, not printed
});

test('the logo is found relative to the page, so it still loads from the packaged app', async () => {
  mount(trf());
  const logo = await screen.findByAltText('Kawman ExAct');
  // The path is built from the build's base. The packaged app is loaded from a file, so that base must be relative:
  // an absolute "/logo.png" would point at the root of the disk and the logo would be missing from every print.
  expect(logo.getAttribute('src')).toBe('./logo.png');
  expect(readFileSync(`${process.cwd()}/vite.config.ts`, 'utf8')).toMatch(/base:\s*'\.\/'/);
});

test('printing is recorded first, then happens; the audit call names no one, the server does', async () => {
  const user = userEvent.setup();
  const print = vi.fn(() => { expect(calls.some((c) => c.path === '/api/trfs/1/print-log')).toBe(true); });
  window.print = print;
  mount(trf());
  await user.click(await screen.findByRole('button', { name: 'Print' }));
  await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
  const log = calls.find((c) => c.path === '/api/trfs/1/print-log');
  expect(log?.body).toEqual({ format: 'print' });
});

test('Save as PDF records the export and asks for a file named after the TRF', async () => {
  const user = userEvent.setup();
  const printToPDF = vi.fn(async () => ({ ok: true, path: 'C:/x.pdf' }));
  mount(trf(), { printToPDF });
  await user.click(await screen.findByRole('button', { name: 'Save as PDF' }));
  await waitFor(() => expect(printToPDF).toHaveBeenCalledWith(1, 'TRF-TRF-2026-0012.pdf'));
  expect(calls.find((c) => c.path === '/api/trfs/1/print-log')?.body).toEqual({ format: 'pdf' });
});

test('if the print cannot be recorded nothing is printed, and the reason is shown', async () => {
  const user = userEvent.setup();
  const print = vi.fn();
  window.print = print;
  mount(trf(), {
    request: async (req: Call) => {
      if (req.path === '/api/trfs/1') return { ok: true, status: 200, data: trf() };
      if (req.path === '/api/settings/form') return { ok: false, status: 500 };
      return { ok: false, status: 409, data: { error: { message: 'A TRF can be printed only after it is approved and locked.' } } };
    },
  });
  await user.click(await screen.findByRole('button', { name: 'Print' }));
  expect((await screen.findByRole('alert')).textContent).toContain('approved and locked');
  expect(print).not.toHaveBeenCalled();
});

test('a TRF that is not approved and locked cannot be printed', async () => {
  mount(trf({ lockedAt: null, finalApprovalStatus: 'Pending' }));
  await screen.findByText('Test Request Form');
  expect((screen.getByRole('button', { name: 'Print' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Save as PDF' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/available after the final approval/i)).toBeTruthy();
});

test('the form still prints when the header settings cannot be read: the defaults are used', async () => {
  mount(trf(), {
    request: async (req: Call) => {
      if (req.path === '/api/trfs/1') return { ok: true, status: 200, data: trf() };
      return { ok: false, status: 403 };
    },
  });
  await screen.findByText('Test Request Form');
  expect(document.body.textContent).toContain('QAQN-003:F1');
  expect((screen.getByRole('button', { name: 'Print' }) as HTMLButtonElement).disabled).toBe(false);
});

/** For checking the page by eye: TRF_PRINT_DUMP=/tmp/print.html npx vitest run TrfPrint writes the page out as HTML. */
test('optionally dumps the rendered form to a file', async () => {
  const target = process.env.TRF_PRINT_DUMP;
  if (!target) return;
  mount(trf());
  await screen.findByText('Test Request Form');
  const css = readFileSync(`${process.cwd()}/src/styles.css`, 'utf8');
  const root = document.querySelector('.trf-print')!.cloneNode(true) as HTMLElement;
  root.querySelectorAll('.no-print, .trf-print__actions').forEach((el) => el.remove());
  const logo = root.querySelector('img');
  if (logo) logo.setAttribute('src', `file://${process.cwd()}/public/logo.png`);
  writeFileSync(target, `<!doctype html><meta charset="utf-8"><style>${css}</style><body><div id="root"><div class="shell"><div class="main"><main class="content">${root.outerHTML}</main></div></div></div></body>`);
  expect(within(document.body).getByText('Test Request Form')).toBeTruthy();
});

test('the page tells the shell when it is complete, so a PDF can be made unseen', async () => {
  mount(trf());
  await screen.findByText('Test Request Form');
  const logo = screen.getByAltText('Kawman ExAct');
  expect(document.documentElement.dataset.printState).toBe('loading'); // not until the logo has loaded
  logo.dispatchEvent(new Event('load'));
  await waitFor(() => expect(document.documentElement.dataset.printState).toBe('ready'));
});
