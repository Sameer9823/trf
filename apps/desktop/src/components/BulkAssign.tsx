import { useEffect, useMemo, useState } from 'react';
import type { Assignment, AssignmentInput, EmployeeProfile, TestCatalogItem } from '@trf/shared';
import { assignmentApi } from '../lib/assignments';
import { useAuth } from '../lib/auth';
import { Modal } from './Modal';

interface Row {
  key: string;
  testName: string;
  assignedEmployeeId: string;
  dueDate: string;
  testMethod: string;
  specification: string;
}

const emptyRow = (): Row => ({
  key: Math.random().toString(36).slice(2),
  testName: '', assignedEmployeeId: '', dueDate: '', testMethod: '', specification: '',
});

/**
 * Bulk assignment: several tests on one TRF, each with its own employee and due
 * date, submitted in a single request so either all of them are assigned or none.
 */
export function BulkAssign({ trfId, existing, onClose, onAssigned }: {
  trfId: number;
  existing: Assignment[];
  onClose: () => void;
  onAssigned: () => void;
}) {
  const { can } = useAuth();
  const mayManageCatalog = can('employees.manage');
  const [rows, setRows] = useState<Row[]>([emptyRow(), emptyRow(), emptyRow()]);
  const [employees, setEmployees] = useState<EmployeeProfile[]>([]);
  const [catalog, setCatalog] = useState<TestCatalogItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newTest, setNewTest] = useState('');

  useEffect(() => {
    void assignmentApi.assignables().then(setEmployees);
    void assignmentApi.catalog().then(setCatalog);
  }, []);

  // Tests already on this TRF cannot be assigned again, so they are not offered.
  const taken = useMemo(
    () => new Set(existing.map((a) => a.testName.trim().toLowerCase())), [existing]);
  const available = useMemo(
    () => catalog.filter((c) => !taken.has(c.name.toLowerCase())), [catalog, taken]);

  const setRow = (key: string, patch: Partial<Row>) =>
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  function pickCatalog(row: Row, name: string) {
    const item = catalog.find((c) => c.name === name);
    setRow(row.key, {
      testName: name,
      testMethod: item?.defaultMethod ?? '',
      specification: item?.specification ?? '',
    });
  }

  async function addToCatalog() {
    if (!newTest.trim()) return;
    const res = await window.trf.request<TestCatalogItem>({
      method: 'POST', path: '/api/test-catalog', body: { name: newTest.trim() },
    });
    if (!res.ok || !res.data) {
      setError('That test could not be added to the catalogue.');
      return;
    }
    setCatalog((c) => [...c, res.data!].sort((a, b) => a.name.localeCompare(b.name)));
    setNewTest('');
  }

  async function submit() {
    const filled = rows.filter((r) => r.testName.trim());
    if (filled.length === 0) { setError('Enter at least one test.'); return; }
    const missing = filled.find((r) => !r.assignedEmployeeId);
    if (missing) { setError(`Choose an employee for “${missing.testName.trim()}”.`); return; }

    const payload: AssignmentInput[] = filled.map((r) => ({
      testName: r.testName.trim(),
      assignedEmployeeId: Number(r.assignedEmployeeId),
      dueDate: r.dueDate || null,
      testMethod: r.testMethod.trim() || null,
      specification: r.specification.trim() || null,
    }));

    setBusy(true);
    setError(null);
    const res = await assignmentApi.createMany(trfId, payload);
    setBusy(false);
    if (!res.ok) { setError(res.message ?? 'The tests could not be assigned.'); return; }
    onAssigned();
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      title="Assign tests"
      busy={busy}
    >
      <p className="muted">
        Give each test its own employee and due date. Everything is saved together: if one
        test is refused, none of them is assigned.
      </p>
      {error && <p className="error-text" role="alert">{error}</p>}

      <table className="table table--form">
        <thead>
          <tr><th>Test</th><th>Employee</th><th>Due date</th><th aria-label="Remove" /></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td>
                <input list="test-catalog" value={row.testName} placeholder="Test name"
                  onChange={(e) => setRow(row.key, { testName: e.target.value })}
                  onBlur={(e) => { if (catalog.some((c) => c.name === e.target.value)) pickCatalog(row, e.target.value); }}
                  disabled={busy} />
                <datalist id="test-catalog">
                  {available.map((c) => <option key={c.id} value={c.name}>{c.defaultMethod ?? ''}</option>)}
                </datalist>
              </td>
              <td>
                <select value={row.assignedEmployeeId} onChange={(e) => setRow(row.key, { assignedEmployeeId: e.target.value })}
                  aria-label="Employee for this test" disabled={busy}>
                  <option value="">Choose…</option>
                  {employees.map((e) => (
                    <option key={e.id} value={e.id}>{e.fullName}{e.role !== 'Analyst' ? ` (${e.role})` : ''}</option>
                  ))}
                </select>
              </td>
              <td>
                <input type="date" value={row.dueDate} onChange={(e) => setRow(row.key, { dueDate: e.target.value })}
                  aria-label="Due date for this test" disabled={busy} />
              </td>
              <td>
                <button className="btn btn--ghost" onClick={() => setRows((c) => c.filter((r) => r.key !== row.key))}
                  aria-label="Remove this row" disabled={busy}>Remove</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="row">
        <button className="btn" onClick={() => setRows((c) => [...c, emptyRow()])} disabled={busy}>Add another test</button>
      </div>

      {mayManageCatalog && (
        <div className="inline-new">
          <span className="muted">Add a test to the catalogue so everyone spells it the same way:</span>
          <div className="inline-new__row">
            <input value={newTest} onChange={(e) => setNewTest(e.target.value)} placeholder="e.g. Moisture Content" disabled={busy} />
            <button className="btn" onClick={addToCatalog} type="button" disabled={busy}>Add</button>
          </div>
        </div>
      )}

      {existing.length > 0 && (
        <p className="muted">
          Already assigned: {existing.map((a) => a.testName).join(', ')}
        </p>
      )}

      <div className="row modal__actions">
        <button className="btn btn--primary" onClick={submit} disabled={busy}>
          {busy ? 'Assigning…' : 'Assign tests'}
        </button>
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
      </div>
    </Modal>
  );
}