/**
 * The designations a person in the company can hold, lowest to highest.
 * GM and COO are administrator designations: choosing one gives the person the
 * Admin role. AGM is a senior designation with its own AGM role.
 */
export const DESIGNATIONS = [
  'Trainee',
  'Junior Executive',
  'Junior Analyst',
  'Executive',
  'Senior Executive',
  'AGM',
  'GM',
  'COO',
] as const;
export type Designation = (typeof DESIGNATIONS)[number];

/** Designations that resolve to the Admin role: GM and COO only (not AGM). */
export const ADMIN_ROLE_DESIGNATIONS: readonly Designation[] = ['GM', 'COO'];

/** Senior designations: AGM, GM and COO. */
export const SENIOR_DESIGNATIONS: readonly Designation[] = ['AGM', 'GM', 'COO'];

export function isDesignation(value: string | null | undefined): value is Designation {
  return !!value && (DESIGNATIONS as readonly string[]).includes(value);
}

/** True when the designation makes the person an Admin (GM or COO). */
export function isAdminRoleDesignation(value: string | null | undefined): boolean {
  return !!value && (ADMIN_ROLE_DESIGNATIONS as readonly string[]).includes(value);
}

/** True when the designation is a senior designation (AGM, GM or COO). */
export function isSeniorDesignation(value: string | null | undefined): boolean {
  return !!value && (SENIOR_DESIGNATIONS as readonly string[]).includes(value);
}

/**
 * Deprecated alias for isSeniorDesignation. Prefer isAdminRoleDesignation or
 * isSeniorDesignation at each call site so the intent is clear.
 * @deprecated Use isAdminRoleDesignation or isSeniorDesignation instead.
 */
export function isAdminDesignation(value: string | null | undefined): boolean {
  return isSeniorDesignation(value);
}
