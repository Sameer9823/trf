import { useCallback, useEffect, useState } from 'react';
import type { EmployeeProfile, Department, Paginated, Role } from '@trf/shared';
import { ROLES, MESSAGES, DESIGNATIONS, isAdminDesignation } from '@trf/shared';
import { useAuth } from '../lib/auth';
import { TeamLogins } from '../components/TeamLogins';
import { Modal } from '../components/Modal';

interface ApiBody { error?: { code?: string; message?: string; fields?: Record<string, string> } }

const EMPTY_FORM = {
  employeeCode: '', fullName: '', email: '', username: '', role: 'Analyst' as Role,
  departmentId: '', designation: '', phone: '', password: '',
  accountType: 'INDIVIDUAL' as 'INDIVIDUAL' | 'SHARED_TEAM', team: '' as '' | 'FRD' | 'ARD', pin: '',
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
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [resetTarget, setResetTarget] = useState<EmployeeProfile | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [resetting, setResetting] = useState(false);

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
      accountType: employee.accountType,
      team: employee.team ?? '',
      pin: '',
    });
    setFieldErrors({});
    setFormError(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setSaving(true);
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
      accountType: form.accountType,
      team: form.accountType === 'SHARED_TEAM' ? form.team || null : null,
    };
    if (!editing) {
      body.phone = form.phone.trim() || null;
      if (form.accountType === 'INDIVIDUAL') body.password = form.password;
      if (form.accountType === 'SHARED_TEAM') body.pin = form.pin;
    }

    const res = editing
      ? await window.trf.request<EmployeeProfile>({ method: 'PATCH', path: `/api/employees/${editing.id}`, body: { ...body, version: editing.version } })
      : await window.trf.request<EmployeeProfile>({ method: 'POST', path: '/api/employees', body });
    setSaving(false);
    if (!res.ok || !res.data) {
      const parsed = res.data as ApiBody | undefined;
      setFieldErrors(parsed?.error?.fields ?? {});
      setFormError(parsed?.error?.message ?? 'The employee could not be saved.');
      return;
    }
    if (editing && form.accountType === 'SHARED_TEAM' && form.pin) {
      const pinRes = await window.trf.request({ method: 'PUT', path: `/api/employees/${editing.id}/pin`, body: { pin: form.pin } });
      if (!pinRes.ok) {
        const parsed = pinRes.data as ApiBody | undefined;
        setFieldErrors(parsed?.error?.fields ?? {});
        setFormError(parsed?.error?.message ?? 'The PIN could not be saved.');
        return;
      }
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
    setResetting(true);
    setFormError(null);
    const res = await window.trf.request<{ ok: boolean }>({
      method: 'POST', path: `/api/employees/${resetTarget.id}/reset-password`,
      body: { newPassword, mustChangePassword: true },
    });
    setResetting(false);
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

      {can('teamaccounts.manage') && <TeamLogins />}

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

      <div className="table-wrap">
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
      </div>

      <div className="pager">
        <span className="muted">{data.total} employee(s) · page {data.page} of {data.pageCount}</span>
        <span className="row">
          <button className="btn" disabled={data.page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
          <button className="btn" disabled={data.page >= data.pageCount} onClick={() => setPage((p) => p + 1)}>Next</button>
        </span>
      </div>

      {form && (
        <Modal
          open={true}
          onClose={() => !saving && setForm(null)}
          title={editing ? `Edit ${editing.fullName}` : 'Add employee'}
          busy={saving}
        >
          <form onSubmit={save}>
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

            <label htmlFor="emp-designation">Designation</label>
            <select id="emp-designation" value={form.designation}
              onChange={(e) => {
                const designation = e.target.value;
                setForm({ ...form, designation, ...(isAdminDesignation(designation) ? { role: 'Admin' as Role, accountType: 'INDIVIDUAL' as const, team: '' as const } : {}) });
              }}>
              <option value="">Not set</option>
              {form.designation && !(DESIGNATIONS as readonly string[]).includes(form.designation) && (
                <option value={form.designation}>{form.designation} (older entry)</option>
              )}
              {DESIGNATIONS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            {fieldErrors.designation && <p className="field-error">{fieldErrors.designation}</p>}

            <label htmlFor="emp-role">Role</label>
            <select id="emp-role" value={form.role} disabled={isAdminDesignation(form.designation)}
              onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            {isAdminDesignation(form.designation) && <p className="muted">{form.designation} is an administrator. Administrators approve, lock and unlock TRFs.</p>}

            <label htmlFor="emp-dept">Department</label>
            <select id="emp-dept" value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })}>
              <option value="">Not set</option>
              {departments.filter((d) => d.isActive).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>

            <label htmlFor="emp-account">Sign-in</label>
            <select id="emp-account" value={form.accountType} disabled={isAdminDesignation(form.designation) || form.role === 'Admin'}
              onChange={(e) => setForm({ ...form, accountType: e.target.value as 'INDIVIDUAL' | 'SHARED_TEAM' })}>
              <option value="INDIVIDUAL">Own username and password</option>
              <option value="SHARED_TEAM">Member of a team login (name and PIN)</option>
            </select>
            {fieldErrors.accountType && <p className="field-error">{fieldErrors.accountType}</p>}

            {form.accountType === 'SHARED_TEAM' && (
              <>
                <label htmlFor="emp-team">Team</label>
                <select id="emp-team" value={form.team} onChange={(e) => setForm({ ...form, team: e.target.value as '' | 'FRD' | 'ARD' })}>
                  <option value="">Choose a team</option>
                  <option value="FRD">FRD (Formulation)</option>
                  <option value="ARD">ARD (Analytical)</option>
                </select>
                {fieldErrors.team && <p className="field-error">{fieldErrors.team}</p>}

                <label htmlFor="emp-pin">{editing ? 'New PIN (leave empty to keep the current one)' : 'PIN'}</label>
                <input id="emp-pin" type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={form.pin}
                  onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/g, '') })} />
                <p className="muted">4 to 6 digits. The person enters it after choosing their name; it is stored only as a hash.</p>
                {fieldErrors.pin && <p className="field-error">{fieldErrors.pin}</p>}
              </>
            )}

            {!editing && (
              <>
                <label htmlFor="emp-phone">Phone</label>
                <input id="emp-phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />

                {form.accountType === 'INDIVIDUAL' && (
                  <>
                    <label htmlFor="emp-password">Initial password</label>
                    <input id="emp-password" type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
                    <p className="muted">At least 10 characters, with a letter and a number. The employee must change it at first sign-in.</p>
                    {fieldErrors.password && <p className="field-error">{fieldErrors.password}</p>}
                  </>
                )}
              </>
            )}

            <div className="row modal__actions">
              <button className="btn btn--primary" type="submit" disabled={saving}>Save</button>
              <button className="btn" type="button" onClick={() => setForm(null)}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}

      {resetTarget && (
        <Modal
          open={true}
          onClose={() => !resetting && setResetTarget(null)}
          title={`Reset password for ${resetTarget.fullName}`}
          busy={resetting}
        >
          <form onSubmit={submitReset}>
            {formError && <p className="error-text" role="alert">{formError}</p>}
            <p className="muted">Give the person a temporary password. They must change it at next sign-in, and their current sessions end.</p>
            <label htmlFor="reset-password">New password</label>
            <input id="reset-password" type="text" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
            <div className="row modal__actions">
              <button className="btn btn--primary" type="submit" disabled={resetting}>Reset password</button>
              <button className="btn" type="button" onClick={() => setResetTarget(null)}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
