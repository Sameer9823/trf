import type { EmployeeProfile } from '@trf/shared';
import type { Role } from '@trf/shared';

export interface EmployeeRow {
  id: number;
  employee_code: string;
  full_name: string;
  designation: string | null;
  department_id: number | null;
  department_name: string | null;
  email: string;
  phone: string | null;
  username: string;
  password_hash: string;
  role: Role;
  is_active: boolean;
  must_change_password: boolean;
  failed_login_count: number;
  locked_until: Date | null;
  last_login_at: Date | null;
  version: number;
  created_at: Date;
}

/** Explicit column list: the password hash must never be sent to the client. */
export const EMPLOYEE_SELECT = `
  e.id, e.employee_code, e.full_name, e.designation, e.department_id, d.name AS department_name,
  e.email, e.phone, e.username, e.password_hash, e.role, e.is_active, e.must_change_password,
  e.failed_login_count, e.locked_until, e.last_login_at, e.version, e.created_at
`;

export const EMPLOYEE_FROM = `
  FROM employees e
  LEFT JOIN departments d ON d.id = e.department_id
`;

export function toProfile(row: EmployeeRow): EmployeeProfile {
  return {
    id: row.id,
    employeeCode: row.employee_code,
    fullName: row.full_name,
    designation: row.designation,
    email: row.email,
    username: row.username,
    role: row.role,
    departmentId: row.department_id,
    departmentName: row.department_name,
    isActive: row.is_active,
    mustChangePassword: row.must_change_password,
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
    version: row.version,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
