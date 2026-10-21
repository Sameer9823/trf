import { FormEvent, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Customer, Department, Priority, Product, TrfDetail, EmployeeProfile } from '@trf/shared';
import { PRIORITIES, canEditTrfPartA, canEditTrfPartB } from '@trf/shared';
import { MESSAGES } from '@trf/shared';
import { fieldsOf, messageOf } from '../lib/api';
import { useAuth } from '../lib/auth';

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
  ardAnalystId: string;
  analysisStartDate: string;
  reportingStatus: string;
  coaStatus: string;
  ardRemarks: string;
}

const blank = (today: string): FormState => ({
  trfDate: today,
  customerId: '', productId: '', batchNumber: '', sampleQuantity: '',
  sampleReceivedDate: '', requiredCompletionDate: '', priority: 'Normal',
  requestedAnalysis: '', specialInstructions: '', departmentId: '', remarks: '',
  batchSize: '', dosageForm: '', manufacturingLocation: '',
  labelClaim: '', packSize: '', packType: '', storageCondition: '',
  storagePeriod: '', manufacturingDate: '', expiryDate: '',
  analysisPurpose: '', sampleGivenBy: '', signatureDate: '',
  ardAnalystId: '', analysisStartDate: '', reportingStatus: 'Pending',
  coaStatus: 'Pending', ardRemarks: '',
});

const today = () => new Date().toISOString().slice(0, 10);

function InlineNew({ kind, onCreated }: { kind: 'customer' | 'product'; onCreated: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const { can } = useAuth();

  if (!can('employees.manage')) return null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await window.trf.request<{ id: number; name: string }>({
      method: 'POST', path: `/api/lookups/${kind}`, body: { name: name.trim(), code: code.trim() || null },
    });
    setBusy(false);
    if (!res.ok || !res.data) {
      setFields(fieldsOf(res.data));
      setError(messageOf(res.data, `${kind === 'customer' ? 'Customer' : 'Product'} could not be created.`));
      return;
    }
    onCreated(res.data.name);
    setOpen(false);
    setName('');
    setCode('');
  }

  if (!open) {
    return (
      <button type="button" className="btn btn--ghost" onClick={() => setOpen(true)}>
        + New {kind}
      </button>
    );
  }

  return (
    <form className="inline-new" onSubmit={submit}>
      <div className="inline-new__row">
        <input placeholder={`${kind === 'customer' ? 'Customer' : 'Product'} name`} value={name}
          onChange={(e) => setName(e.target.value)} aria-label={`${kind} name`} />
        <input placeholder="Code (optional)" value={code} onChange={(e) => setCode(e.target.value)}
          aria-label={`${kind} code`} />
        <button className="btn btn--primary" type="submit" disabled={busy}>Add</button>
        <button className="btn" type="button" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {error && <p className="field-error">{error}{fields.name ? ` ${fields.name}` : ''}</p>}
    </form>
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

  const reloadCustomers = () => {
    void window.trf.request<{ items: Customer[] }>({ method: 'GET', path: '/api/lookups/customers' })
      .then((r) => { if (r.ok && r.data) setCustomers(r.data.items); });
  };
  const reloadProducts = () => {
    void window.trf.request<{ items: Product[] }>({ method: 'GET', path: '/api/lookups/products' })
      .then((r) => { if (r.ok && r.data) setProducts(r.data.items); });
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
        ardAnalystId: trf.ardAnalystId ? String(trf.ardAnalystId) : '',
        analysisStartDate: trf.analysisStartDate ?? '',
        reportingStatus: trf.reportingStatus,
        coaStatus: trf.coaStatus,
        ardRemarks: trf.ardRemarks ?? '',
      });
    });
    return () => { cancelled = true; };
  }, [id, isEdit, employee?.departmentId]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
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
    };

    // ARD Part B fields are only sent when the user has ARD edit access.
    if (canEditB) {
      body.ardAnalystId = form.ardAnalystId ? Number(form.ardAnalystId) : null;
      body.analysisStartDate = form.analysisStartDate || null;
      body.reportingStatus = form.reportingStatus;
      body.coaStatus = form.coaStatus;
      body.ardRemarks = form.ardRemarks.trim() || null;
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
  if (!isEdit && !can('trf.create')) return <div className="page"><p className="error-text">{MESSAGES.NO_PERMISSION}</p></div>;
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
          <div>
            <label htmlFor="trf-customer">Customer</label>
            <select id="trf-customer" value={form.customerId} onChange={(e) => set('customerId', e.target.value)}>
              <option value="">Not set</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <InlineNew kind="customer" onCreated={() => reloadCustomers()} />
          </div>
          <div>
            <label htmlFor="trf-product">Product</label>
            <select id="trf-product" value={form.productId} onChange={(e) => set('productId', e.target.value)}>
              <option value="">Not set</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <InlineNew kind="product" onCreated={() => reloadProducts()} />
          </div>
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
            <label htmlFor="trf-sample-given-by">Sample given by</label>
            <input id="trf-sample-given-by" value={form.sampleGivenBy} onChange={(e) => set('sampleGivenBy', e.target.value)} />
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

        <label htmlFor="trf-remarks">Remarks</label>
        <textarea id="trf-remarks" rows={2} value={form.remarks} onChange={(e) => set('remarks', e.target.value)} />

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
