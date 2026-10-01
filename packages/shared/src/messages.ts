/**
 * Standard messages. The wording below is the wording shown to employees.
 * Nothing technical (SQL, stack traces) ever reaches the client.
 */
export const MESSAGES = {
  TRF_NUMBER_EXISTS: 'TRF number already exists.',
  CURRENCY_UNAVAILABLE: 'Unable to connect to company server.',
  SERVER_UNAVAILABLE: 'Company server is unavailable. Please connect to the company network.',
  RESULT_NOT_SAVED: 'Analysis result could not be saved.',
  NO_PERMISSION: 'Your account does not have permission to perform this action.',
  CONFLICT: 'This record was changed by someone else. Please reload and try again.',
  INVALID_CREDENTIALS: 'Invalid username or password.',
  ACCOUNT_LOCKED: 'This account is temporarily locked. Please try again later or contact your administrator.',
  ACCOUNT_INACTIVE: 'Your account is not active. Please contact your administrator.',
  EMAIL_EXISTS: 'This email address is already registered.',
  USERNAME_EXISTS: 'This username is already taken.',
  EMPLOYEE_CODE_EXISTS: 'This employee code is already registered.',
  LAST_ADMIN: 'This action would leave the system without an active administrator.',
  NOT_FOUND: 'Record not found.',
  VALIDATION: 'Some details are not valid. Please check the highlighted fields.',
} as const;

export type MessageKey = keyof typeof MESSAGES;
