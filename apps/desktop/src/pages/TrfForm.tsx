import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type {
  Customer, EmployeeOption, Product, TrfDetail, StageOption, RemarksStatus,
  ArdRemarksStatus, ArdReportingStatus, ArdCoaStatus, ArdWorkflowStatus, ArdStage,
} from '@trf/shared';
import {
  REMARKS_STATUSES, ARD_REMARKS_STATUSES, ARD_REPORTING_STATUSES, ARD_COA_STATUSES,
  DEFAULT_ARD_STAGE, canEditTrfPartA, canEditTrfPartB,
} from '@trf/shared';
import { MESSAGES } from '@trf/shared';
import { fieldsOf, messageOf } from '../lib/api';
import { useAuth } from '../lib/auth';
import { RemarksStatusBadge, ArdRemarksStatusBadge, ArdFinalStatusBadge } from '../components/Badges';
import { EmployeeSelect } from '../components/EmployeeSelect';
import { Field, FieldLock } from '../components/Fields';
import type { FieldOwner } from '../components/Fields';

interface FormState {
  trfDate: string;
  customerId: string;
  productId: string;
  batchNumber: string;
  batchSize: string;
  dosageForm: string;
  manufacturingLocation: string;
  labelClaim: string;
  packSize: string;
  packType: string;
  storageCondition: string;
  storagePeriod: string;
  manufacturingDate: string;
  expiryDate: string;
  requestedAnalysis: string;
  specialInstructions: string;
  analysisPurpose: string;
  requiredCompletionDate: string;
  sampleQuantity: string;
  sampleSubmittedById: string;
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
}

const blank = (today: string): FormState => ({
  trfDate: today,
  customerId: '', productId: '', batchNumber: '', batchSize: '',
  dosageForm: '', manufacturingLocation: '', labelClaim: '',
  packSize: '', packType: '', storageCondition: '', storagePeriod: '',
  manufacturingDate: '', expiryDate: '', requestedAnalysis: '',
  specialInstructions: '', analysisPurpose: '', requiredCompletionDate: '',
  sampleQuantity: '', sampleSubmittedById: '', sampleGivenBy: '',
  remarksStatus: 'Pending', remarks: '', signatureDate: '',
  stage: DEFAULT_ARD_STAGE, ardAnalystId: '', analysisStartDate: '',
  reportingStatus: 'Pending', coaStatus: 'Pending', ardRemarksStatus: 'Pending',
  ardRemarks: '', workflowStatus: 'Received', sampleReceivedDate: '',
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
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const { employee } = useAuth();

  if (!employee || !canEditTrfPartA(employee)) return null;

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await window.trf.request<{ id: number; name: string }>({
      method: 'POST', path: LOOKUP_PATH[kind], body: { name: name.trim(), code: code.trim() || null },
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
function StageSelect({ id, value, options, disabled, fieldError, lockOwner, onChange, onCreated }: {
  id: string;
  value: string;
  options: string[];
  disabled: boolean;
  fieldError?: string;
  lockOwner?: FieldOwner;
  onChange: (name: string) => void;
  onCreated: (name: string) => void;
}) {
  const { employee } = useAuth();
  const canAdd = employee ? canEditTrfPartB(employee) : false;
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
  const canEditA = employee ? canEditTrfPartA(employee) : false;
  const canEditB = employee ? canEditTrfPartB(employee) : false;

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [stages, setStages] = useState<StageOption[]>([]);
  const [form, setForm] = useState<FormState>(() => blank(today()));
  const [trfNumber, setTrfNumber] = useState('');
  const [ardNumber, setArdNumber] = useState('');
  const [tat, setTat] = useState<number | null>(null);
  const [sampleSubmittedByName, setSampleSubmittedByName] = useState<string | null>(null);
  const [trfData, setTrfData] = useState<TrfDetail | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(isEdit);

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

  useEffect(() => {
    void window.trf.request<{ items: Customer[] }>({ method: 'GET', path: '/api/lookups/customers' })
      .then((r) => { if (r.ok && r.data) setCustomers(r.data.items); });
    void window.trf.request<{ items: Product[] }>({ method: 'GET', path: '/api/lookups/products' })
      .then((r) => { if (r.ok && r.data) setProducts(r.data.items); });
    // Active stages are offered in the ARD Stage dropdown. Anyone who can see a
    // TRF may read them.
    void window.trf.request<{ items: StageOption[] }>({ method: 'GET', path: '/api/lookups/stages' })
      .then((r) => { if (r.ok && r.data) setStages(r.data.items); });
    // The employee dropdown lists active employees of ANY role for anyone who can see a
    // TRF. It is a read-only lookup, so it needs no management permission.
    void window.trf.request<{ items: EmployeeOption[] }>({ method: 'GET', path: '/api/lookups/employees' })
      .then((r) => { if (r.ok && r.data) setEmployees(r.data.items); });
  }, []);

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
      setTat(trf.tat);
      setSampleSubmittedByName(trf.sampleSubmittedByName);
      setForm({
        trfDate: trf.trfDate,
        customerId: trf.customerId ? String(trf.customerId) : '',
        productId: trf.productId ? String(trf.productId) : '',
        batchNumber: trf.batchNumber ?? '',
        batchSize: trf.batchSize ?? '',
        dosageForm: trf.dosageForm ?? '',
        manufacturingLocation: trf.manufacturingLocation ?? '',
        labelClaim: trf.labelClaim ?? '',
        packSize: trf.packSize ?? '',
        packType: trf.packType ?? '',
        storageCondition: trf.storageCondition ?? '',
        storagePeriod: trf.storagePeriod ?? '',
        manufacturingDate: trf.manufacturingDate ?? '',
        expiryDate: trf.expiryDate ?? '',
        requestedAnalysis: trf.requestedAnalysis ?? '',
        specialInstructions: trf.specialInstructions ?? '',
        analysisPurpose: trf.analysisPurpose ?? '',
        requiredCompletionDate: trf.requiredCompletionDate ?? '',
        sampleQuantity: trf.sampleQuantity ?? '',
        sampleSubmittedById: trf.sampleSubmittedById ? String(trf.sampleSubmittedById) : '',
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
      });
    });
    return () => { cancelled = true; };
  }, [id, isEdit]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  // Active stages are offered in the dropdown. A row that still holds a legacy
  // (inactive) value keeps it visible, so nothing is lost; "Other (type new)"
  // lets an ARD user add a brand-new stage without saving the TRF.
  const stageNames = useMemo(() => stages.filter((s) => s.isActive).map((s) => s.name), [stages]);

  const legacySampleGivenBy = !form.sampleSubmittedById && form.sampleGivenBy.trim()
    ? form.sampleGivenBy.trim()
    : null;


  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;

    // Checked here so the user is told straight away; the server checks the
    // same rules again, because a client-side check is only a convenience.
    const localFields: Record<string, string> = {};
    if (!form.customerId) localFields.customerId = 'Select a customer from the list or create one first.';
    if (!form.productId) localFields.productId = 'Select a product from the list or create one first.';
    if (form.remarksStatus === 'Rejected' && !form.remarks.trim()) {
      localFields.remarks = 'Explain why the remark is rejected.';
    }
    if (Object.keys(localFields).length) {
      setFields(localFields);
      setError('Some details are not valid. Please check the highlighted fields.');
      return;
    }

    setBusy(true);
    setError(null);
    setFields({});

    const body: Record<string, unknown> = {
      trfDate: form.trfDate,
      customerId: form.customerId ? Number(form.customerId) : null,
      productId: form.productId ? Number(form.productId) : null,
      batchNumber: form.batchNumber.trim() || null,
      batchSize: form.batchSize.trim() || null,
      dosageForm: form.dosageForm.trim() || null,
      manufacturingLocation: form.manufacturingLocation.trim() || null,
      labelClaim: form.labelClaim.trim() || null,
      packSize: form.packSize.trim() || null,
      packType: form.packType.trim() || null,
      storageCondition: form.storageCondition.trim() || null,
      storagePeriod: form.storagePeriod.trim() || null,
      manufacturingDate: form.manufacturingDate || null,
      expiryDate: form.expiryDate || null,
      requestedAnalysis: form.requestedAnalysis.trim() || null,
      specialInstructions: form.specialInstructions.trim() || null,
      analysisPurpose: form.analysisPurpose.trim() || null,
      requiredCompletionDate: form.requiredCompletionDate || null,
      sampleQuantity: form.sampleQuantity.trim() || null,
      sampleSubmittedById: form.sampleSubmittedById ? Number(form.sampleSubmittedById) : null,
      remarksStatus: form.remarksStatus,
      remarks: form.remarks.trim() || null,
      signatureDate: form.signatureDate || null,
    };

    // The sample received date is Formulation data that the ARD block
    // shows. It is only sent when the user may change Part A.
    if (canEditA) {
      body.sampleReceivedDate = form.sampleReceivedDate || null;
    }

    // ARD block fields are only sent when the user has ARD edit access.
    if (canEditB) {
      body.ardStage = form.stage;
      body.ardAnalystId = form.ardAnalystId ? Number(form.ardAnalystId) : null;
      body.analysisStartDate = form.analysisStartDate || null;
      body.reportingStatus = form.reportingStatus;
      body.coaStatus = form.coaStatus;
      body.ardRemarksStatus = form.ardRemarksStatus;
      body.ardRemarks = form.ardRemarks.trim() || null;
      body.workflowStatus = form.workflowStatus;
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
  // The server is the authority: it accepts a create when the caller has Part A
  // rights, so the form must not apply a second, stricter rule of its own.
  if (!isEdit && !canEditA) return <div className="page"><p className="error-text">Only Formulation department users can create TRFs.</p></div>;
  if (isEdit && !canEditA && !canEditB) return <div className="page"><p className="error-text">{MESSAGES.NO_PERMISSION}</p></div>;

  // The lock is shown on every field the signed-in user may not change.
  const isApproved = isEdit && trfData ? trfData.remarksStatus === 'Approved' : false;
  const partALock: FieldOwner | undefined = (canEditA && !isApproved) ? undefined : 'Formulation';
  const ardLock: FieldOwner | undefined = (canEditB && isApproved) ? undefined : 'ARD';

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
              onChange={(v) => set('productId', v)}
              onCreated={({ id }) => reloadProducts(id)}
            />

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

            <Field htmlFor="trf-dosage" label="Dosage Form" lockOwner={partALock}>
              <input id="trf-dosage" disabled={!canEditA} value={form.dosageForm}
                onChange={(e) => set('dosageForm', e.target.value)} />
            </Field>

            <Field htmlFor="trf-location" label="Manufacturing Location" lockOwner={partALock}>
              <input id="trf-location" disabled={!canEditA} value={form.manufacturingLocation}
                onChange={(e) => set('manufacturingLocation', e.target.value)} />
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

            <Field htmlFor="trf-storage-condition" label="Storage Condition" lockOwner={partALock}>
              <input id="trf-storage-condition" disabled={!canEditA} value={form.storageCondition}
                onChange={(e) => set('storageCondition', e.target.value)} />
            </Field>

            <Field htmlFor="trf-storage-period" label="Storage Period" lockOwner={partALock}>
              <input id="trf-storage-period" disabled={!canEditA} value={form.storagePeriod}
                onChange={(e) => set('storagePeriod', e.target.value)} />
            </Field>

            <Field htmlFor="trf-mfg-date" label="Manufacturing Date" lockOwner={partALock} error={fields.manufacturingDate}>
              <input id="trf-mfg-date" type="date" disabled={!canEditA} value={form.manufacturingDate}
                onChange={(e) => set('manufacturingDate', e.target.value)} />
            </Field>

            <Field htmlFor="trf-expiry-date" label="Expiry Date" lockOwner={partALock} error={fields.expiryDate}>
              <input id="trf-expiry-date" type="date" disabled={!canEditA} value={form.expiryDate}
                onChange={(e) => set('expiryDate', e.target.value)} />
            </Field>

            <Field htmlFor="trf-requested" label="Test Requested" lockOwner={partALock} className="field--wide">
              <textarea id="trf-requested" rows={3} disabled={!canEditA} value={form.requestedAnalysis}
                onChange={(e) => set('requestedAnalysis', e.target.value)} />
            </Field>

            <Field htmlFor="trf-special" label="Test Details / Special Instructions" lockOwner={partALock} className="field--wide">
              <textarea id="trf-special" rows={2} disabled={!canEditA} value={form.specialInstructions}
                onChange={(e) => set('specialInstructions', e.target.value)} />
            </Field>

            <Field htmlFor="trf-analysis-purpose" label="Analysis Required For / Purpose" lockOwner={partALock}>
              <input id="trf-analysis-purpose" disabled={!canEditA} value={form.analysisPurpose}
                onChange={(e) => set('analysisPurpose', e.target.value)} />
            </Field>

            <Field htmlFor="trf-due" label="Required Completion Date" lockOwner={partALock} error={fields.requiredCompletionDate}>
              <input id="trf-due" type="date" disabled={!canEditA} value={form.requiredCompletionDate}
                onChange={(e) => set('requiredCompletionDate', e.target.value)} />
            </Field>

            <Field htmlFor="trf-qty" label="Sample Quantity" lockOwner={partALock}>
              <input id="trf-qty" disabled={!canEditA} value={form.sampleQuantity} placeholder="e.g. 2 kg"
                onChange={(e) => set('sampleQuantity', e.target.value)} />
            </Field>

            <EmployeeSelect
              id="trf-sample-submitted-by"
              label="Sample Submitted By"
              value={form.sampleSubmittedById}
              options={employees}
              disabled={!canEditA}
              lockOwner={partALock}
              fieldError={fields.sampleSubmittedById}
              onChange={(v) => set('sampleSubmittedById', v)}
              placeholder="Search an employee…"
              emptyMessage="No employees are available to pick."
              selectedOption={sampleSubmittedByName
                ? { id: Number(form.sampleSubmittedById) || -1, employeeCode: '', fullName: sampleSubmittedByName, designation: null, departmentName: null }
                : null}
            />

            <Field htmlFor="trf-remarks-status" label="Status" lockOwner={partALock}>
              <select id="trf-remarks-status" disabled={!canEditA} value={form.remarksStatus}
                onChange={(e) => set('remarksStatus', e.target.value as RemarksStatus)}>
                {REMARKS_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <p className="field-hint">Current state: <RemarksStatusBadge status={form.remarksStatus} /></p>
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

          {/* Formulation Approval Gate banner */}
          {isEdit && trfData && trfData.remarksStatus !== 'Approved' && (
            <div className="approval-banner approval-banner--waiting" role="alert">
              <span className="approval-banner__icon" aria-hidden="true">🔒</span>
              <span className="approval-banner__text">Waiting for Formulation approval</span>
            </div>
          )}

          {/* Part A locked after approval banner */}
          {isEdit && trfData && trfData.remarksStatus === 'Approved' && (
            <div className="approval-banner approval-banner--locked" role="alert">
              <span className="approval-banner__icon" aria-hidden="true">🔒</span>
              <span className="approval-banner__text">Approved by Formulation: Part A is locked</span>
            </div>
          )}

          <div className="grid">
            <Field htmlFor="trf-ard-number" label="A.R. No." lockOwner="System">
              <input id="trf-ard-number" value={ardNumber} readOnly disabled placeholder="Assigned when the TRF is created" />
            </Field>

            <StageSelect
              id="trf-ard-stage"
              value={form.stage}
              options={stageNames}
              disabled={!canEditB}
              fieldError={fields.stage}
              onChange={(name) => set('stage', name)}
              onCreated={(name) => set('stage', name)}
            />

            <Field htmlFor="trf-ard-test-requested" label="Test Requested" lockOwner="System">
              <textarea id="trf-ard-test-requested" rows={2} value={form.requestedAnalysis} readOnly disabled />
              <p className="field-hint">Carried forward from the Formulation request.</p>
            </Field>

            <Field htmlFor="trf-ard-test-details" label="Test Details" lockOwner="System">
              <textarea id="trf-ard-test-details" rows={2} value={form.specialInstructions} readOnly disabled />
              <p className="field-hint">Carried forward from the Formulation request.</p>
            </Field>

            <EmployeeSelect
              id="trf-ard-analyst"
              label="Analyst Name"
              value={form.ardAnalystId}
              options={employees}
              disabled={!canEditB}
              lockOwner={ardLock}
              fieldError={fields.ardAnalystId}
              onChange={(v) => set('ardAnalystId', v)}
              placeholder="Search an analyst…"
              emptyMessage="No employees are available to pick."
            />

            <Field htmlFor="trf-analysis-start" label="Date of Analysis" lockOwner={ardLock} error={fields.analysisStartDate}>
              <input id="trf-analysis-start" type="date" disabled={!canEditB} value={form.analysisStartDate}
                onChange={(e) => set('analysisStartDate', e.target.value)} />
            </Field>

            <Field htmlFor="trf-reporting" label="Reporting" lockOwner={ardLock}>
              <select id="trf-reporting" disabled={!canEditB} value={form.reportingStatus}
                onChange={(e) => set('reportingStatus', e.target.value as ArdReportingStatus)}>
                {ARD_REPORTING_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>

            <Field htmlFor="trf-coa" label="COA" lockOwner={ardLock}>
              <select id="trf-coa" disabled={!canEditB} value={form.coaStatus}
                onChange={(e) => set('coaStatus', e.target.value as ArdCoaStatus)}>
                {ARD_COA_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>

            <Field htmlFor="trf-ard-remarks-status" label="Status" lockOwner={ardLock}>
              <select id="trf-ard-remarks-status" disabled={!canEditB} value={form.ardRemarksStatus}
                onChange={(e) => set('ardRemarksStatus', e.target.value as ArdRemarksStatus)}>
                {ARD_REMARKS_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <p className="field-hint">Current state: <ArdRemarksStatusBadge status={form.ardRemarksStatus} /></p>
            </Field>

            <Field htmlFor="trf-ard-remarks" label="ARD Remark" lockOwner={ardLock} error={fields.ardRemarks}>
              <textarea id="trf-ard-remarks" rows={2} disabled={!canEditB} value={form.ardRemarks}
                onChange={(e) => set('ardRemarks', e.target.value)} />
            </Field>

            <Field htmlFor="trf-ard-tat" label="TAT" lockOwner="System">
              <input id="trf-ard-tat" value={tat === null ? '' : String(tat)} readOnly disabled placeholder="Calculated automatically" />
            </Field>

            <Field htmlFor="trf-ard-final-status" label="Final Status" lockOwner={ardLock}>
              <select id="trf-ard-final-status" disabled={!canEditB} value={form.workflowStatus}
                onChange={(e) => set('workflowStatus', e.target.value as ArdWorkflowStatus)}>
                {(['Received', 'In Progress', 'Completed', 'Cancelled'] as ArdWorkflowStatus[]).map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <p className="field-hint">Current state: <ArdFinalStatusBadge status={form.workflowStatus} /></p>
            </Field>

            <Field htmlFor="trf-sample-received-date" label="Sample Received Date" lockOwner={partALock} error={fields.sampleReceivedDate}>
              <input id="trf-sample-received-date" type="date" disabled={!canEditA} value={form.sampleReceivedDate}
                onChange={(e) => set('sampleReceivedDate', e.target.value)} />
            </Field>
          </div>

          <div className="card__foot">
            <FinalStatusStepper current={form.workflowStatus} />
          </div>
        </section>

        <div className="save-bar">
          <div className="row">
            <button className="btn btn--primary" type="submit" disabled={busy || (!canEditA && !canEditB)}>
              {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create TRF'}
            </button>
            {isEdit && <span className="muted">Version {version}</span>}
            {!canEditA && !canEditB && <span className="muted">You have read-only access to this TRF.</span>}
            {can('trf.changeStatus') && <span className="muted">The TRF status is changed on the TRF page.</span>}
          </div>
        </div>
      </form>
    </div>
  );
}
