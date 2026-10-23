/**
 * The fields a TRF has, who owns each one, and the labels shown to users.
 *
 * A TRF is one record on one screen: Part A belongs to the Formulation team
 * and the ARD block starts on the same page. There is no separate ARD page.
 *
 * Two orders are maintained here:
 * - PART_A_FIELDS / ARD_FIELDS: the order on the form, the detail page and the
 *   printable TRF. Test Requested and Test Details are editable in Part A and
 *   shown read-only (carried forward) in the ARD block. Their labels are the
 *   plain form labels (e.g. "Status").
 * - LIST_FIELD_ORDER: the order of the TRF Management list's Columns toggle
 *   and the Excel TRF Master sheet. Test Requested and Test Details appear
 *   ONCE, right after Stage in the ARD block, and not a second time in the
 *   Part A column group. Their list labels differ ("Remarks / Status",
 *   "ARD Remarks / Status") because the list already has a separate "Status"
 *   column for the TRF status.
 */
export type TrfFieldOwner = 'formulation' | 'ard' | 'system';

export interface TrfFieldSpec {
  /** The property name on TrfDetail / TrfListItem. */
  key: string;
  /** The label used on the form, the detail page and the printable TRF. */
  label: string;
  /** The label used in the list and in Excel (defaults to `label`). */
  listLabel?: string;
  /** Who owns the field. Part A is Formulation, the ARD block is ARD. */
  owner: TrfFieldOwner;
  /**
   * True when the ARD block only repeats a Part A value. These fields are
   * shown read-only in the ARD card and are never editable from the ARD side.
   */
  carriedForward?: boolean;
  /** True when the value is calculated by the server and never stored. */
  computed?: boolean;
}

const spec = (key: string, label: string, owner: TrfFieldOwner, opts: { listLabel?: string; carriedForward?: boolean; computed?: boolean } = {}): TrfFieldSpec => ({
  key, label, owner, listLabel: opts.listLabel, carriedForward: opts.carriedForward, computed: opts.computed,
});

/** Part A - Formulation. Test Requested and Test Details are editable here. */
export const PART_A_FIELDS: readonly TrfFieldSpec[] = [
  spec('trfNumber', 'TRF No.', 'system'),
  spec('trfDate', 'Date of Request', 'formulation'),
  spec('productName', 'Product Name', 'formulation'),
  spec('batchNumber', 'Batch Number', 'formulation'),
  spec('batchSize', 'Batch Size', 'formulation'),
  spec('customerName', 'Market/Customer', 'formulation'),
  spec('dosageForm', 'Dosage Form', 'formulation'),
  spec('manufacturingLocation', 'Manufacturing Location', 'formulation'),
  spec('labelClaim', 'Label Claim', 'formulation'),
  spec('packSize', 'Pack Size', 'formulation'),
  spec('packType', 'Pack Type', 'formulation'),
  spec('storageCondition', 'Storage Condition', 'formulation'),
  spec('storagePeriod', 'Storage Period', 'formulation'),
  spec('manufacturingDate', 'Manufacturing Date', 'formulation'),
  spec('expiryDate', 'Expiry Date', 'formulation'),
  spec('requestedAnalysis', 'Test Requested', 'formulation'),
  spec('specialInstructions', 'Test Details', 'formulation'),
  spec('analysisPurpose', 'Analysis Required For / Purpose', 'formulation'),
  spec('requiredCompletionDate', 'Required Completion Date', 'formulation'),
  spec('sampleQuantity', 'Sample Quantity', 'formulation'),
  spec('sampleSubmittedByName', 'Sample Submitted By', 'formulation'),
  spec('remarksStatus', 'Status', 'formulation', { listLabel: 'Remarks / Status' }),
  spec('remarks', 'Remarks', 'formulation'),
  spec('signatureDate', 'Signature / Date', 'formulation'),
] as const;

/** The ARD block. It starts on the same page as Part A. */
export const ARD_FIELDS: readonly TrfFieldSpec[] = [
  spec('ardNumber', 'A.R. No.', 'system'),
  spec('stage', 'Stage', 'ard'),
  spec('requestedAnalysis', 'Test Requested', 'system', { carriedForward: true }),
  spec('specialInstructions', 'Test Details', 'system', { carriedForward: true }),
  spec('analystName', 'Analyst Name', 'ard'),
  spec('analysisStartDate', 'Date of Analysis', 'ard'),
  spec('reportingStatus', 'Reporting', 'ard'),
  spec('coaStatus', 'COA', 'ard'),
  spec('ardRemarksStatus', 'Status', 'ard', { listLabel: 'ARD Remarks / Status' }),
  spec('ardRemarks', 'ARD Remark', 'ard'),
  spec('tat', 'TAT', 'system', { computed: true }),
  spec('workflowStatus', 'Final Status', 'ard'),
  spec('sampleReceivedDate', 'Sample Received Date', 'formulation'),
] as const;

/**
 * The list and Excel order: Part A without Test Requested / Test Details
 * (they are shown once in the ARD block below), then the full ARD block.
 * The list labels differ from the form labels where the list needs a
 * disambiguated header ("Remarks / Status", "ARD Remarks / Status"), because
 * the list already has a separate "Status" column for the TRF status.
 */
export const LIST_FIELD_ORDER: readonly TrfFieldSpec[] = [
  ...PART_A_FIELDS.filter((f) => f.key !== 'requestedAnalysis' && f.key !== 'specialInstructions'),
  ...ARD_FIELDS,
] as const;

/** Label shown in the list / Excel for a field spec. */
export function listFieldLabel(field: TrfFieldSpec): string {
  return field.listLabel ?? field.label;
}

/** Label shown on the form / detail / print for a field spec. */
export function formFieldLabel(field: TrfFieldSpec): string {
  return field.label;
}

/** The owner of a field, or undefined when the key is not on the TRF. */
export function trfFieldOwner(key: string): TrfFieldOwner | undefined {
  const field = [...PART_A_FIELDS, ...ARD_FIELDS].find((f) => f.key === key);
  return field?.owner;
}

/** The form label of a field, or the key itself when it is not on the TRF. */
export function trfFieldLabel(key: string): string {
  const field = [...PART_A_FIELDS, ...ARD_FIELDS].find((f) => f.key === key);
  return field ? field.label : key;
}

/** The ARD block items the ARD team may change. Everything else in the block
 * is read-only for everybody: the A.R. number, the carried-forward test
 * details and the calculated TAT. */
export const ARD_EDITABLE_KEYS: readonly string[] = ARD_FIELDS
  .filter((f) => f.owner === 'ard')
  .map((f) => f.key);

/** The Part A fields the Formulation team may change. */
export const FORMULATION_EDITABLE_KEYS: readonly string[] = PART_A_FIELDS
  .filter((f) => f.owner === 'formulation')
  .map((f) => f.key);

/**
 * An employee as the dropdowns need them: enough to show a name and a
 * department, and nothing else. No password, no e-mail, no role.
 */
export interface EmployeeOption {
  id: number;
  employeeCode: string;
  fullName: string;
  designation: string | null;
  departmentName: string | null;
}

/** An ARD stage from the ard_stages master table. */
export interface StageOption {
  id: number;
  name: string;
  isActive: boolean;
}

/** The label the employee dropdown shows for an option. */
export function employeeOptionLabel(option: EmployeeOption): string {
  const department = option.departmentName ?? 'No department';
  return option.designation
    ? `${option.fullName} — ${option.designation} (${department})`
    : `${option.fullName} — ${department}`;
}
