/**
 * The designations a person in the company can hold, lowest to highest.
 * AGM, GM and COO are administrators: choosing one of them gives the person the
 * Admin role, which is the only role that can approve, lock and reopen a TRF.
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

export const ADMIN_DESIGNATIONS: readonly Designation[] = ['AGM', 'GM', 'COO'];

export function isDesignation(value: string | null | undefined): value is Designation {
  return !!value && (DESIGNATIONS as readonly string[]).includes(value);
}

/** True when the designation carries administrator rights. */
export function isAdminDesignation(value: string | null | undefined): boolean {
  return !!value && (ADMIN_DESIGNATIONS as readonly string[]).includes(value);
}
