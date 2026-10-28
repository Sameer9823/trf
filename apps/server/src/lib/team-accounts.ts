import type { EmployeeProfile, TeamType } from '@trf/shared';
import { pool } from '../db';

export interface TeamAccountRow {
  id: number;
  team: TeamType;
  username: string;
  password_hash: string;
  email: string;
  is_active: boolean;
  must_change_password: boolean;
  failed_login_count: number;
  locked_until: Date | null;
}

export const TEAM_LABEL: Record<TeamType, string> = {
  FRD: 'Formulation Team',
  ARD: 'Analytical Team',
};

const TEAM_COLUMNS = `id, team, username, password_hash, email, is_active, must_change_password, failed_login_count, locked_until`;

export async function loadTeamAccount(id: number): Promise<TeamAccountRow | undefined> {
  const result = await pool.query<TeamAccountRow>(`SELECT ${TEAM_COLUMNS} FROM team_accounts WHERE id = $1`, [id]);
  return result.rows[0];
}

export async function loadTeamAccountByLogin(login: string): Promise<TeamAccountRow | undefined> {
  const result = await pool.query<TeamAccountRow>(
    `SELECT ${TEAM_COLUMNS} FROM team_accounts WHERE lower(username) = lower($1) OR lower(email) = lower($1) LIMIT 1`, [login]);
  return result.rows[0];
}

/**
 * What the desktop shows before anyone has chosen their name. The id is negative
 * so it can never be confused with an employee id: that confusion is what once
 * let a team login be read as employee number one.
 */
export function teamPseudoProfile(account: TeamAccountRow): EmployeeProfile {
  return {
    id: -account.id,
    employeeCode: account.username,
    fullName: TEAM_LABEL[account.team],
    designation: null,
    email: account.email,
    username: account.username,
    role: 'Viewer',
    departmentId: null,
    departmentName: account.team,
    isActive: account.is_active,
    mustChangePassword: false,
    lastLoginAt: null,
    version: 1,
    createdAt: new Date(0).toISOString(),
    accountType: 'SHARED_TEAM',
    team: account.team,
    pinFailedAttempts: 0,
    pinLockedUntil: null,
  };
}
