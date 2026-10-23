import { Role, Permission, AccountType, TeamType } from './permissions';

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
  accountType: AccountType;
  team: TeamType | null;
  pinFailedAttempts: number;
  pinLockedUntil: string | null;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  /** ISO timestamp; the desktop refreshes just before this. */
  accessTokenExpiresAt: string;
  employee: EmployeeProfile;
  /** For shared team accounts: the selected acting employee ID. */
  actingEmployeeId: number | null;
  /** For shared team accounts: the team account ID. */
  accountId: number | null;
}

/** /api/auth/me adds the granted permissions so the desktop can hide what it cannot do. */
export interface MeResponse extends EmployeeProfile {
  permissions: Permission[];
  actingEmployeeId: number | null;
  accountId: number | null;
}

/** Request to select a team member after shared account login. */
export interface SelectMemberRequest {
  employeeId: number;
  pin?: string;
}

/** Response after selecting a team member. */
export interface SelectMemberResponse {
  ok: boolean;
  message?: string;
  actingEmployee?: EmployeeProfile;
}

/** Request to verify PIN for a team member. */
export interface VerifyPinRequest {
  employeeId: number;
  pin: string;
}

/** Response for PIN verification. */
export interface VerifyPinResponse {
  ok: boolean;
  message?: string;
  lockedUntil?: string | null;
  failedAttempts?: number;
}
