import { strict as assert } from 'node:assert';
import { after, before, test, TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { TrfDetail } from '@trf/shared';
import { buildApp } from '../app';
import { pool, isDatabaseReachable } from '../db';
import { runMigrations } from '../migrate';
import { hashPassword } from '../lib/password';

const dbReachable = isDatabaseReachable().catch(() => false);
let server: Server;
let baseUrl = '';

function maybe(name: string, fn: (t: TestContext) => Promise<void>) {
  test(name, async (t) => {
    if (!(await dbReachable)) return t.skip('no PostgreSQL database available');
    await fn(t);
  });
}

before(async () => {
  if (!(await dbReachable)) return;
  await runMigrations();
  server = buildApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

async function api<T = any>(path: string, init: RequestInit = {}, token?: string) {
  const res = await fetch(baseUrl + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

const post = (path: string, body: unknown, token?: string) => api(path, { method: 'POST', body: JSON.stringify(body) }, token);
const patch = (path: string, body: unknown, token?: string) => api(path, { method: 'PATCH', body: JSON.stringify(body) }, token);

const SUFFIX = Math.random().toString(36).slice(2, 7);
const TEAM_PASSWORD = 'Team-Shared-Pass-42';
const ADMIN_PASSWORD = 'Approvals-Admin-42';
let adminToken = '';
let adminId = 0;
let customerId = 0;
let productId = 0;
const trfIds: number[] = [];
const employeeIds: number[] = [];

async function login(username: string, password: string) {
  return post('/api/auth/login', { username, password });
}

async function teamMember(team: 'FRD' | 'ARD', pin = '4821', role: 'Analyst' | 'Manager' = 'Analyst') {
  const s = Math.random().toString(36).slice(2, 8);
  const res = await post('/api/employees', {
    employeeCode: `AP-${s}`, fullName: `Member ${s}`, email: `ap-${s}@test.local`, username: `ap${s}`,
    role, designation: 'Executive', accountType: 'SHARED_TEAM', team, pin,
  }, adminToken);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  employeeIds.push(res.body.id);
  return { id: res.body.id as number, fullName: res.body.fullName as string, pin };
}

async function teamSession(team: 'FRD' | 'ARD', member: { id: number; pin: string }) {
  const username = team === 'FRD' ? 'frd_team' : 'ard_team';
  const signedIn = await login(username, TEAM_PASSWORD);
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  const picked = await post('/api/auth/select-member', { employeeId: member.id, pin: member.pin }, signedIn.body.accessToken);
  assert.equal(picked.status, 200, JSON.stringify(picked.body));
  return { token: picked.body.tokens.accessToken as string, refreshToken: picked.body.tokens.refreshToken as string, pending: signedIn.body.accessToken as string };
}

async function newTrf(token: string) {
  const res = await post('/api/trfs', {
    trfDate: new Date().toISOString().slice(0, 10), customerId, productId, priority: 'Normal',
    batchNumber: `AP-${SUFFIX}-${Math.random().toString(36).slice(2, 6)}`,
  }, token);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  trfIds.push(res.body.id);
  return res.body as TrfDetail;
}

maybe('setup: an administrator, the two team logins and the base lookups', async () => {
  const hash = await hashPassword(ADMIN_PASSWORD);
  await pool.query(
    `INSERT INTO employees (employee_code, full_name, email, username, password_hash, role, designation)
     VALUES ('AP-ADMIN', 'Approvals Admin', 'ap-admin@test.local', 'approvalsadmin', $1, 'Admin', 'GM')
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = TRUE, role = 'Admin',
       failed_login_count = 0, locked_until = NULL`,
    [hash]);
  const teamHash = await hashPassword(TEAM_PASSWORD);
  await pool.query(`UPDATE team_accounts SET password_hash = $1, is_active = TRUE, failed_login_count = 0, locked_until = NULL`, [teamHash]);
  const signedIn = await login('approvalsadmin', ADMIN_PASSWORD);
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  adminToken = signedIn.body.accessToken;
  adminId = signedIn.body.employee.id;
  const c = await pool.query<{ id: number }>(`INSERT INTO customers (name, code) VALUES ('Test Base Customer', 'TBC-FIXTURE') ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`);
  const p = await pool.query<{ id: number }>(`INSERT INTO products (name, code) VALUES ('Test Base Product', 'TBP-FIXTURE') ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`);
  customerId = c.rows[0].id; productId = p.rows[0].id;
});

maybe('a team login is never read as an employee, and can do nothing until a member is chosen', async () => {
  const signedIn = await login('frd_team', TEAM_PASSWORD);
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  const pending = signedIn.body.accessToken as string;
  assert.ok(signedIn.body.employee.id < 0, 'the team profile can never share an id with an employee');

  const me = await api('/api/auth/me', {}, pending);
  assert.equal(me.status, 200);
  assert.notEqual(me.body.role, 'Admin');
  assert.deepEqual(me.body.permissions, []);

  for (const path of ['/api/trfs', '/api/employees', '/api/audit', '/api/dashboard/summary']) {
    const res = await api(path, {}, pending);
    assert.equal(res.status, 403, `${path} must be refused before a member is chosen`);
    assert.equal(res.body.error.code, 'SELECT_MEMBER_REQUIRED');
  }
});

maybe('a member needs the right PIN, is locked out after repeated failures, and a team member has no personal sign-in', async () => {
  const member = await teamMember('FRD', '3917');
  const signedIn = await login('frd_team', TEAM_PASSWORD);
  const pending = signedIn.body.accessToken as string;

  const names = await api('/api/employees/team-members', {}, pending);
  assert.equal(names.status, 200, JSON.stringify(names.body));
  const entry = names.body.items.find((m: { id: number }) => m.id === member.id);
  assert.ok(entry && entry.hasPin === true);
  assert.equal(JSON.stringify(names.body).includes('pin_hash'), false, 'the PIN never leaves the server');

  const wrong = await post('/api/auth/select-member', { employeeId: member.id, pin: '0000' }, pending);
  assert.equal(wrong.status, 403);
  const missing = await post('/api/auth/select-member', { employeeId: member.id }, pending);
  assert.equal(missing.status, 400);

  const personal = await login(`ap${member.fullName.slice(7)}`, 'anything-at-all-123');
  assert.equal(personal.status, 401, 'a team member cannot sign in as themselves');

  for (let i = 0; i < 5; i++) await post('/api/auth/select-member', { employeeId: member.id, pin: '1111' }, pending);
  const locked = await post('/api/auth/select-member', { employeeId: member.id, pin: member.pin }, pending);
  assert.equal(locked.status, 403, 'the right PIN is refused while the member is locked');
});

maybe('everything a team member does is recorded under their own name and the team account used', async () => {
  const member = await teamMember('FRD');
  const session = await teamSession('FRD', member);
  const trf = await newTrf(session.token);

  const audit = await pool.query<{ user_name: string; actor_employee_id: number; account_id: number | null }>(
    `SELECT user_name, actor_employee_id, account_id FROM audit_logs WHERE action = 'trf.created' AND record_ref = $1`, [trf.trfNumber]);
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0].actor_employee_id, member.id);
  assert.equal(audit.rows[0].user_name, member.fullName);
  assert.ok(audit.rows[0].account_id, 'the audit row names the shared team account');
  assert.equal(trf.createdByName, member.fullName);

  // Refreshing keeps the same person acting, not the team account at large.
  const refreshed = await post('/api/auth/refresh', { refreshToken: session.refreshToken });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  assert.equal(refreshed.body.actingEmployeeId, member.id);

  // "Not me" ends that member's refresh tokens, so the screen cannot be resumed without the PIN.
  const switched = await post('/api/auth/switch-user', {}, session.token);
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  assert.equal(switched.body.tokens.actingEmployeeId, null);
  const resumed = await post('/api/auth/refresh', { refreshToken: refreshed.body.refreshToken });
  assert.equal(resumed.status, 401);
});

maybe('only an administrator signed in as themselves approves; a team member never can', async () => {
  const frd = await teamMember('FRD', '2468', 'Manager');
  const session = await teamSession('FRD', frd);
  const trf = await newTrf(session.token);
  assert.equal(trf.remarksStatus, 'Pending');

  const selfApprove = await post(`/api/trfs/${trf.id}/decision`, { track: 'FORMULATION', decision: 'Approved', version: trf.version }, session.token);
  assert.equal(selfApprove.status, 403, JSON.stringify(selfApprove.body));
  const viaPatch = await patch(`/api/trfs/${trf.id}`, { version: trf.version, remarksStatus: 'Approved' }, session.token);
  assert.equal(viaPatch.status, 403, JSON.stringify(viaPatch.body));

  const noReason = await post(`/api/trfs/${trf.id}/decision`, { track: 'FORMULATION', decision: 'Rejected', version: trf.version }, adminToken);
  assert.equal(noReason.status, 400, 'a rejection needs a reason');

  const approved = await post(`/api/trfs/${trf.id}/decision`, { track: 'FORMULATION', decision: 'Approved', version: trf.version }, adminToken);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.remarksStatus, 'Approved');
  assert.equal(approved.body.formulationDecidedByName, 'Approvals Admin');
});

maybe('ARD completes, the administrator approves, and the TRF locks for everyone until it is unlocked with a reason', async () => {
  const frd = await teamMember('FRD');
  const ard = await teamMember('ARD', '9753');
  const frdSession = await teamSession('FRD', frd);
  const ardSession = await teamSession('ARD', ard);

  let trf = await newTrf(frdSession.token);
  const approved = await post(`/api/trfs/${trf.id}/decision`, { track: 'FORMULATION', decision: 'Approved', version: trf.version }, adminToken);
  trf = approved.body;

  // ARD fills its block, ending with who received the sample.
  const filled = await patch(`/api/trfs/${trf.id}`, {
    version: trf.version, ardAnalystId: ard.id, analysisStartDate: new Date().toISOString().slice(0, 10), sampleReceivedById: ard.id,
  }, ardSession.token);
  assert.equal(filled.status, 200, JSON.stringify(filled.body));
  assert.equal(filled.body.sampleReceivedByName, ard.fullName);
  trf = filled.body;

  const early = await post(`/api/trfs/${trf.id}/decision`, { track: 'ARD', decision: 'Approved', version: trf.version }, adminToken);
  assert.equal(early.status, 409, 'there is nothing to approve until ARD has completed');

  const completed = await post(`/api/trfs/${trf.id}/ard-status`, { status: 'Completed', version: trf.version }, ardSession.token);
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.finalApprovalStatus, 'Pending');
  trf = completed.body;

  // A rejection sends it back to ARD, still unlocked.
  const rejected = await post(`/api/trfs/${trf.id}/decision`, { track: 'ARD', decision: 'Rejected', reason: 'Assay result needs a repeat.', version: trf.version }, adminToken);
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  assert.equal(rejected.body.finalApprovalStatus, 'Rejected');
  assert.equal(rejected.body.lockedAt, null);
  assert.equal(rejected.body.workflowStatus, 'In Progress');
  trf = rejected.body;

  const again = await post(`/api/trfs/${trf.id}/ard-status`, { status: 'Completed', version: trf.version }, ardSession.token);
  trf = again.body;
  assert.equal(trf.finalApprovalStatus, 'Pending');

  const final = await post(`/api/trfs/${trf.id}/decision`, { track: 'ARD', decision: 'Approved', version: trf.version }, adminToken);
  assert.equal(final.status, 200, JSON.stringify(final.body));
  assert.ok(final.body.lockedAt, 'approval locks the TRF');
  assert.equal(final.body.finalDecidedByName, 'Approvals Admin');
  trf = final.body;

  // Nobody can change it, the administrator included.
  const attempts = [
    await patch(`/api/trfs/${trf.id}`, { version: trf.version, batchNumber: 'CHANGED' }, frdSession.token),
    await patch(`/api/trfs/${trf.id}`, { version: trf.version, ardRemarks: 'late edit' }, ardSession.token),
    await patch(`/api/trfs/${trf.id}`, { version: trf.version, batchNumber: 'CHANGED' }, adminToken),
    await post(`/api/trfs/${trf.id}/ard-status`, { status: 'In Progress', version: trf.version }, adminToken),
    await api(`/api/trfs/${trf.id}`, { method: 'DELETE' }, adminToken),
  ];
  for (const res of attempts) {
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'TRF_LOCKED');
  }

  // Only an administrator unlocks it, and only with a reason that is kept.
  const byTeam = await post(`/api/trfs/${trf.id}/unlock`, { version: trf.version, reason: 'I would like to change it please' }, ardSession.token);
  assert.equal(byTeam.status, 403);
  const noReason = await post(`/api/trfs/${trf.id}/unlock`, { version: trf.version, reason: 'short' }, adminToken);
  assert.equal(noReason.status, 400);
  const unlocked = await post(`/api/trfs/${trf.id}/unlock`, { version: trf.version, reason: 'Customer asked for a corrected batch number.' }, adminToken);
  assert.equal(unlocked.status, 200, JSON.stringify(unlocked.body));
  assert.equal(unlocked.body.lockedAt, null);
  assert.equal(unlocked.body.finalApprovalStatus, 'None');
  const editable = await patch(`/api/trfs/${trf.id}`, { version: unlocked.body.version, ardRemarks: 'Corrected' }, ardSession.token);
  assert.equal(editable.status, 200, JSON.stringify(editable.body));

  const history = await api(`/api/trfs/${trf.id}/approvals`, {}, adminToken);
  const states = history.body.items.map((i: { status: string }) => i.status);
  for (const expected of ['Approved', 'Rejected', 'Reopened']) assert.ok(states.includes(expected), `history lists ${expected}`);

  const audited = await pool.query<{ action: string }>(`SELECT action FROM audit_logs WHERE record_ref = $1`, [trf.trfNumber]);
  const actions = audited.rows.map((r) => r.action);
  for (const expected of ['trf.final_rejected', 'trf.final_approved', 'trf.locked', 'trf.unlocked']) assert.ok(actions.includes(expected), `audit has ${expected}`);
});

maybe('AGM, GM and COO are administrators and cannot be team members', async () => {
  for (const designation of ['AGM', 'GM', 'COO']) {
    const s = Math.random().toString(36).slice(2, 8);
    const res = await post('/api/employees', {
      employeeCode: `AD-${s}`, fullName: `Director ${s}`, email: `ad-${s}@test.local`, username: `ad${s}`,
      role: 'Viewer', designation, password: 'Director-Pass-42',
    }, adminToken);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.role, 'Admin', `${designation} is an administrator whatever role was sent`);
    employeeIds.push(res.body.id);
  }
  const s = Math.random().toString(36).slice(2, 8);
  const asMember = await post('/api/employees', {
    employeeCode: `AM-${s}`, fullName: `Member ${s}`, email: `am-${s}@test.local`, username: `am${s}`,
    role: 'Analyst', designation: 'COO', accountType: 'SHARED_TEAM', team: 'FRD', pin: '1357',
  }, adminToken);
  assert.equal(asMember.status, 400, 'an administrator cannot be a shared team member');
  const unknown = await post('/api/employees', {
    employeeCode: `UN-${s}`, fullName: `Unknown ${s}`, email: `un-${s}@test.local`, username: `un${s}`,
    role: 'Analyst', designation: 'Supreme Leader', password: 'Director-Pass-42',
  }, adminToken);
  assert.equal(unknown.status, 400, 'a designation must come from the list');
});

maybe('cleanup: the TRFs and people created above are removed', async () => {
  if (trfIds.length) {
    await pool.query('DELETE FROM trf_approvals WHERE trf_id = ANY($1)', [trfIds]);
    await pool.query('DELETE FROM trfs WHERE id = ANY($1)', [trfIds]);
  }
  await pool.query(`DELETE FROM refresh_tokens WHERE team_account_id IS NOT NULL`);
  if (employeeIds.length) await pool.query('DELETE FROM employees WHERE id = ANY($1)', [employeeIds]);
  await pool.query(`DELETE FROM employees WHERE username LIKE 'ad%' AND employee_code LIKE 'AD-%'`);
  await pool.query(`UPDATE team_accounts SET password_hash = '', is_active = FALSE`);
  assert.ok(adminId > 0);
});
