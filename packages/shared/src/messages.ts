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
  // Shared team account messages
  SELECT_MEMBER_REQUIRED: 'Select your name to continue.',
  INVALID_PIN: 'Invalid PIN. Please try again.',
  PIN_LOCKED: 'This PIN is temporarily locked. Please try again later or contact your administrator.',
  MEMBER_INACTIVE: 'This team member is not active.',
  MEMBER_WRONG_TEAM: 'This team member does not belong to your team.',
  NO_ACTING_MEMBER: 'No team member selected. Please select your name to continue.',
  SESSION_LOCKED: 'Your session has been locked due to inactivity. Please select your name again.',
  PIN_REQUIRED: 'PIN is required for this team member.',
  APPROVAL_SELF_NOT_ALLOWED: 'You cannot approve your own request.',
  APPROVAL_REASON_REQUIRED: 'A reason is required for this action.',
  APPROVAL_ALREADY_DECIDED: 'This approval has already been decided.',
  EMAIL_NOT_CONFIGURED: 'Email is not configured. Please contact your administrator.',
  MAILBOX_NOT_FOUND: 'Mailbox not found for this team.',
} as const;

export type MessageKey = keyof typeof MESSAGES;
