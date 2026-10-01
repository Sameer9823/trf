import { useCallback, useEffect, useState } from 'react';
import type { EmployeeProfile, Department, Paginated, Role } from '@trf/shared';
import { ROLES, MESSAGES } from '@trf/shared';
import { useAuth } from '../lib/auth';

interface ApiBody { error?: { code?: string; message?: string; fields?: Record<string, string> } }

const EMPTY_FORM = {
  employeeCode: '', fullName: '', email: '', username: '', role: 'Analyst' as Role,
  departmentId: '', designation: '', phone: '', password: '',
};

type FormState = typeof EMPTY_FORM;

export function Employees() {
  const { can } = useAuth();
  const mayManage = can('employees.manage');

  const [data, setData] = useState<Paginated<EmployeeProfile>>({ items: [], total: 0, page: 1, pageSize: 25, pageCount: 1 });
  const [departments, setDepartments] = useState<Department[]>([]);
  const [search, setSearch] = useState('');
  const [role, setRole] = useState<'' | Role>('');
  const [isActive, setIsActive] = useState<'all' | 'true' | 'false'>('all');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState<EmployeeProfile | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [resetTarget, setResetTarget] = useState<EmployeeProfile | null>(null);
  const [newPassword, setNewPassword] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ page: String(page), pageSize: '25' });
    if (search.trim()) params.set('search', search.trim());
    if (role) params.set('role', role);
    if (isActive !== 'all') params.set('isActive', isActive);
    const res = await window.trf.request<Paginated<EmployeeProfile>>({ method: 'GET', path: `/api/employees?${params}` });
    setLoading(false);
    if (!res.ok || !res.data) {
      const body = res.data as ApiBody | undefined;
      setError(res.status === 0 ? MESSAGES.SERVER_UNAVAILABLE : body?.error?.message ?? 'Employees could not be loaded.');
      return;
    }
    setData(res.data);
  }, [page, search, role, isActive]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    void window.trf.request<{ items: Department[] }>({ method: 'GET', path: '/api/departments' })
      .then((res) => { if (res.ok && res.data) setDepartments(res.data.items); });
  }, []);

  function openCreate() {
    setEditing(null);
    setForm({ ...EMPTY_FORM });
    setFieldErrors({});
    setFormError(null);
  }

  function openEdit(employee: EmployeeProfile) {
    setEditing(employee);
    setForm({
      employeeCode: employee.employeeCode,
      fullName: employee.fullName,
      email: employee.email,
      username: employee.username,
      role: employee.role,
      departmentId: employee.departmentId ? String(employee.departmentId) : '',
      designation: employee.designation ?? '',
      phone: '',
      password: '',
    });
    setFieldErrors({});
    setFormError(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setFormError(null);
    setFieldErrors({});
    const body: Record<string, unknown> = {
      employeeCode: form.employeeCode.trim(),
      fullName: form.fullName.trim(),
      email: form.email.trim(),
      username: form.username.trim(),
      role: form.role,
      departmentId: form.departmentId ? Number(form.departmentId) : null,
      designation: form.designation.trim() || null,
    };
    if (!editing) {
      body.phone = form.phone.trim() || null;
      body.password = form.password;
    }

    const res = editing
      ? await window.trf.request<EmployeeProfile>({ method: 'PATCH', path: `/api/employees/${editing.id}`, body: { ...body, version: editing.version } })
      : await window.trf.request<EmployeeProfile>({ method: 'POST', path: '/api/employees', body });
    if (!res.ok || !res.data) {
      const parsed = res.data as ApiBody | undefined;
      setFieldErrors(parsed?.error?.fields ?? {});
      setFormError(parsed?.error?.message ?? 'The employee could not be saved.');
      return;
    }
    setForm(null);
    setEditing(null);
    void load();
  }

  async function setActive(employee: EmployeeProfile, nextActive: boolean) {
    setError(null);
    const res = await window.trf.request<EmployeeProfile>({
      method: 'POST', path: `/api/employees/${employee.id}/${nextActive ? 'activate' : 'deactivate'}`,
    });
    if (!res.ok) {
      const body = res.data as ApiBody | undefined;
      setError(body?.error?.message ?? MESSAGES.NO_PERMISSION);
      return;
    }
    void load();
  }

  async function submitReset(e: React.FormEvent) {
    e.preventDefault();
    if (!resetTarget) return;
    setFormError(null);
    const res = await window.trf.request<{ ok: boolean }>({
      method: 'POST', path: `/api/employees/${resetTarget.id}/reset-password`,
      body: { newPassword, mustChangePassword: true },
    });
    if (!res.ok) {
      const body = res.data as ApiBody | undefined;
      setFormError(body?.error?.message ?? 'The password could not be reset.');
      return;
    }
    setResetTarget(null);
    setNewPassword('');
  }

  return (
    <div className="page">
      <div className="page__head">
        <h1>Employees</h1>
        {mayManage && <button className="btn btn--primary" onClick={openCreate}>Add employee</button>}
      </div>

      <div className="filters">
        <input placeholder="Search name, code, email or username" value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        <select value={role} onChange={(e) => { setRole(e.target.value as Role | ''); setPage(1); }} aria-label="Filter by role">
          <option value="">All roles</option>
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <select value={isActive} onChange={(e) => { setIsActive(e.target.value as 'all' | 'true' | 'false'); setPage(1); }} aria-label="Filter by status">
          <option value="all">Active and inactive</option>
          <option value="true">Active only</option>
          <option value="false">Inactive only</option>
        </select>
      </div>

      {error && <p className="error-text" role="alert">{error}</p>}

      <table className="table">
        <thead>
          <tr>
            <th>Code</th><th>Name</th><th>Role</th><th>Department</th><th>Email</th>
            <th>Status</th><th>Last sign-in</th>{mayManage && <th aria-label="Actions" />}
          </tr>
        </thead>
        <tbody>
          {loading && <tr><td colSpan={mayManage ? 8 : 7} className="muted">Loading…</td></tr>}
          {!loading && data.items.length === 0 && (
            <tr><td colSpan={mayManage ? 8 : 7} className="muted">No employees match these filters.</td></tr>
          )}
          {!loading && data.items.map((e) => (
            <tr key={e.id}>
              <td>{e.employeeCode}</td>
              <td>{e.fullName}{e.mustChangePassword && <span className="badge badge--warn">Password change pending</span>}</td>
              <td>{e.role}</td>
              <td>{e.departmentName ?? '—'}</td>
              <td>{e.email}</td>
              <td><span className={`badge ${e.isActive ? 'badge--ok' : 'badge--muted'}`}>{e.isActive ? 'Active' : 'Inactive'}</span></td>
              <td>{e.lastLoginAt ? new Date(e.lastLoginAt).toLocaleString() : 'Never'}</td>
              {mayManage && (
                <td className="table__actions">
                  <button className="btn btn--ghost" onClick={() => openEdit(e)}>Edit</button>
                  <button className="btn btn--ghost" onClick={() => { setResetTarget(e); setNewPassword(''); setFormError(null); }}>Reset password</button>
                  <button className="btn btn--ghost" onClick={() => setActive(e, !e.isActive)}>
                    {e.isActive ? 'Deactivate' : 'Activate'}
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="pager">
        <span className="muted">{data.total} employee(s) · page {data.page} of {data.pageCount}</span>
        <span className="row">
          <button className="btn" disabled={data.page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
          <button className="btn" disabled={data.page >= data.pageCount} onClick={() => setPage((p) => p + 1)}>Next</button>
        </span>
      </div>

      {form && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={editing ? 'Edit employee' : 'Add employee'}>
          <form className="modal" onSubmit={save}>
            <h2>{editing ? `Edit ${editing.fullName}` : 'Add employee'}</h2>
            {formError && <p className="error-text" role="alert">{formError}</p>}

            <label htmlFor="emp-code">Employee code</label>
            <input id="emp-code" value={form.employeeCode} onChange={(e) => setForm({ ...form, employeeCode: e.target.value })} />
            {fieldErrors.employeeCode && <p className="field-error">{fieldErrors.employeeCode}</p>}

            <label htmlFor="emp-name">Full name</label>
            <input id="emp-name" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
            {fieldErrors.fullName && <p className="field-error">{fieldErrors.fullName}</p>}

            <label htmlFor="emp-email">Email</label>
            <input id="emp-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            {fieldErrors.email && <p className="field-error">{fieldErrors.email}</p>}

            <label htmlFor="emp-username">Username</label>
            <input id="emp-username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
            {fieldErrors.username && <p className="field-error">{fieldErrors.username}</p>}

            <label htmlFor="emp-role">Role</label>
            <select id="emp-role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>

            <label htmlFor="emp-dept">Department</label>
            <select id="emp-dept" value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })}>
              <option value="">Not set</option>
              {departments.filter((d) => d.isActive).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>

            <label htmlFor="emp-designation">Designation</label>
            <input id="emp-designation" value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })} />

            {!editing && (
              <>
                <label htmlFor="emp-phone">Phone</label>
                <input id="emp-phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />

                <label htmlFor="emp-password">Initial password</label>
                <input id="emp-password" type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
                <p className="muted">At least 10 characters, with a letter and a number. The employee must change it at first sign-in.</p>
                {fieldErrors.password && <p className="field-error">{fieldErrors.password}</p>}
              </>
            )}

            <div className="row modal__actions">
              <button className="btn btn--primary" type="submit">Save</button>
              <button className="btn" type="button" onClick={() => setForm(null)}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      {resetTarget && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Reset password">
          <form className="modal" onSubmit={submitReset}>
            <h2>Reset password for {resetTarget.fullName}</h2>
            {formError && <p className="error-text" role="alert">{formError}</p>}
            <p className="muted">Give the person a temporary password. They must change it at next sign-in, and their current sessions end.</p>
            <label htmlFor="reset-password">New password</label>
            <input id="reset-password" type="text" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
            <div className="row modal__actions">
              <button className="btn btn--primary" type="submit">Reset password</button>
              <button className="btn" type="button" onClick={() => setResetTarget(null)}>Cancel</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
