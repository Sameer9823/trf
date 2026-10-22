import { FormEvent, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Customer, Department, Priority, Product, TrfDetail, EmployeeProfile, RemarksStatus, ArdRemarksStatus } from '@trf/shared';
import { PRIORITIES, REMARKS_STATUSES, ARD_REMARKS_STATUSES, canEditTrfPartA, canEditTrfPartB } from '@trf/shared';
import { MESSAGES } from '@trf/shared';
import { fieldsOf, messageOf } from '../lib/api';
import { useAuth } from '../lib/auth';
import { RemarksStatusBadge, ArdRemarksStatusBadge } from '../components/Badges';

interface FormState {
  trfDate: string;
  customerId: string;
  productId: string;
  batchNumber: string;
  sampleQuantity: string;
  sampleReceivedDate: string;
  requiredCompletionDate: string;
  priority: Priority;
  requestedAnalysis: string;
  specialInstructions: string;
  departmentId: string;
  remarks: string;
  remarksStatus: RemarksStatus;
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
  analysisPurpose: string;
   sampleGivenBy: string;
   signatureDate: string;
   sampleReceivedBy: string;
   ardAnalystId: string;
  analysisStartDate: string;
  reportingStatus: string;
  coaStatus: string;
  ardRemarks: string;
  ardRemarksStatus: ArdRemarksStatus;
}

const blank = (today: string): FormState => ({
  trfDate: today,
  customerId: '', productId: '', batchNumber: '', sampleQuantity: '',
  sampleReceivedDate: '', requiredCompletionDate: '', priority: 'Normal',
  requestedAnalysis: '', specialInstructions: '', departmentId: '', remarks: '',
  remarksStatus: 'Pending',
  batchSize: '', dosageForm: '', manufacturingLocation: '',
  labelClaim: '', packSize: '', packType: '', storageCondition: '',
  storagePeriod: '', manufacturingDate: '', expiryDate: '',
   analysisPurpose: '', sampleGivenBy: '', signatureDate: '',
   sampleReceivedBy: '',
   ardAnalystId: '', analysisStartDate: '', reportingStatus: 'Pending',
  coaStatus: 'Pending', ardRemarks: '', ardRemarksStatus: 'Pending',
});

const today = () => new Date().toISOString().slice(0, 10);

/** The lookup routes are plural on the server; the kind here is singular. */
const LOOKUP_PATH: Record<'customer' | 'product', string> = {
  customer: '/api/lookups/customers',
  product: '/api/lookups/products',
};

const LOOKUP_LABEL: Record<'customer' | 'product', string> = {
  customer: 'Customer',
  product: 'Product',
};

/** Sentinel option value for "Other (type new)" in the dropdowns. */
const OTHER_OPTION = '__other__';

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

  async function submit(e: FormEvent) {
    e.preventDefault();
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

  if (!open) {
    return (
      <button type="button" className="btn btn--ghost" onClick={() => onOpenChange(true)}>
        + New {kind}
      </button>
    );
  }

  return (
    <form className="inline-new" onSubmit={submit}>
      <div className="inline-new__row">
        <input placeholder={`${LOOKUP_LABEL[kind]} name`} value={name}
          onChange={(e) => setName(e.target.value)} aria-label={`${kind} name`} />
        <input placeholder="Code (optional)" value={code} onChange={(e) => setCode(e.target.value)}
          aria-label={`${kind} code`} />
        <button className="btn btn--primary" type="submit" disabled={busy}>Add</button>
        <button className="btn" type="button" onClick={() => onOpenChange(false)}>Cancel</button>
      </div>
      {error && <p className="field-error">{error}{fields.name ? ` ${fields.name}` : ''}</p>}
    </form>
  );
}

/**
 * A lookup dropdown with a quick-add beside it. "Other (type new)" is the last
 * option and opens the same quick-add form the button opens, so a record that
 * is not in the list yet can be typed in without leaving the form.
 */
export function LookupSelect({ kind, items, value, fieldError, onChange, onCreated }: {
  kind: 'customer' | 'product';
  items: { id: number; name: string }[];
  value: string;
  fieldError?: string;
  onChange: (value: string) => void;
  onCreated: (created: { id: number; name: string }) => void;
}) {
  const [adding, setAdding] = useState(false);
  const label = LOOKUP_LABEL[kind];
  const selectId = `trf-${kind}`;

  return (
    <div>
      <label htmlFor={selectId}>{label} <span className="required-mark">*</span></label>
      {items.length === 0 ? (
        <p className="muted">No {label.toLowerCase()}s yet. Add the first one below.</p>
      ) : (
        <select
          id={selectId}
          required
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

export function TrfForm() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const { employee, can } = useAuth();
  const canEditA = employee ? canEditTrfPartA(employee) : false;
  const canEditB = employee ? canEditTrfPartB(employee) : false;

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [analysts, setAnalysts] = useState<EmployeeProfile[]>([]);
  const [form, setForm] = useState<FormState>(() => blank(today()));
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

  const loadLookups = () => {
    reloadCustomers();
    reloadProducts();
    void window.trf.request<{ items: EmployeeProfile[] }>({ method: 'GET', path: '/api/employees/assignable' })
      .then((r) => { if (r.ok && r.data) setAnalysts(r.data.items); });
  };

  useEffect(() => { loadLookups(); }, []);

  useEffect(() => {
    if (!isEdit) {
      setForm((f) => ({ ...f, departmentId: employee?.departmentId ? String(employee.departmentId) : '' }));
      return;
    }
    let cancelled = false;
    void window.trf.request<TrfDetail>({ method: 'GET', path: `/api/trfs/${id}` }).then((res) => {
      if (cancelled) return;
      setLoading(false);
      if (!res.ok || !res.data) { setError(messageOf(res.data, 'This TRF could not be loaded.')); return; }
      const trf = res.data;
      setVersion(trf.version);
      setForm({
        trfDate: trf.trfDate,
        customerId: trf.customerId ? String(trf.customerId) : '',
        productId: trf.productId ? String(trf.productId) : '',
        batchNumber: trf.batchNumber ?? '',
        sampleQuantity: trf.sampleQuantity ?? '',
        sampleReceivedDate: trf.sampleReceivedDate ?? '',
        requiredCompletionDate: trf.requiredCompletionDate ?? '',
        priority: trf.priority,
        requestedAnalysis: trf.requestedAnalysis ?? '',
        specialInstructions: trf.specialInstructions ?? '',
        departmentId: trf.departmentId ? String(trf.departmentId) : '',
        remarks: trf.remarks ?? '',
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
         analysisPurpose: trf.analysisPurpose ?? '',
         sampleGivenBy: trf.sampleGivenBy ?? '',
         signatureDate: trf.signatureDate ?? '',
         remarksStatus: trf.remarksStatus ?? 'Pending',
         sampleReceivedBy: trf.sampleReceivedBy ? String(trf.sampleReceivedBy) : '',
         ardAnalystId: trf.ardAnalystId ? String(trf.ardAnalystId) : '',
        analysisStartDate: trf.analysisStartDate ?? '',
        reportingStatus: trf.reportingStatus,
        coaStatus: trf.coaStatus,
        ardRemarks: trf.ardRemarks ?? '',
        ardRemarksStatus: trf.ardRemarksStatus ?? 'Pending',
      });
    });
    return () => { cancelled = true; };
  }, [id, isEdit, employee?.departmentId]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

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
      sampleQuantity: form.sampleQuantity.trim() || null,
      sampleReceivedDate: form.sampleReceivedDate || null,
      requiredCompletionDate: form.requiredCompletionDate || null,
      priority: form.priority,
      requestedAnalysis: form.requestedAnalysis.trim() || null,
      specialInstructions: form.specialInstructions.trim() || null,
      departmentId: form.departmentId ? Number(form.departmentId) : null,
      remarks: form.remarks.trim() || null,
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
      analysisPurpose: form.analysisPurpose.trim() || null,
       sampleGivenBy: form.sampleGivenBy.trim() || null,
       signatureDate: form.signatureDate || null,
       remarksStatus: form.remarksStatus,
       sampleReceivedBy: form.sampleReceivedBy ? Number(form.sampleReceivedBy) : null,
     };

    // ARD Part B fields are only sent when the user has ARD edit access.
    if (canEditB) {
      body.ardAnalystId = form.ardAnalystId ? Number(form.ardAnalystId) : null;
      body.analysisStartDate = form.analysisStartDate || null;
      body.reportingStatus = form.reportingStatus;
      body.coaStatus = form.coaStatus;
      body.ardRemarks = form.ardRemarks.trim() || null;
      body.ardRemarksStatus = form.ardRemarksStatus;
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

  return (
    <div className="page">
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

      <form className="form form--wide" onSubmit={submit}>
        <h2>Sample</h2>
        <label htmlFor="trf-date">TRF date</label>
        <input id="trf-date" type="date" required value={form.trfDate} onChange={(e) => set('trfDate', e.target.value)} />
        {fields.trfDate && <p className="field-error">{fields.trfDate}</p>}

        <div className="field-pair">
          <LookupSelect
            kind="customer"
            items={customers}
            value={form.customerId}
            fieldError={fields.customerId}
            onChange={(v) => set('customerId', v)}
            onCreated={({ id }) => reloadCustomers(id)}
          />
          <LookupSelect
            kind="product"
            items={products}
            value={form.productId}
            fieldError={fields.productId}
            onChange={(v) => set('productId', v)}
            onCreated={({ id }) => reloadProducts(id)}
          />
        </div>

        <div className="field-pair">
          <div>
            <label htmlFor="trf-batch">Batch number</label>
            <input id="trf-batch" value={form.batchNumber} onChange={(e) => set('batchNumber', e.target.value)} />
          </div>
          <div>
            <label htmlFor="trf-qty">Sample quantity</label>
            <input id="trf-qty" value={form.sampleQuantity} onChange={(e) => set('sampleQuantity', e.target.value)} placeholder="e.g. 2 kg" />
          </div>
        </div>

        <div className="field-pair">
          <div>
            <label htmlFor="trf-due">Required completion date</label>
            <input id="trf-due" type="date" value={form.requiredCompletionDate}
              onChange={(e) => set('requiredCompletionDate', e.target.value)} />
            {fields.requiredCompletionDate && <p className="field-error">{fields.requiredCompletionDate}</p>}
          </div>
          <div />
        </div>

        <label htmlFor="trf-requested">Requested analysis</label>
        <textarea id="trf-requested" rows={3} value={form.requestedAnalysis}
          onChange={(e) => set('requestedAnalysis', e.target.value)} />

        <label htmlFor="trf-special">Special instructions</label>
        <textarea id="trf-special" rows={2} value={form.specialInstructions}
          onChange={(e) => set('specialInstructions', e.target.value)} />

        <h2>Product Details</h2>
        <div className="field-pair">
          <div>
            <label htmlFor="trf-batch-size">Batch size</label>
            <input id="trf-batch-size" value={form.batchSize} onChange={(e) => set('batchSize', e.target.value)} />
          </div>
          <div>
            <label htmlFor="trf-dosage">Dosage form</label>
            <input id="trf-dosage" value={form.dosageForm} onChange={(e) => set('dosageForm', e.target.value)} />
          </div>
        </div>

        <div className="field-pair">
          <div>
            <label htmlFor="trf-location">Manufacturing location</label>
            <input id="trf-location" value={form.manufacturingLocation} onChange={(e) => set('manufacturingLocation', e.target.value)} />
          </div>
          <div>
            <label htmlFor="trf-label-claim">Label claim</label>
            <input id="trf-label-claim" value={form.labelClaim} onChange={(e) => set('labelClaim', e.target.value)} />
          </div>
        </div>

        <div className="field-pair">
          <div>
            <label htmlFor="trf-pack-size">Pack size</label>
            <input id="trf-pack-size" value={form.packSize} onChange={(e) => set('packSize', e.target.value)} />
          </div>
          <div>
            <label htmlFor="trf-pack-type">Pack type</label>
            <input id="trf-pack-type" value={form.packType} onChange={(e) => set('packType', e.target.value)} />
          </div>
        </div>

        <div className="field-pair">
          <div>
            <label htmlFor="trf-storage-condition">Storage condition</label>
            <input id="trf-storage-condition" value={form.storageCondition} onChange={(e) => set('storageCondition', e.target.value)} />
          </div>
          <div>
            <label htmlFor="trf-storage-period">Storage period</label>
            <input id="trf-storage-period" value={form.storagePeriod} onChange={(e) => set('storagePeriod', e.target.value)} />
          </div>
        </div>

        <div className="field-pair">
          <div>
            <label htmlFor="trf-mfg-date">Manufacturing date</label>
            <input id="trf-mfg-date" type="date" value={form.manufacturingDate}
              onChange={(e) => set('manufacturingDate', e.target.value)} />
            {fields.manufacturingDate && <p className="field-error">{fields.manufacturingDate}</p>}
          </div>
          <div>
            <label htmlFor="trf-expiry-date">Expiry date</label>
            <input id="trf-expiry-date" type="date" value={form.expiryDate}
              onChange={(e) => set('expiryDate', e.target.value)} />
            {fields.expiryDate && <p className="field-error">{fields.expiryDate}</p>}
          </div>
        </div>

        <h2>Analysis Details</h2>
        <div className="field-pair">
          <div>
            <label htmlFor="trf-analysis-purpose">Analysis purpose</label>
            <input id="trf-analysis-purpose" value={form.analysisPurpose} onChange={(e) => set('analysisPurpose', e.target.value)} />
          </div>
          <div>
            <label htmlFor="trf-sample-given-by">Sample submitted by</label>
            <input id="trf-sample-given-by" value={form.sampleGivenBy} onChange={(e) => set('sampleGivenBy', e.target.value)} />
          </div>
          <div>
            <label htmlFor="trf-sample-received-by">Sample received by</label>
            <select id="trf-sample-received-by" value={form.sampleReceivedBy}
              onChange={(e) => set('sampleReceivedBy', e.target.value)}>
              <option value="">Not set</option>
              {analysts.map((a) => <option key={a.id} value={a.id}>{a.fullName}</option>)}
            </select>
          </div>
        </div>
        <div className="field-pair">
          <div>
            <label htmlFor="trf-signature-date">Signature date</label>
            <input id="trf-signature-date" type="date" value={form.signatureDate}
              onChange={(e) => set('signatureDate', e.target.value)} />
          </div>
          <div />
        </div>

        <div className="field-pair">
          <div>
            <label htmlFor="trf-remarks-status">Remarks status</label>
            <select
              id="trf-remarks-status"
              value={form.remarksStatus}
              disabled={!canEditA}
              onChange={(e) => set('remarksStatus', e.target.value as RemarksStatus)}
            >
              {REMARKS_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <p className="field-hint">Current state: <RemarksStatusBadge status={form.remarksStatus} /></p>
            {!canEditA && <p className="muted">Only Formulation department users can change this.</p>}
          </div>
          <div />
        </div>

        <label htmlFor="trf-remarks">Remarks</label>
        <textarea id="trf-remarks" rows={2} value={form.remarks} onChange={(e) => set('remarks', e.target.value)} />
        {form.remarksStatus === 'Rejected' && !form.remarks.trim() && (
          <p className="field-error">A rejected remark needs a note explaining why.</p>
        )}
        {fields.remarks && <p className="field-error">{fields.remarks}</p>}

        {canEditB && (
          <>
            <h2>ARD Analysis Details</h2>
            <div className="field-pair">
              <div>
                <label htmlFor="trf-ard-analyst">ARD Analyst</label>
                <select id="trf-ard-analyst" value={form.ardAnalystId} onChange={(e) => set('ardAnalystId', e.target.value)}>
                  <option value="">Not assigned</option>
                  {analysts.map((a) => <option key={a.id} value={a.id}>{a.fullName}{a.departmentName ? ` (${a.departmentName})` : ''}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="trf-analysis-start">Analysis start date</label>
                <input id="trf-analysis-start" type="date" value={form.analysisStartDate}
                  onChange={(e) => set('analysisStartDate', e.target.value)} />
              </div>
            </div>

            <div className="field-pair">
              <div>
                <label>Reporting status</label>
                <select value={form.reportingStatus} onChange={(e) => set('reportingStatus', e.target.value)}>
                  <option value="Pending">Pending</option>
                  <option value="Draft">Draft</option>
                  <option value="Submitted">Submitted</option>
                  <option value="Reviewed">Reviewed</option>
                  <option value="Approved">Approved</option>
                </select>
              </div>
              <div>
                <label>COA status</label>
                <select value={form.coaStatus} onChange={(e) => set('coaStatus', e.target.value)}>
                  <option value="Pending">Pending</option>
                  <option value="Draft">Draft</option>
                  <option value="Under Review">Under Review</option>
                  <option value="Approved">Approved</option>
                  <option value="Issued">Issued</option>
                </select>
              </div>
            </div>

            <label htmlFor="trf-ard-remarks">ARD remarks</label>
            <textarea id="trf-ard-remarks" rows={2} value={form.ardRemarks} onChange={(e) => set('ardRemarks', e.target.value)} />

            <div className="field-pair">
              <div>
                <label htmlFor="trf-ard-remarks-status">ARD remarks status</label>
                <select id="trf-ard-remarks-status" value={form.ardRemarksStatus}
                  onChange={(e) => set('ardRemarksStatus', e.target.value as ArdRemarksStatus)}>
                  {ARD_REMARKS_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <p className="field-hint">Current state: <ArdRemarksStatusBadge status={form.ardRemarksStatus} /></p>
              </div>
              <div />
            </div>
          </>
        )}

        <div className="row">
          <button className="btn btn--primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create TRF'}
          </button>
          {isEdit && <span className="muted">Version {version}</span>}
        </div>
      </form>
    </div>
  );
}
