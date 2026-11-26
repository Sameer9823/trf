import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type {
  Customer, EmployeeOption, Product, TrfDetail, StageOption, RemarksStatus,
  ArdRemarksStatus, ArdReportingStatus, ArdCoaStatus, ArdWorkflowStatus, ArdStage,
  TeamType, DosageFormOption, TestRequestedOption, FinalApprovalStatus,
  ManufacturingLocationOption,
  ArdTestAssignment,
} from '@trf/shared';
import {
  REMARKS_STATUSES, ARD_COA_STATUSES,
  DEFAULT_ARD_STAGE, canEditTrfPartA, canEditTrfPartB, FINAL_APPROVAL_STATUSES,
  canSetRequiredCompletionDate,
} from '@trf/shared';
import { MESSAGES, ANALYTICAL_DEPARTMENTS, bulletList } from '@trf/shared';
import { fieldsOf, messageOf } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Icons } from '../components/Icons';
import { RemarksStatusBadge, ArdFinalStatusBadge } from '../components/Badges';
import { EmployeeSelect } from '../components/EmployeeSelect';
import { MultiSelect } from '../components/MultiSelect';
import { Field, FieldLock } from '../components/Fields';
import type { FieldOwner } from '../components/Fields';

interface FormState {
  trfDate: string;
  customerId: string;
  productId: string;
  genericName: string;
  batchNumber: string;
  batchSize: string;
  dosageForm: string;
  dosageFormOptionIds: number[];
  dosageFormOther: string;
  manufacturingLocation: string;
  labelClaim: string;
  packSize: string;
  packType: string;
  storageCondition: string;
  storagePeriod: string;
  manufacturingDate: string;
  expiryDate: string;
  testRequestedOptionIds: number[];
  testRequestedOther: string;
  specialInstructions: string;
  analysisPurpose: string;
  requiredCompletionDate: string;
  sampleQuantity: string;
  sampleSubmittedById: string;
  sampleReceivedById: string;
  /** The legacy free-text column. Shown, never written by this form. */
  sampleGivenBy: string;
  remarksStatus: RemarksStatus;
  remarks: string;
  signatureDate: string;
  stage: ArdStage;
  ardAnalystId: string;
  analysisStartDate: string;
  reportingStatus: ArdReportingStatus;
  coaStatus: ArdCoaStatus;
  ardRemarksStatus: ArdRemarksStatus;
  ardRemarks: string;
  workflowStatus: ArdWorkflowStatus;
  sampleReceivedDate: string;
  // Test assignments (multi-test assignment for ARD)
  testAssignments: ArdTestAssignment[];
  // Approval fields
  formulationApprovalStatus: FinalApprovalStatus;
  ardApprovalStatus: FinalApprovalStatus;
  formulationDecidedByName: string | null;
  formulationDecidedAt: string | null;
  finalDecidedByName: string | null;
  finalDecidedAt: string | null;
  ardDecidedByName: string | null;
  ardDecidedAt: string | null;
  lockedAt: string | null;
  lockedByName: string | null;
}

const blank = (today: string): FormState => ({
  trfDate: today,
  customerId: '', productId: '', genericName: '', batchNumber: '', batchSize: '',
  dosageForm: '', dosageFormOptionIds: [], dosageFormOther: '', manufacturingLocation: '', labelClaim: '',
  packSize: '', packType: '', storageCondition: '', storagePeriod: '',
  manufacturingDate: '', expiryDate: '',
  testRequestedOptionIds: [],
  testRequestedOther: '',
  specialInstructions: '', analysisPurpose: '', requiredCompletionDate: '',
  sampleQuantity: '', sampleSubmittedById: '', sampleReceivedById: '', sampleGivenBy: '',
  remarksStatus: 'Pending', remarks: '', signatureDate: '',
  stage: DEFAULT_ARD_STAGE, ardAnalystId: '', analysisStartDate: '',
  reportingStatus: 'Pending', coaStatus: 'Pending', ardRemarksStatus: 'Pending',
  ardRemarks: '', workflowStatus: 'Received', sampleReceivedDate: '',
  testAssignments: [],
  formulationApprovalStatus: 'None', ardApprovalStatus: 'None',
  formulationDecidedByName: null, formulationDecidedAt: null,
  finalDecidedByName: null, finalDecidedAt: null,
  ardDecidedByName: null, ardDecidedAt: null,
  lockedAt: null, lockedByName: null,
});

const today = () => new Date().toISOString().slice(0, 10);

/** The lookup routes are plural on the server; the kind here is singular. */
const LOOKUP_PATH: Record<'customer' | 'product' | 'employee', string> = {
  customer: '/api/lookups/customers',
  product: '/api/lookups/products',
  employee: '/api/lookups/employees',
};

const LOOKUP_LABEL: Record<'customer' | 'product', string> = {
  customer: 'Customer',
  product: 'Product',
};

/** The field labels use the same wording as the rest of the TRF screen. */
const LOOKUP_FIELD_LABEL: Record<'customer' | 'product', string> = {
  customer: 'Market/Customer',
  product: 'Product Name',
};

/** Sentinel option value for "Other (type new)" in the dropdowns. */
const OTHER_OPTION = '__other__';

/** The forward path of the Final Status, drawn by the stepper. */
const FINAL_STATUS_STEPS: readonly ArdWorkflowStatus[] = ['Received', 'In Progress', 'Completed'];

function InlineNew({ kind, open, onOpenChange, onCreated }: {
  kind: 'customer' | 'product';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (created: { id: number; name: string }) => void;
}) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [genericName, setGenericName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const { employee } = useAuth();

  if (!employee || !canEditTrfPartA(employee)) return null;

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await window.trf.request<{ id: number; name: string }>({
      method: 'POST', path: LOOKUP_PATH[kind],
      body: {
        name: name.trim(), code: code.trim() || null,
        ...(kind === 'product' ? { genericName: genericName.trim() || null } : {}),
      },
    });
    setBusy(false);
    if (!res.ok || !res.data) {
      setFields(fieldsOf(res.data));
      setError(messageOf(res.data, `${LOOKUP_LABEL[kind]} could not be created.`));
      return;
    }
    onCreated({ id: res.data.id, name: res.data.name });
    onOpenChange(false);
    setName('');
    setCode('');
    setGenericName('');
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !busy) {
      e.preventDefault();
      void submit();
    }
  };

  if (!open) {
    return (
      <button type="button" className="btn btn--ghost" onClick={() => onOpenChange(true)}>
        + New {kind}
      </button>
    );
  }

  return (
    <div className="inline-new" onKeyDown={handleKeyDown}>
      <div className="inline-new__row">
        <input placeholder={`${LOOKUP_LABEL[kind]} name`} value={name}
          onChange={(e) => setName(e.target.value)} aria-label={`new ${kind} name`} />
        {kind === 'product' && (
          <input placeholder="Generic name (optional)" value={genericName}
            onChange={(e) => setGenericName(e.target.value)} aria-label="new product generic name" />
        )}
        <input placeholder="Code (optional)" value={code} onChange={(e) => setCode(e.target.value)}
          aria-label={`new ${kind} code`} />
        <button className="btn btn--primary" type="button" disabled={busy} onClick={() => void submit()}>Add</button>
        <button className="btn" type="button" onClick={() => onOpenChange(false)}>Cancel</button>
      </div>
      {error && <p className="field-error">{error}{fields.name ? ` ${fields.name}` : ''}</p>}
    </div>
  );
}

/**
 * A lookup dropdown with a quick-add beside it. "Other (type new)" is the last
 * option and opens the same quick-add form the button opens, so a record that
 * is not in the list yet can be typed in without leaving the form.
 */
export function LookupSelect({ kind, items, value, fieldError, onChange, onCreated, disabled, lockOwner }: {
  kind: 'customer' | 'product';
  items: { id: number; name: string }[];
  value: string;
  fieldError?: string;
  onChange: (value: string) => void;
  onCreated: (created: { id: number; name: string }) => void;
  disabled?: boolean;
  lockOwner?: FieldOwner;
}) {
  const [adding, setAdding] = useState(false);
  const label = LOOKUP_LABEL[kind];
  const fieldLabel = LOOKUP_FIELD_LABEL[kind];
  const selectId = `trf-${kind}`;

  return (
    <div className={`field ${lockOwner ? 'field--locked' : ''}`}>
      <div className="field__head">
        <label htmlFor={selectId}>{fieldLabel} <span className="required-mark">*</span></label>
        {lockOwner && <FieldLock owner={lockOwner} />}
      </div>
      {items.length === 0 ? (
        <p className="muted">No {label.toLowerCase()}s yet. Add the first one below.</p>
      ) : (
        <select
          id={selectId}
          required
          disabled={disabled}
          value={value}
          onChange={(e) => {
            if (e.target.value === OTHER_OPTION) {
              onChange('');
              setAdding(true);
              return;
            }
            onChange(e.target.value);
          }}
        >
          <option value="">Select a {label.toLowerCase()}…</option>
          {items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          <option value={OTHER_OPTION}>Other (type new)</option>
        </select>
      )}
      {fieldError && <p className="field-error">{fieldError}</p>}
      <InlineNew
        kind={kind}
        open={adding}
        onOpenChange={setAdding}
        onCreated={onCreated}
      />
    </div>
  );
}

/**
 * The progress stepper. It highlights the Final Status the TRF is in now, so
 * the reader can see at a glance how far the request has come.
 */
export function FinalStatusStepper({ current }: { current: ArdWorkflowStatus }) {
  const steps = FINAL_STATUS_STEPS;
  const currentIndex = steps.indexOf(current);
  return (
    <div className="stepper" role="list" aria-label="Final Status progress">
      {steps.map((step, index) => {
        const state = current === 'Cancelled'
          ? 'stepper__step--done'
          : index < currentIndex ? 'stepper__step--done'
            : index === currentIndex ? 'stepper__step--current' : '';
        return (
          <div key={step} role="listitem" className={`stepper__step ${state}`}>
            <span className="stepper__dot" aria-hidden="true" />
            <span className="stepper__label">{step}</span>
          </div>
        );
      })}
      {current === 'Cancelled' && (
        <div role="listitem" className="stepper__step stepper__step--cancelled">
          <span className="stepper__dot" aria-hidden="true" />
          <span className="stepper__label">Cancelled</span>
        </div>
      )}
    </div>
  );
}

/**
 * The ARD Stage dropdown. It offers the active stages from the ard_stages
 * master table, keeps any legacy value a row still holds visible, and lets an
 * ARD user add a brand-new stage through "Other (type new)" without saving the
 * TRF. The quick-add is a div with an Add button and Enter-key handling, never
 * a form inside the form.
 */
function StageSelect({ id, value, options, disabled, fieldError, lockOwner, canAdd, onChange, onCreated }: {
  id: string;
  value: string;
  options: string[];
  disabled: boolean;
  fieldError?: string;
  lockOwner?: FieldOwner;
  canAdd: boolean;
  onChange: (name: string) => void;
  onCreated: (name: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [otherName, setOtherName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Active stages are offered; the current value stays visible even when it is
  // an inactive legacy value, so nothing is lost. "Other (type new)" is last.
  const shown = useMemo(() => {
    const list = [...options];
    if (value && !list.includes(value)) list.push(value);
    list.push('Other (type new)');
    return list;
  }, [options, value]);

  async function add() {
    const name = otherName.replace(/\s+/g, ' ').trim();
    if (!name) { setError('Enter a stage name.'); return; }
    setBusy(true); setError(null);
    const res = await window.trf.request<{ item: StageOption; duplicate: boolean }>({
      method: 'POST', path: '/api/lookups/stages', body: { name },
    });
    setBusy(false);
    if (!res.ok || !res.data) {
      setError(messageOf(res.data, 'The stage could not be added.'));
      return;
    }
    setAdding(false);
    setOtherName('');
    onCreated(res.data.item.name);
    if (res.data.duplicate) setError('A stage with this name already exists; the existing one was selected.');
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !busy) {
      e.preventDefault();
      void add();
    }
  };

  return (
    <Field htmlFor={id} label="Stage" lockOwner={lockOwner} error={fieldError}>
      {!adding && !disabled && canAdd && shown.includes('Other (type new)') && (
        <select id={id} disabled={disabled} value={value}
          onChange={(e) => {
            const name = e.target.value;
            if (name === 'Other (type new)') {
              onChange('');
              setAdding(true);
              return;
            }
            onChange(name);
          }}
        >
          {shown.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      )}
      {adding && (
        <div className="inline-new" onKeyDown={handleKeyDown}>
          <div className="inline-new__row">
            <input placeholder="New stage name" value={otherName}
              onChange={(e) => setOtherName(e.target.value)} autoFocus />
            <button className="btn btn--primary" type="button" disabled={busy || !otherName.trim()} onClick={() => void add()}>Add</button>
            <button className="btn" type="button" onClick={() => { setAdding(false); setOtherName(''); setError(null); }}>Cancel</button>
          </div>
          {error && <p className="field-error">{error}</p>}
        </div>
      )}
      {!adding && (disabled || !canAdd || !shown.includes('Other (type new)')) && (
        <select id={id} disabled={disabled} value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          {shown.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      )}
    </Field>
  );
}

export function TrfForm() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const { employee, can } = useAuth();
  const canEditAByRole = employee ? canEditTrfPartA(employee) : false;
  const canEditBByRole = employee ? canEditTrfPartB(employee) : false;

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [stages, setStages] = useState<StageOption[]>([]);
  const [dosageFormOptions, setDosageFormOptions] = useState<DosageFormOption[]>([]);
  const [testRequestedOptions, setTestRequestedOptions] = useState<TestRequestedOption[]>([]);
  const [manufacturingLocationOptions, setManufacturingLocationOptions] = useState<ManufacturingLocationOption[]>([]);
  const [form, setForm] = useState<FormState>(() => blank(today()));
  const [trfNumber, setTrfNumber] = useState('');
  const [ardNumber, setArdNumber] = useState('');
  const [sampleSubmittedByName, setSampleSubmittedByName] = useState<string | null>(null);
  const [ardAnalystName, setArdAnalystName] = useState<string | null>(null);
  const [sampleReceivedByName, setSampleReceivedByName] = useState<string | null>(null);
  const [trfData, setTrfData] = useState<TrfDetail | null>(null);
  // Test assignments state
  const [testAssignments, setTestAssignments] = useState<ArdTestAssignment[]>([]);
  const [ardEmployees, setArdEmployees] = useState<EmployeeOption[]>([]);
  const [loadingAssignments, setLoadingAssignments] = useState(false);
  // Open-test counts per ARD employee (for the Change analyst picker) and the
  // test currently being reassigned.
  const [workload, setWorkload] = useState<Record<number, number>>({});
  const [changeTarget, setChangeTarget] = useState<ArdTestAssignment | null>(null);
  // An approved TRF is locked for everyone. Only an administrator can unlock it, from the TRF page.
  const locked = !!trfData?.lockedAt;
  const isApproved = isEdit && trfData ? trfData.remarksStatus === 'Approved' : false;
  const canEditA = canEditAByRole && !locked;
  const canEditB = canEditBByRole && !locked;
  const isAdmin = employee?.role === 'Admin';
  const isAgm = employee?.designation === 'AGM';
  // AGM or Admin can approve Reporting, COA, ARD Remarks Status, and Final Status
  const canEditArdApproval = (isAdmin || isAgm) && !locked;
  // ARD analysts can edit: Analyst Name, Date of Analysis, Stage, ARD Remark
  const canEditArdAnalyst = canEditB && !locked;
  // AGM can set Required Completion Date: shared helper + approved + not locked
  const canSetRequiredDate = employee ? canSetRequiredCompletionDate(employee) && isApproved && !locked : false;
  // Admin (incl. AGM/GM designations) and Managers hold assignments.manage; the server enforces it too.
  const canManageAssignments = (isAdmin || isAgm || can('assignments.manage')) && !locked;
  const [version, setVersion] = useState<number | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(isEdit);
  // Each dropdown loads on its own. One failing lookup shows its own message and a Retry
  // button; it never blanks the others or blocks the TRF itself.
  const [lookupErrors, setLookupErrors] = useState<Record<string, string>>({});
  const [lookupNonce, setLookupNonce] = useState(0);
  const retryLookups = () => setLookupNonce((n) => n + 1);

  const reloadCustomers = (selectId?: number) => {
    void window.trf.request<{ items: Customer[] }>({ method: 'GET', path: '/api/lookups/customers' })
      .then((r) => {
        if (!r.ok || !r.data) return;
        setCustomers(r.data.items);
        // A quick-add selects the record it just created, so the user does not
        // have to find it in a long list.
        if (selectId !== undefined) set('customerId', String(selectId));
      });
  };
  const reloadProducts = (selectId?: number) => {
    void window.trf.request<{ items: Product[] }>({ method: 'GET', path: '/api/lookups/products' })
      .then((r) => {
        if (!r.ok || !r.data) return;
        setProducts(r.data.items);
        if (selectId !== undefined) set('productId', String(selectId));
      });
  };
  const reloadDosageFormOptions = (selectId?: number) => {
    void window.trf.request<{ items: DosageFormOption[] }>({ method: 'GET', path: '/api/lookups/dosage-forms' })
      .then((r) => {
        if (!r.ok || !r.data) return;
        setDosageFormOptions(r.data.items);
        if (selectId !== undefined) {
          setForm((f) => ({ ...f, dosageFormOptionIds: [...f.dosageFormOptionIds, selectId] }));
        }
      });
  };

  useEffect(() => {
    let cancelled = false;
    function load<T>(key: string, label: string, path: string, apply: (items: T[]) => void) {
      void window.trf.request<{ items: T[] }>({ method: 'GET', path }).then((r) => {
        if (cancelled) return;
        if (r.ok && r.data) {
          apply(r.data.items);
          setLookupErrors((e) => { if (!(key in e)) return e; const { [key]: _gone, ...rest } = e; return rest; });
        } else {
          setLookupErrors((e) => ({ ...e, [key]: `${label} could not be loaded: ${messageOf(r.data, 'request failed')}` }));
        }
      });
    }
    load<Customer>('customers', 'Customers', '/api/lookups/customers', setCustomers);
    load<Product>('products', 'Products', '/api/lookups/products', setProducts);
    load<StageOption>('stages', 'Stages', '/api/lookups/stages', setStages);
    load<DosageFormOption>('dosage', 'Dosage forms', '/api/lookups/dosage-forms', setDosageFormOptions);
    load<TestRequestedOption>('tests', 'Test options', '/api/lookups/test-requested-options', setTestRequestedOptions);
    load<ManufacturingLocationOption>('locations', 'Manufacturing locations', '/api/lookups/manufacturing-locations', setManufacturingLocationOptions);
    load<EmployeeOption>('employees', 'Employees', '/api/lookups/employees', setEmployees);
    return () => { cancelled = true; };
  }, [lookupNonce]);

  // ARD analysts for the assignment dropdowns. Uses the dedicated lookup when the server has it,
  // otherwise falls back to the employee list, matching ARD by team or by an analytical
  // department name (case-insensitive) instead of the exact text "ARD".
  useEffect(() => {
    let cancelled = false;
    const isArd = (e: EmployeeOption) =>
      e.team === 'ARD' ||
      (!!e.departmentName && ANALYTICAL_DEPARTMENTS.some((d) => e.departmentName!.toLowerCase().includes(d.toLowerCase())));
    void window.trf.request<{ items: EmployeeOption[] }>({ method: 'GET', path: '/api/lookups/ard-analysts' }).then((r) => {
      if (cancelled) return;
      if (r.ok && r.data) setArdEmployees(r.data.items);
      else setArdEmployees(employees.filter(isArd));
    });
    return () => { cancelled = true; };
  }, [lookupNonce, employees]);

  // Auto-populate generic name when productId changes or products load
  useEffect(() => {
    if (form.productId) {
      const selectedProduct = products.find(p => String(p.id) === form.productId);
      if (selectedProduct && selectedProduct.genericName && form.genericName !== selectedProduct.genericName) {
        set('genericName', selectedProduct.genericName);
      }
    }
  }, [form.productId, products]);

  useEffect(() => {
    if (!isEdit) return;
    let cancelled = false;
    void window.trf.request<TrfDetail>({ method: 'GET', path: `/api/trfs/${id}` }).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (!res.ok || !res.data) { setError(messageOf(res.data, 'This TRF could not be loaded.')); return; }
      const trf = res.data;
      setTrfData(trf);
      setVersion(trf.version);
      setTrfNumber(trf.trfNumber);
      setArdNumber(trf.ardNumber ?? '');
      setSampleSubmittedByName(trf.sampleSubmittedByName);
      setSampleReceivedByName(trf.sampleReceivedByName);
      setArdAnalystName(trf.analystName);
      setForm({
        trfDate: trf.trfDate,
        customerId: trf.customerId ? String(trf.customerId) : '',
        productId: trf.productId ? String(trf.productId) : '',
        batchNumber: trf.batchNumber ?? '',
        batchSize: trf.batchSize ?? '',
        dosageForm: trf.dosageForm ?? '',
        dosageFormOptionIds: trf.dosageFormOptionIds ?? [],
        dosageFormOther: trf.dosageFormOther ?? '',
        manufacturingLocation: trf.manufacturingLocation ?? '',
        labelClaim: trf.labelClaim ?? '',
        packSize: trf.packSize ?? '',
        packType: trf.packType ?? '',
        storageCondition: trf.storageCondition ?? '',
        storagePeriod: trf.storagePeriod ?? '',
        manufacturingDate: trf.manufacturingDate ?? '',
        expiryDate: trf.expiryDate ?? '',
        testRequestedOptionIds: trf.testRequestedOptionIds ?? [],
        testRequestedOther: trf.testRequestedOther ?? '',
        specialInstructions: trf.specialInstructions ?? '',
        analysisPurpose: trf.analysisPurpose ?? '',
        
        requiredCompletionDate: trf.requiredCompletionDate ?? '',
        sampleQuantity: trf.sampleQuantity ?? '',
        sampleSubmittedById: trf.sampleSubmittedById ? String(trf.sampleSubmittedById) : '',
        sampleReceivedById: trf.sampleReceivedById ? String(trf.sampleReceivedById) : '',
        sampleGivenBy: trf.sampleGivenBy ?? '',
        remarksStatus: trf.remarksStatus ?? 'Pending',
        remarks: trf.remarks ?? '',
        signatureDate: trf.signatureDate ?? '',
        stage: trf.stage ?? DEFAULT_ARD_STAGE,
        ardAnalystId: trf.ardAnalystId ? String(trf.ardAnalystId) : '',
        analysisStartDate: trf.analysisStartDate ?? '',
        reportingStatus: trf.reportingStatus,
        coaStatus: trf.coaStatus,
        ardRemarksStatus: trf.ardRemarksStatus ?? 'Pending',
        ardRemarks: trf.ardRemarks ?? '',
        workflowStatus: trf.workflowStatus,
        sampleReceivedDate: trf.sampleReceivedDate ?? '',
        // New fields
        genericName: trf.genericName ?? '',
        formulationApprovalStatus: trf.formulationApprovalStatus ?? 'None',
        ardApprovalStatus: trf.ardApprovalStatus ?? 'None',
        formulationDecidedByName: trf.formulationDecidedByName ?? null,
        formulationDecidedAt: trf.formulationDecidedAt ?? null,
        finalDecidedByName: trf.finalDecidedByName ?? null,
        finalDecidedAt: trf.finalDecidedAt ?? null,
        ardDecidedByName: trf.ardDecidedByName ?? null,
        ardDecidedAt: trf.ardDecidedAt ?? null,
        lockedAt: trf.lockedAt ?? null,
        lockedByName: trf.lockedByName ?? null,
        testAssignments: trf.testAssignments ?? [],
      });
    });
    return () => { cancelled = true; };
  }, [id, isEdit]);

  const reloadAssignments = async (): Promise<boolean> => {
    if (!isEdit || !id) return false;
    const res = await window.trf.request<{ items: ArdTestAssignment[] }>({ method: 'GET', path: `/api/ard-assignments/trfs/${id}` });
    if (!res.ok || !res.data) {
      setError(messageOf(res.data, 'Test assignments could not be loaded.'));
      return false;
    }
    setTestAssignments(res.data.items);
    setForm((prev) => ({ ...prev, testAssignments: res.data!.items }));
    return true;
  };

  // Load test assignments when editing a TRF
  useEffect(() => {
    if (!isEdit || !id) return;
    let cancelled = false;
    setLoadingAssignments(true);
    void reloadAssignments().finally(() => { if (!cancelled) setLoadingAssignments(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isEdit]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  // Open-test counts per ARD employee, for the Change analyst picker. Best-effort:
  // a failure just leaves the counts blank.
  useEffect(() => {
    if (!canManageAssignments) return;
    let cancelled = false;
    void window.trf.request<{ items: { employeeId: number; assigned: number; inProgress: number; submitted: number }[] }>({
      method: 'GET', path: '/api/ard-assignments/team-workload',
    }).then((r) => {
      if (cancelled || !r.ok || !r.data) return;
      const map: Record<number, number> = {};
      for (const w of r.data.items) map[w.employeeId] = w.assigned + w.inProgress + w.submitted;
      setWorkload(map);
    });
    return () => { cancelled = true; };
  }, [canManageAssignments]);

  // Test assignment helper functions. All of them reload from the server afterwards, so the
  // screen always shows the stored state and the current version number.
  const testNameFor = (testOptionId: number) => {
    const opt = testRequestedOptions.find((o) => o.id === testOptionId);
    return opt?.name ?? 'Unknown Test';
  };

  const updateTestAssignment = async (testOptionId: number, updates: Partial<ArdTestAssignment>) => {
    if (!isEdit || !id || busy) return;
    const existing = testAssignments.find((a) => a.testRequestedOptionId === testOptionId);
    setBusy(true);
    setError(null);
    // No row yet for this test: create it, instead of silently doing nothing.
    const res = existing?.id
      ? await window.trf.request({
        method: 'PATCH', path: `/api/ard-assignments/${existing.id}`,
        body: { ...updates, version: existing.version ?? 1 },
      })
      : await window.trf.request({
        method: 'POST', path: '/api/ard-assignments',
        body: {
          trfId: Number(id), testRequestedOptionId: testOptionId, testName: testNameFor(testOptionId),
          analystIds: updates.analystIds ?? [], dueDate: updates.dueDate ?? (form.requiredCompletionDate || null),
        },
      });
    if (!res.ok) {
      setBusy(false);
      setError(messageOf(res.data, 'The test assignment could not be saved.'));
      await reloadAssignments(); // pick up the latest version after a conflict
      return;
    }
    await reloadAssignments();
    setBusy(false);
  };

  const saveAllAssignments = async () => {
    if (!isEdit || !id || busy) return;
    setBusy(true);
    setError(null);
    const assignments = form.testRequestedOptionIds.map((testOptionId) => {
      const existing = testAssignments.find((a) => a.testRequestedOptionId === testOptionId);
      return {
        testRequestedOptionId: testOptionId,
        testName: testNameFor(testOptionId),
        analystIds: existing?.analystIds ?? [],
        dueDate: existing?.dueDate || form.requiredCompletionDate || null,
      };
    });
    const res = await window.trf.request({
      method: 'POST', path: '/api/ard-assignments/bulk', body: { trfId: Number(id), assignments },
    });
    if (!res.ok) {
      setBusy(false);
      setError(messageOf(res.data, 'The test assignments could not be saved.'));
      return;
    }
    await reloadAssignments();
    setBusy(false);
  };

  // Helper to get assignment status color
  const getAssignmentStatusColor = (status: string): string => {
    const colors: Record<string, string> = {
      'Pending Assignment': 'var(--muted)',
      'Assigned': 'var(--accent)',
      'In Progress': 'var(--accent-2)',
      'Completed': 'var(--ok)',
      'Re-test Required': 'var(--warn)',
      'Cancelled': 'var(--danger)',
    };
    return colors[status] ?? 'var(--ink)';
  };

  // When creating a new TRF, pre-fill the person-type fields with the employee
  // who is creating it. The employee loads asynchronously, so this runs after
  // auth has resolved and only once (the guard prevents re-sets).
  useEffect(() => {
    if (!isEdit && employee) {
      if (canEditAByRole && !form.sampleSubmittedById) {
        set('sampleSubmittedById', String(employee.id));
        setSampleSubmittedByName(employee.fullName);
      }
    }
  }, [isEdit, employee, canEditAByRole]);

  // Active stages are offered in the dropdown. A row that still holds a legacy
  // (inactive) value keeps it visible, so nothing is lost; "Other (type new)"
  // lets an ARD user add a brand-new stage without saving the TRF.
  const stageNames = useMemo(() => stages.filter((s) => s.isActive).map((s) => s.name), [stages]);

  const legacySampleGivenBy = !form.sampleSubmittedById && form.sampleGivenBy.trim()
    ? form.sampleGivenBy.trim()
    : null;


  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || (!canEditA && !canEditArdAnalyst && !canEditArdApproval)) return;

    // Checked here so the user is told straight away; the server checks the
    // same rules again, because a client-side check is only a convenience.
    const localFields: Record<string, string> = {};
    if (canEditA) {
      if (!form.customerId) localFields.customerId = 'Select a customer from the list or create one first.';
      if (!form.productId) localFields.productId = 'Select a product from the list or create one first.';
      if (form.remarksStatus === 'Rejected' && !form.remarks.trim()) {
        localFields.remarks = 'Explain why the remark is rejected.';
      }
    }
    if (Object.keys(localFields).length) {
      setFields(localFields);
      setError('Some details are not valid. Please check the highlighted fields.');
      return;
    }

    setBusy(true);
    setError(null);
    setFields({});

    const body: Record<string, unknown> = {};

    // Part A fields - only sent when user has Formulation edit access
    if (canEditA) {
      body.trfDate = form.trfDate;
      body.customerId = form.customerId ? Number(form.customerId) : null;
      body.productId = form.productId ? Number(form.productId) : null;
      body.genericName = form.genericName.trim() || null;
      body.batchNumber = form.batchNumber.trim() || null;
      body.batchSize = form.batchSize.trim() || null;
      body.dosageForm = form.dosageForm.trim() || null;
      body.dosageFormOther = form.dosageFormOther.trim() || null;
      body.dosageFormOptionIds = form.dosageFormOptionIds;
      body.manufacturingLocation = form.manufacturingLocation.trim() || null;
      body.labelClaim = form.labelClaim.trim() || null;
      body.packSize = form.packSize.trim() || null;
      body.packType = form.packType.trim() || null;
      body.storageCondition = form.storageCondition.trim() || null;
      body.storagePeriod = form.storagePeriod.trim() || null;
      body.manufacturingDate = form.manufacturingDate || null;
      body.expiryDate = form.expiryDate || null;
      body.testRequestedOptionIds = form.testRequestedOptionIds;
      body.testRequestedOther = form.testRequestedOther.trim() || null;
body.specialInstructions = form.specialInstructions.trim() || null;
       body.sampleQuantity = form.sampleQuantity.trim() || null;
       body.sampleSubmittedById = form.sampleSubmittedById ? Number(form.sampleSubmittedById) : null;
       body.remarks = form.remarks.trim() || null;
       body.signatureDate = form.signatureDate || null;
       if (isAdmin) {
        body.remarksStatus = form.remarksStatus;
        body.formulationApprovalStatus = form.formulationApprovalStatus;
        body.ardApprovalStatus = form.ardApprovalStatus;
      }
    }

    // ARD block fields - AGM/Admin can edit approval fields
    if (canEditArdApproval) {
      body.reportingStatus = form.reportingStatus;
      body.coaStatus = form.coaStatus;
      body.ardRemarksStatus = form.ardRemarksStatus;
      body.workflowStatus = form.workflowStatus;
    }
    // ARD Analysts can edit: Stage, Analyst Name, Date of Analysis, Sample Received By/Date, ARD Remark
    if (canEditArdAnalyst) {
      body.ardStage = form.stage;
      body.ardAnalystId = form.ardAnalystId ? Number(form.ardAnalystId) : null;
      body.sampleReceivedById = form.sampleReceivedById ? Number(form.sampleReceivedById) : null;
      body.sampleReceivedDate = form.sampleReceivedDate || null;
      body.analysisStartDate = form.analysisStartDate || null;
      body.ardRemarks = form.ardRemarks.trim() || null;
    }
    // AGM can set Required Completion Date: only when allowed, approved, not locked, and value changed
    if (isEdit && canSetRequiredDate && trfData && form.requiredCompletionDate !== trfData.requiredCompletionDate) {
      body.requiredCompletionDate = form.requiredCompletionDate || null;
    }

    const res = isEdit
      ? await window.trf.request<TrfDetail>({
        method: 'PATCH', path: `/api/trfs/${id}`, body: { ...body, version },
      })
      : await window.trf.request<TrfDetail>({ method: 'POST', path: '/api/trfs', body });
    setBusy(false);

    if (!res.ok || !res.data) {
      setFields(fieldsOf(res.data));
      setError(messageOf(res.data, isEdit ? 'The TRF could not be saved.' : 'The TRF could not be created.'));
      if (messageOf(res.data, '') === MESSAGES.CONFLICT) return;
      return;
    }
    navigate(`/trfs/${res.data.id}`, { replace: true });
  }

  if (loading) return <div className="page"><p className="muted">Loading…</p></div>;
  if (!isEdit && !canEditA) return <div className="page"><p className="error-text">Only Formulation department users can create TRFs.</p></div>;

  // The lock is shown on every field the signed-in user may not change.
  const partALock: FieldOwner | undefined = (canEditA && !isApproved) ? undefined : 'Formulation';
  // AGM/Admin lock for Reporting, COA, ARD Remarks Status, Final Status
  const ardApprovalLock: FieldOwner | undefined = canEditArdApproval ? undefined : 'ARD';
  // ARD Analyst lock for Analyst Name, Date of Analysis, Stage, ARD Remark
  const ardAnalystLock: FieldOwner | undefined = canEditArdAnalyst ? undefined : 'ARD';
  // The Formulation Status is admin-only: an analyst who can edit Part A still
  // cannot change it, so it carries a System lock unless Part A is already
  // locked (then the Formulation lock already explains why).
  const statusLock: FieldOwner | undefined = (canEditA && !isAdmin && !isApproved) ? 'System' : partALock;

// Compute test assignment field for conditional rendering
  const testAssignmentField = form.testRequestedOptionIds.length > 0 && trfData?.remarksStatus === 'Approved' ? (
    <Field htmlFor="trf-test-assignments" label="Test Assignments" lockOwner={canManageAssignments ? undefined : 'System'} className="field--wide">
      {loadingAssignments ? (
        <div className="assignment-table-loading">Loading test assignments…</div>
      ) : (
        <>
          {/* Summary Pills */}
          <div className="assignment-summary" style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
            <span className="badge badge--info" style={{ fontSize: '13px', padding: '6px 12px' }}>
              {form.testRequestedOptionIds.length} test{form.testRequestedOptionIds.length !== 1 ? 's' : ''}
            </span>
            <span className="badge badge--ok" style={{ fontSize: '13px', padding: '6px 12px' }}>
              {testAssignments.filter(a => (a.analystIds?.length ?? 0) > 0).length} assigned
            </span>
          </div>
          
          <div className="assignment-table-wrapper">
            <table className="assignment-table" role="grid">
              <thead>
                <tr>
                  <th style={{ width: '40%' }}>Test Requested</th>
                  <th style={{ width: '35%' }}>Assigned ARD Employee</th>
                  <th style={{ width: '25%' }}>Assignment</th>
                </tr>
              </thead>
              <tbody>
                {form.testRequestedOptionIds.map((testOptionId) => {
                  const testOption = testRequestedOptions.find(o => o.id === testOptionId);
                  const testName = testOption?.name ?? 'Unknown Test';
                  const customTest = form.testRequestedOther && form.testRequestedOptionIds.includes(
                    testRequestedOptions.find(o => o.name.toLowerCase() === 'other')?.id ?? -1
                  ) ? form.testRequestedOther : null;
                  const displayName = customTest && testOption?.name.toLowerCase() === 'other' ? `${testName} (${customTest})` : testName;
                  
                  // Find existing assignment for this test
                  const existingAssignment = testAssignments.find(a => a.testRequestedOptionId === testOptionId);
                  const assignedAnalystIds = existingAssignment?.analystIds ?? [];
                  const assignmentStatus = existingAssignment?.status ?? 'Pending Assignment';
                  const isAssigned = assignedAnalystIds.length > 0;
                  const assignedAnalystNames = isAssigned 
                    ? bulletList(assignedAnalystIds.map(id => ardEmployees.find(e => e.id === id)?.fullName))
                    : '';
                  
                  return (
                    <tr key={testOptionId} data-test={displayName}>
                      <td className="assignment-test-name">
                        <div className="test-name">{displayName}</div>
                        <div className="test-sub" style={{ fontSize: '12px', color: 'var(--muted)' }}>Requested by FRD</div>
                      </td>
                      <td className="assignment-analyst">
                        {canManageAssignments ? (
                          <div className="multi-analyst-select">
                            <select
                              className="employee-select"
                              disabled={!canManageAssignments}
                              value=""
                              onChange={(e) => {
                                const analystId = e.target.value ? Number(e.target.value) : null;
                                if (analystId && !assignedAnalystIds.includes(analystId)) {
                                  updateTestAssignment(testOptionId, { analystIds: [...assignedAnalystIds, analystId] });
                                }
                              }}
                            >
                              <option value="">+ Add analyst…</option>
                              {ardEmployees.filter(emp => !assignedAnalystIds.includes(emp.id)).map((emp) => (
                                <option key={emp.id} value={emp.id}>{emp.fullName}</option>
                              ))}
                            </select>
                            {assignedAnalystIds.length > 0 && (
                              <div className="analyst-chips">
                                {assignedAnalystIds.map(id => {
                                  const emp = ardEmployees.find(e => e.id === id);
                                  return emp ? (
                                    <span key={id} className="chip chip--removable">
                                      {emp.fullName}
                                      <button type="button" className="chip__remove" aria-label={`Remove ${emp.fullName}`}
                                        onClick={() => updateTestAssignment(testOptionId, { analystIds: assignedAnalystIds.filter(aid => aid !== id) })}>✕</button>
                                    </span>
                                  ) : null;
                                })}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="cell-bullets">{isAssigned ? assignedAnalystNames : 'Unassigned'}</span>
                        )}
                      </td>
                      <td className="assignment-status">
                        <span className={`mini-status ${assignmentStatus === 'Completed' ? 'assigned' : isAssigned ? 'assigned' : ''}`} style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '6px',
                          fontSize: '13px',
                          fontWeight: 500
                        }}>
                          {assignmentStatus === 'Completed' ? '●' : isAssigned ? '●' : '○'} {assignmentStatus === 'Completed' ? 'Completed' : isAssigned ? 'Assigned' : 'Unassigned'}
                        </span>
                        {canManageAssignments && isAssigned
                          && assignmentStatus !== 'Completed' && assignmentStatus !== 'Cancelled' && (
                          <button type="button" className="btn btn--ghost btn--sm" style={{ marginLeft: '8px' }}
                            onClick={() => setChangeTarget(existingAssignment ?? null)}>
                            Change analyst
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          
          {/* Save Footer */}
          <div className="assign-footer" style={{ 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'space-between', 
            gap: '16px', 
            marginTop: '16px', 
            paddingTop: '12px', 
            borderTop: '1px solid var(--line)',
            flexWrap: 'wrap'
          }}>
            <p style={{ margin: 0 }}>
              <strong id="assignmentHint">
                {testAssignments.filter(a => (a.analystIds?.length ?? 0) > 0).length} of {form.testRequestedOptionIds.length} tests assigned.
              </strong> Save to notify employees about new or changed assignments.
            </p>
            {canManageAssignments && (
              <button
                type="button"
                className="btn btn--primary"
                onClick={saveAllAssignments}
                disabled={busy}
              >
                {busy ? 'Saving…' : 'Save Assignments & Notify'}
              </button>
            )}
          </div>
          
          {form.testRequestedOptionIds.length > 0 && !canManageAssignments && (
            <p className="field-hint">Only an administrator or an ARD manager can assign tests, after Formulation approval.</p>
          )}
        </>
      )}
    </Field>
) : null;

  return (
    <div className="page page--wide">
      <div className="page__head">
        <h1>{isEdit ? 'Edit TRF' : 'New TRF'}</h1>
        <div className="row">
          {isEdit && (
            <a className="btn" href={`#/trfs/${id}/print`} onClick={() => navigate(`/trfs/${id}/print`)}>Print</a>
          )}
          <a className="btn" href={isEdit ? `#/trfs/${id}` : '#/trf'}>Cancel</a>
        </div>
      </div>

      {error && <p className="error-text" role="alert">{error}</p>}
      {Object.keys(lookupErrors).length > 0 && (
        <div className="error-text" role="alert">
          {Object.values(lookupErrors).map((m) => <p key={m}>{m}</p>)}
          <button type="button" className="btn" onClick={retryLookups}>Retry</button>
        </div>
      )}

      <form className="trf-form" onSubmit={submit}>
        <section className="card card--part-a">
          <header className="card__head">
            <h2>Part A — Formulation</h2>
            {!canEditA && <span className="badge badge--muted">Read-only</span>}
          </header>

          <div className="grid">
            <Field htmlFor="trf-number" label="TRF No." lockOwner="System">
              <input id="trf-number" value={trfNumber} readOnly disabled placeholder="Assigned when the TRF is created" />
            </Field>

            <Field htmlFor="trf-date" label="Date of Request" lockOwner={partALock} error={fields.trfDate}>
              <input id="trf-date" type="date" required disabled={!canEditA} value={form.trfDate}
                onChange={(e) => set('trfDate', e.target.value)} />
            </Field>

            <LookupSelect
              kind="product"
              items={products}
              value={form.productId}
              fieldError={fields.productId}
              disabled={!canEditA}
              lockOwner={partALock}
              onChange={(v) => {
                set('productId', v);
                // Auto-populate generic name when product is selected
                const selectedProduct = products.find(p => String(p.id) === v);
                if (selectedProduct) {
                  set('genericName', selectedProduct.genericName ?? '');
                } else {
                  set('genericName', '');
                }
              }}
              onCreated={({ id }) => reloadProducts(id)}
            />

            <Field htmlFor="trf-generic-name" label="Generic Name" lockOwner={partALock}>
              <input id="trf-generic-name" disabled={!canEditA} value={form.genericName}
                onChange={(e) => set('genericName', e.target.value)} placeholder="Auto-filled from product; editable" />
            </Field>

            <Field htmlFor="trf-batch" label="Batch Number" lockOwner={partALock}>
              <input id="trf-batch" disabled={!canEditA} value={form.batchNumber}
                onChange={(e) => set('batchNumber', e.target.value)} />
            </Field>

            <Field htmlFor="trf-batch-size" label="Batch Size" lockOwner={partALock}>
              <input id="trf-batch-size" disabled={!canEditA} value={form.batchSize}
                onChange={(e) => set('batchSize', e.target.value)} />
            </Field>

            <LookupSelect
              kind="customer"
              items={customers}
              value={form.customerId}
              fieldError={fields.customerId}
              disabled={!canEditA}
              lockOwner={partALock}
              onChange={(v) => set('customerId', v)}
              onCreated={({ id }) => reloadCustomers(id)}
            />

            <MultiSelect
              id="trf-dosage"
              label="Dosage Form"
              options={dosageFormOptions.map((o) => ({ id: o.id, name: o.name }))}
              value={form.dosageFormOptionIds}
              onChange={(ids) => set('dosageFormOptionIds', ids)}
              onOtherChange={(text) => set('dosageFormOther', text)}
              onOtherSubmit={async (text) => {
                const res = await window.trf.request<DosageFormOption>({
                  method: 'POST', path: '/api/lookups/dosage-forms', body: { name: text },
                });
                if (!res.ok || !res.data) {
                  setLookupErrors((e) => ({ ...e, dosage: messageOf(res.data, 'Could not create dosage form') }));
                  return null;
                }
                // Add the new option to the list and return its ID
                setDosageFormOptions((prev) => [...prev, res.data!]);
                return res.data.id;
              }}
              otherValue={form.dosageFormOther}
              showOther={true}
              otherOptionId={dosageFormOptions.find((o) => o.name.toLowerCase() === 'other')?.id}
              disabled={!canEditA}
              fieldError={fields.dosageFormOptionIds}
              lockOwner={partALock}
              placeholder="Search dosage form…"
            />

            <Field htmlFor="trf-location" label="Manufacturing Location" lockOwner={partALock}>
              <select id="trf-location" disabled={!canEditA} value={form.manufacturingLocation}
                onChange={(e) => set('manufacturingLocation', e.target.value)}>
                <option value="">Select manufacturing location</option>
                {manufacturingLocationOptions.map((opt) => (
                  <option key={opt.id} value={opt.name}>{opt.name}</option>
                ))}
              </select>
            </Field>

            <Field htmlFor="trf-label-claim" label="Label Claim" lockOwner={partALock}>
              <input id="trf-label-claim" disabled={!canEditA} value={form.labelClaim}
                onChange={(e) => set('labelClaim', e.target.value)} />
            </Field>

            <Field htmlFor="trf-pack-size" label="Pack Size" lockOwner={partALock}>
              <input id="trf-pack-size" disabled={!canEditA} value={form.packSize}
                onChange={(e) => set('packSize', e.target.value)} />
            </Field>

            <Field htmlFor="trf-pack-type" label="Pack Type" lockOwner={partALock}>
              <input id="trf-pack-type" disabled={!canEditA} value={form.packType}
                onChange={(e) => set('packType', e.target.value)} />
            </Field>

            <Field htmlFor="trf-storage-condition" label="Storage Condition (°C)" lockOwner={partALock}>
              <input id="trf-storage-condition" type="number" disabled={!canEditA} value={form.storageCondition}
                onChange={(e) => set('storageCondition', e.target.value)} placeholder="e.g. 2-8, 15-25" step="0.1" />
            </Field>

            <Field htmlFor="trf-storage-period" label="Storage Period (months)" lockOwner={partALock}>
              <div className="input-with-suffix">
                <input id="trf-storage-period" type="number" disabled={!canEditA} value={form.storagePeriod}
                  onChange={(e) => set('storagePeriod', e.target.value)} placeholder="e.g. 24" min="1" max="120" />
                <span className="input-suffix">months</span>
              </div>
            </Field>

            <Field htmlFor="trf-mfg-date" label="Manufacturing Date" lockOwner={partALock} error={fields.manufacturingDate}>
              <input id="trf-mfg-date" type="date" disabled={!canEditA} value={form.manufacturingDate}
                onChange={(e) => set('manufacturingDate', e.target.value)} />
            </Field>

            <Field htmlFor="trf-expiry-date" label="Expiry Date" lockOwner={partALock} error={fields.expiryDate}>
              <input id="trf-expiry-date" type="date" disabled={!canEditA} value={form.expiryDate}
                onChange={(e) => set('expiryDate', e.target.value)} />
            </Field>

            <MultiSelect
              id="trf-test-requested-options"
              label="Test Requested"
              options={testRequestedOptions.map((o) => ({ id: o.id, name: o.name }))}
              value={form.testRequestedOptionIds}
              onChange={(ids) => set('testRequestedOptionIds', ids)}
              onOtherChange={(text) => set('testRequestedOther', text)}
              otherValue={form.testRequestedOther}
              showOther={true}
              otherOptionId={testRequestedOptions.find((o) => o.name.toLowerCase() === 'other')?.id}
              disabled={!canEditA}
              fieldError={fields.testRequestedOptionIds}
              lockOwner={partALock}
              placeholder="Search tests…"
            />

            <Field htmlFor="trf-special" label="Test Details / Special Instructions" lockOwner={partALock} className="field--wide">
              <textarea id="trf-special" rows={2} disabled={!canEditA} value={form.specialInstructions}
                onChange={(e) => set('specialInstructions', e.target.value)} />
            </Field>

            <Field htmlFor="trf-analysis-purpose" label="Analysis Required For / Purpose" lockOwner={partALock} error={fields.analysisPurpose}>
              <input id="trf-analysis-purpose" disabled={!canEditA} value={form.analysisPurpose}
                onChange={(e) => set('analysisPurpose', e.target.value)} />
            </Field>

            <Field htmlFor="trf-qty" label="Sample Quantity" lockOwner={partALock}>
              <input id="trf-qty" disabled={!canEditA} value={form.sampleQuantity} placeholder="e.g. 2 kg"
                onChange={(e) => set('sampleQuantity', e.target.value)} />
            </Field>

            <Field htmlFor="trf-sample-submitted-by" label="Sample Submitted By" lockOwner={partALock} error={fields.sampleSubmittedById}>
              <input id="trf-sample-submitted-by" type="text" value={isEdit ? (sampleSubmittedByName ?? employee?.fullName ?? '') : (employee?.fullName ?? '')} readOnly disabled />
              <p className="field-hint">Automatically set to your account (read-only)</p>
            </Field>

            <Field htmlFor="trf-remarks-status" label="Status" lockOwner={statusLock}>
              <select id="trf-remarks-status" disabled={!canEditA || !isAdmin} value={form.remarksStatus}
                onChange={(e) => set('remarksStatus', e.target.value as RemarksStatus)}>
                {REMARKS_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <p className="field-hint">Current state: <RemarksStatusBadge status={form.remarksStatus} />{!isAdmin && ' Only an administrator approves or rejects.'}</p>
            </Field>

            <Field htmlFor="trf-formulation-approved-by" label="Approved By" lockOwner="System">
              <input id="trf-formulation-approved-by" type="text" value={isEdit && form.formulationDecidedByName ? form.formulationDecidedByName : (form.remarksStatus === 'Approved' ? employee?.fullName ?? '' : '')} readOnly disabled />
              <p className="field-hint">Shows the GM/Admin who approved the Formulation request</p>
            </Field>

            {legacySampleGivenBy && (
              <p className="field-hint field--wide">
                Previously entered: {legacySampleGivenBy}. Pick an employee to replace it.
              </p>
            )}

            <Field htmlFor="trf-remarks" label="Remarks" lockOwner={partALock} error={fields.remarks}>
              <textarea id="trf-remarks" rows={2} disabled={!canEditA} value={form.remarks}
                onChange={(e) => set('remarks', e.target.value)} />
              {!fields.remarks && form.remarksStatus === 'Rejected' && !form.remarks.trim() && (
                <p className="field-error">A rejected remark needs a note explaining why.</p>
              )}
            </Field>

            <Field htmlFor="trf-signature-date" label="Signature / Date" lockOwner={partALock}>
              <input id="trf-signature-date" type="date" disabled={!canEditA} value={form.signatureDate}
                onChange={(e) => set('signatureDate', e.target.value)} />
            </Field>
          </div>
        </section>

        <section className="card card--ard">
          <header className="card__head">
            <h2>ARD — Analysis Details</h2>
            <span className="badge badge--info">ARD</span>
            {!canEditB && <span className="badge badge--muted">Read-only</span>}
          </header>

          {isEdit && trfData && locked && (
            <div className="approval-bar approval-bar--locked" role="status">
              <span className="approval-bar__icon" aria-hidden>{Icons.lock}</span>
              <span className="approval-bar__text"><strong>Approved and locked</strong><span>Nothing on this TRF can change until an administrator unlocks it.</span></span>
            </div>
          )}
          {isEdit && trfData && !locked && trfData.remarksStatus !== 'Approved' && (
            <div className="approval-bar approval-bar--pending" role="status">
              <span className="approval-bar__icon" aria-hidden>{Icons.lock}</span>
              <span className="approval-bar__text"><strong>Waiting for approval</strong><span>ARD work opens once an administrator approves this request.</span></span>
            </div>
          )}
          {isEdit && trfData && !locked && trfData.remarksStatus === 'Approved' && (canEditArdAnalyst || canEditArdApproval) && (
            <div className="approval-bar approval-bar--ready" role="status">
              <span className="approval-bar__icon" aria-hidden>{Icons.check}</span>
              <span className="approval-bar__text"><strong>ARD section is now open</strong><span>Fill in the analysis details below.</span></span>
            </div>
          )}

          <div className="grid">
            <Field htmlFor="trf-ard-number" label="A.R. No." lockOwner="System">
              <input id="trf-ard-number" value={ardNumber} readOnly disabled placeholder="Assigned when the TRF is created" />
            </Field>

            <StageSelect
              id="trf-ard-stage"
              value={form.stage}
              options={stages.map((s) => s.name)}
              disabled={!canEditArdAnalyst}
              fieldError={fields.stage}
              lockOwner={ardAnalystLock}
              canAdd={canEditArdAnalyst}
              onChange={(name) => set('stage', name)}
              onCreated={(name) => set('stage', name)}
            />

            <Field htmlFor="trf-ard-test-requested" label="Test Requested" lockOwner="System">
              <textarea id="trf-ard-test-requested" rows={2} value={bulletList(form.testRequestedOptionIds.map((id) => testRequestedOptions.find((o) => o.id === id)?.name))} readOnly disabled />
              <p className="field-hint">Carried forward from the Formulation request.</p>
            </Field>

            <Field htmlFor="trf-ard-test-details" label="Test Details" lockOwner="System">
              <textarea id="trf-ard-test-details" rows={2} value={form.specialInstructions} readOnly disabled />
              <p className="field-hint">Carried forward from the Formulation request.</p>
            </Field>

            {testAssignmentField}
            
            <>
            {form.testRequestedOptionIds.length === 0 && (
              <p className="field-hint">No tests requested. Add tests in the Formulation section.</p>
            )}
            </>

            <Field htmlFor="trf-analysis-start" label="Date of Analysis" lockOwner={ardAnalystLock} error={fields.analysisStartDate}>
              <input id="trf-analysis-start" type="date" disabled={!canEditArdAnalyst} value={form.analysisStartDate}
                onChange={(e) => set('analysisStartDate', e.target.value)} />
            </Field>

            <Field htmlFor="trf-required-completion" label="Required Completion Date" lockOwner={canSetRequiredDate ? undefined : 'AGM'} error={fields.requiredCompletionDate}>
              <input id="trf-required-completion" type="date" disabled={!canSetRequiredDate} value={form.requiredCompletionDate}
                onChange={(e) => set('requiredCompletionDate', e.target.value)} />
              {!canSetRequiredDate && (
                <p className="field-hint">
                  {isApproved ? 'Set by the AGM' : 'Opens once the Formulation team approves this TRF'}
                </p>
              )}
            </Field>

            <Field htmlFor="trf-coa" label="COA" lockOwner={ardApprovalLock}>
              <select id="trf-coa" disabled={!canEditArdApproval} value={form.coaStatus}
                onChange={(e) => set('coaStatus', e.target.value as ArdCoaStatus)}>
                {ARD_COA_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>

            <Field htmlFor="trf-ard-remarks" label="ARD Remark" lockOwner={ardAnalystLock} error={fields.ardRemarks}>
              <textarea id="trf-ard-remarks" rows={2} disabled={!canEditArdAnalyst} value={form.ardRemarks}
                onChange={(e) => set('ardRemarks', e.target.value)} />
            </Field>

            <Field htmlFor="trf-ard-final-status" label="Final Status" lockOwner={ardApprovalLock}>
              <select id="trf-ard-final-status" disabled={!canEditArdApproval} value={form.workflowStatus}
                onChange={(e) => set('workflowStatus', e.target.value as ArdWorkflowStatus)}>
                {(['Received', 'In Progress', 'Completed', 'Cancelled'] as ArdWorkflowStatus[]).map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <p className="field-hint">Current state: <ArdFinalStatusBadge status={form.workflowStatus} /></p>
            </Field>

            <Field htmlFor="trf-ard-approved-by" label="Approved By" lockOwner="System">
              <input id="trf-ard-approved-by" type="text" value={isEdit && ((form.finalDecidedByName ?? '') || (form.ardDecidedByName ?? '')) ? (form.finalDecidedByName ?? form.ardDecidedByName ?? '') : ''} readOnly disabled />
              <p className="field-hint">Shows the GM/Admin who approved the ARD/Final approval</p>
            </Field>

            <Field htmlFor="trf-sample-received-date" label="Sample Received Date" lockOwner={ardAnalystLock} error={fields.sampleReceivedDate}>
              <input id="trf-sample-received-date" type="date" disabled={!canEditArdAnalyst} value={form.sampleReceivedDate}
                onChange={(e) => set('sampleReceivedDate', e.target.value)} />
            </Field>

            <EmployeeSelect
              id="trf-sample-received-by"
              label="Sample Received By"
              value={form.sampleReceivedById}
              options={employees.filter((e) => e.departmentName === 'Formulation' || e.team === 'FRD')}
              disabled={!canEditArdAnalyst}
              lockOwner={ardAnalystLock}
              fieldError={fields.sampleReceivedById}
              onChange={(v) => set('sampleReceivedById', v)}
              placeholder="Search a Formulation employee…"
              emptyMessage="No Formulation employees are available to pick."
              selectedOption={sampleReceivedByName
                ? { id: Number(form.sampleReceivedById) || -1, employeeCode: '', fullName: sampleReceivedByName, designation: null, departmentName: null, team: 'FRD' }
                : null}
            />
          </div>

          <div className="card__foot">
            <FinalStatusStepper current={form.workflowStatus} />
          </div>
        </section>

        <div className="save-bar">
          <div className="row">
            <button className="btn btn--primary" type="submit" disabled={busy || (!canEditA && !canEditArdAnalyst && !canEditArdApproval)}>
              {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create TRF'}
            </button>
            {isEdit && <span className="muted">Version {version}</span>}
            {!canEditA && !canEditArdAnalyst && !canEditArdApproval && <span className="muted">You have read-only access to this TRF.</span>}
            {can('trf.changeStatus') && <span className="muted">The TRF status is changed on the TRF page.</span>}
          </div>
        </div>
      </form>
      {changeTarget && (
        <ChangeAnalystDialog
          assignment={changeTarget}
          employees={ardEmployees.filter((e) => !(changeTarget.analystIds ?? []).includes(e.id))}
          workload={workload}
          onClose={() => setChangeTarget(null)}
          onSaved={async () => { setChangeTarget(null); await reloadAssignments(); }}
        />
      )}
    </div>
  );
}

const REASSIGN_REASONS = ['Absent', 'On leave', 'Overloaded', 'Other'] as const;

/** Change the analyst on one ARD test: a replacement, a required reason, and the
 *  same-person guard. The server enforces the reason and the awaiting-review confirm. */
export function ChangeAnalystDialog({ assignment, employees, workload, onClose, onSaved }: {
  assignment: ArdTestAssignment;
  employees: EmployeeOption[];
  workload: Record<number, number>;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const currentIds = assignment.analystIds ?? [];
  const currentAnalystNames = currentIds.map(id => {
    const emp = employees.find(e => e.id === id);
    return emp ? emp.fullName : `Analyst #${id}`;
  });
  const [replaceId, setReplaceId] = useState<string>('');
  const [toId, setToId] = useState('');
  const [reasonKind, setReasonKind] = useState<string>('');
  const [reasonText, setReasonText] = useState('');
  const [confirmReview, setConfirmReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const awaitingReview = assignment.reviewStatus === 'Submitted';

  // Preselect the only analyst when there is exactly one
  const [, setReplaceIdInternal] = useState(() => {
    if (currentIds.length === 1) {
      setReplaceId(String(currentIds[0]));
    }
    return currentIds.length === 1 ? String(currentIds[0]) : '';
  });

  const reason = reasonKind === 'Other' ? reasonText.trim() : reasonKind;
  const samePerson = toId !== '' && currentIds.includes(Number(toId));
  const needsReplaceChoice = currentIds.length > 1;
  const hasReplaceChoice = !needsReplaceChoice || replaceId !== '';
  const canSubmit = hasReplaceChoice && !!toId && !samePerson && !!reason && (!awaitingReview || confirmReview) && !busy;

  // Compute the new analystIds: current ids with the chosen one removed and the replacement added
  const newAnalystIds = (() => {
    if (!toId) return currentIds;
    const replacementId = Number(toId);
    const removeId = Number(replaceId);
    const filtered = currentIds.filter(id => id !== removeId);
    if (filtered.includes(replacementId)) return filtered;
    return [...filtered, replacementId];
  })();

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const res = await window.trf.request({
      method: 'PATCH', path: `/api/ard-assignments/${assignment.id}`,
      body: {
        version: assignment.version,
        analystIds: newAnalystIds,
        reason,
        confirm: confirmReview,
      },
    });
    setBusy(false);
    if (!res.ok) { setError(messageOf(res.data, 'The analyst could not be changed.')); return; }
    await onSaved();
  };

  const replaceLabel = currentIds.length === 1
    ? `Replace ${currentAnalystNames[0]} on ${assignment.testName}`
    : `Replace analyst on ${assignment.testName}`;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Change analyst">
      <div className="modal">
        <div className="modal__head">
          <h3>{replaceLabel}</h3>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <div className="modal__body">
          {needsReplaceChoice && (
            <Field htmlFor="reassign-replace" label="Replace">
              <select id="reassign-replace" value={replaceId} disabled={busy} onChange={(e) => setReplaceId(e.target.value)}>
                <option value="">Select the analyst to replace…</option>
                {currentIds.map((id, idx) => (
                  <option key={id} value={id}>{currentAnalystNames[idx]}</option>
                ))}
              </select>
            </Field>
          )}
          <Field htmlFor="reassign-to" label="New analyst">
            <select id="reassign-to" value={toId} disabled={busy || needsReplaceChoice && !replaceId} onChange={(e) => setToId(e.target.value)}>
              <option value="">Select an analyst…</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id} disabled={samePerson && String(e.id) === toId}>
                  {e.fullName} — {workload[e.id] ?? 0} open
                </option>
              ))}
            </select>
          </Field>
          {samePerson && <p className="field-error">That is already the assigned analyst. Pick someone else.</p>}
          <Field htmlFor="reassign-reason" label="Reason (required)">
            <div className="row" style={{ gap: '6px', flexWrap: 'wrap', marginBottom: '6px' }}>
              {REASSIGN_REASONS.map((r) => (
                <button key={r} type="button" className={`btn btn--sm ${reasonKind === r ? 'btn--primary' : 'btn--ghost'}`}
                  onClick={() => setReasonKind(r)}>{r}</button>
              ))}
            </div>
            {reasonKind === 'Other'
              ? <textarea id="reassign-reason" rows={2} value={reasonText} disabled={busy} onChange={(e) => setReasonText(e.target.value)} placeholder="Tell the team why." />
              : <input id="reassign-reason" value={reasonKind} disabled readOnly placeholder="Choose a reason above." />}
          </Field>
          {awaitingReview && (
            <label className="checkbox">
              <input type="checkbox" checked={confirmReview} disabled={busy} onChange={(e) => setConfirmReview(e.target.checked)} />
              A result is already waiting for review. I confirm the new analyst should take over this test.
            </label>
          )}
          {error && <p className="field-error" role="alert">{error}</p>}
        </div>
        <div className="modal__foot">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn--primary" onClick={submit} disabled={!canSubmit}>
            {busy ? 'Changing…' : 'Change analyst'}
          </button>
        </div>
      </div>
    </div>
  );
}