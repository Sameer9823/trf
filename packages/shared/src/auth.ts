import { Role, Permission } from './permissions';

/** Profile as the client sees it. Never contains the password hash. */
export interface EmployeeProfile {
  id: number;
  employeeCode: string;
  fullName: string;
  designation: string | null;
  email: string;
  username: string;
  role: Role;
  departmentId: number | null;
  departmentName: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  version: number;
  createdAt: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  /** ISO timestamp; the desktop refreshes just before this. */
  accessTokenExpiresAt: string;
  employee: EmployeeProfile;
}

/** /api/auth/me adds the granted permissions so the desktop can hide what it cannot do. */
export interface MeResponse extends EmployeeProfile {
  permissions: Permission[];
}
