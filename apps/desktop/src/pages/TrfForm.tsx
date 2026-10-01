import { FormEvent, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Customer, Department, Priority, Product, TrfDetail } from '@trf/shared';
import { PRIORITIES } from '@trf/shared';
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
}

const blank = (today: string): FormState => ({
  trfDate: today,
  customerId: '', productId: '', batchNumber: '', sampleQuantity: '',
  sampleReceivedDate: '', requiredCompletionDate: '', priority: 'Normal',
  requestedAnalysis: '', specialInstructions: '', departmentId: '', remarks: '',
});

const today = () => new Date().toISOString().slice(0, 10);

/** Customers and products can be created inline from this form, without leaving it. */
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

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
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
    void window.trf.request<{ items: Department[] }>({ method: 'GET', path: '/api/departments' })
      .then((r) => { if (r.ok && r.data) setDepartments(r.data.items); });
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
    };

    const res = isEdit
      ? await window.trf.request<TrfDetail>({
        method: 'PATCH', path: `/api/trfs/${id}`, body: { ...body, version },
      })
      : await window.trf.request<TrfDetail>({ method: 'POST', path: '/api/trfs', body });
    setBusy(false);

    if (!res.ok || !res.data) {
      setFields(fieldsOf(res.data));
      const message = messageOf(res.data, isEdit ? 'The TRF could not be saved.' : 'The TRF could not be created.');
      setError(message);
      // A lost-update race: offer a reload instead of overwriting silently.
      if (message === MESSAGES.CONFLICT) return;
      return;
    }
    navigate(`/trfs/${res.data.id}`, { replace: true });
  }

  if (loading) return <div className="page"><p className="muted">Loading…</p></div>;
  if (!isEdit && !can('trf.create')) return <div className="page"><p className="error-text">{MESSAGES.NO_PERMISSION}</p></div>;

  return (
    <div className="page">
      <div className="page__head">
        <h1>{isEdit ? 'Edit TRF' : 'New TRF'}</h1>
        <a className="btn" href={isEdit ? `#/trfs/${id}` : '#/trf'}>Cancel</a>
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
            <label htmlFor="trf-received">Sample received date</label>
            <input id="trf-received" type="date" value={form.sampleReceivedDate}
              onChange={(e) => set('sampleReceivedDate', e.target.value)} />
            {fields.sampleReceivedDate && <p className="field-error">{fields.sampleReceivedDate}</p>}
          </div>
          <div>
            <label htmlFor="trf-due">Required completion date</label>
            <input id="trf-due" type="date" value={form.requiredCompletionDate}
              onChange={(e) => set('requiredCompletionDate', e.target.value)} />
          </div>
        </div>

        <div className="field-pair">
          <div>
            <label htmlFor="trf-priority">Priority</label>
            <select id="trf-priority" value={form.priority} onChange={(e) => set('priority', e.target.value as Priority)}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="trf-dept">Department</label>
            <select id="trf-dept" value={form.departmentId} onChange={(e) => set('departmentId', e.target.value)}>
              <option value="">Not set</option>
              {departments.filter((d) => d.isActive).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
        </div>

        <label htmlFor="trf-requested">Requested analysis</label>
        <textarea id="trf-requested" rows={3} value={form.requestedAnalysis}
          onChange={(e) => set('requestedAnalysis', e.target.value)} />

        <label htmlFor="trf-special">Special instructions</label>
        <textarea id="trf-special" rows={2} value={form.specialInstructions}
          onChange={(e) => set('specialInstructions', e.target.value)} />

        <label htmlFor="trf-remarks">Remarks</label>
        <textarea id="trf-remarks" rows={2} value={form.remarks} onChange={(e) => set('remarks', e.target.value)} />

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
