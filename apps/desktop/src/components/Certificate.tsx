import type { Coa, CoaLine } from '@trf/shared';

const OUTCOME_LABEL: Record<CoaLine['outcome'], string> = {
  Pass: 'Pass',
  Fail: 'Fail',
  'Not Specified': 'Not Specified',
  'Not Tested': 'Not Tested',
};

const date = (value: string | null): string => {
  if (!value) return '—';
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleDateString('en-GB');
};

const stamp = (value: string | null): string => {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleDateString('en-GB');
};

/**
 * The certificate as it appears on paper. Everything that is not part of the
 * printed record is left out, so a draft and an issued certificate print the
 * same way and cannot be confused afterwards.
 */
export function Certificate({ coa }: { coa: Coa }) {
  return (
    <article className="certificate" aria-label="Certificate of Analysis">
      <header className="certificate__head">
        <div>
          <h1>Certificate of Analysis</h1>
          <p className="certificate__company">Company name and laboratory details</p>
        </div>
        <div className="certificate__number">
          <span className="muted">Certificate No.</span>
          <strong>{coa.coaNumber ?? 'Not yet issued'}</strong>
        </div>
      </header>

      <section className="certificate__grid">
        <Field label="TRF No." value={coa.trfNumber} />
        <Field label="TRF date" value={date(coa.trfDate)} />
        <Field label="Sample received" value={date(coa.trfDate)} />
        <Field label="Required completion" value={date(coa.requiredCompletionDate)} />
        <Field label="Customer" value={coa.customerName} />
        <Field label="Customer address" value={coa.customerAddress} wide />
        <Field label="Product" value={coa.productName} />
        <Field label="Batch No." value={coa.batchNumber} />
        <Field label="Sample quantity" value={coa.sampleQuantity} />
        <Field label="Priority" value={coa.priority} />
        <Field label="Requested analysis" value={coa.requestedAnalysis} wide />
      </section>

      <table className="certificate__table">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Test</th>
            <th scope="col">Method</th>
            <th scope="col">Specification</th>
            <th scope="col">Result</th>
            <th scope="col">Unit</th>
            <th scope="col">Limits</th>
            <th scope="col">Outcome</th>
          </tr>
        </thead>
        <tbody>
          {coa.lines.length === 0 && (
            <tr><td colSpan={8} className="muted">No results have been copied onto this certificate yet.</td></tr>
          )}
          {coa.lines.map((line, index) => (
            <tr key={line.id} className={line.outcome === 'Fail' ? 'certificate__row--fail' : undefined}>
              <td>{index + 1}</td>
              <td>{line.testName}</td>
              <td>{line.testMethod ?? '—'}</td>
              <td>{line.specification ?? '—'}</td>
              <td className="certificate__result">{result(line)}</td>
              <td>{line.unit ?? '—'}</td>
              <td>{limits(line)}</td>
              <td>{OUTCOME_LABEL[line.outcome]}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {coa.remarks && (
        <section className="certificate__remarks">
          <h2>Remarks</h2>
          <p>{coa.remarks}</p>
        </section>
      )}

      <section className="certificate__sign">
        <Sign label="Prepared by" name={coa.preparedBy.name} at={coa.preparedBy.at} />
        <Sign label="Reviewed by" name={coa.reviewedBy.name} at={coa.reviewedBy.at} />
        <Sign label="Approved by" name={coa.approvedBy.name} at={coa.approvedBy.at} />
        <Sign label="Issued by" name={coa.issuedBy.name} at={coa.issuedBy.at} />
      </section>

      <footer className="certificate__foot">
        <span>
          {coa.counts.total} test(s): {coa.counts.passed} passed, {coa.counts.failed} failed.
          This certificate refers only to the sample named above.
        </span>
      </footer>
    </article>
  );
}

function Field({ label, value, wide }: { label: string; value: string | null; wide?: boolean }) {
  return (
    <div className={wide ? 'certificate__field certificate__field--wide' : 'certificate__field'}>
      <span className="certificate__label">{label}</span>
      <span className="certificate__value">{value || '—'}</span>
    </div>
  );
}

function Sign({ label, name, at }: { label: string; name: string | null; at: string | null }) {
  return (
    <div className="certificate__signature">
      <span className="certificate__label">{label}</span>
      <span className="certificate__signline">{name || 'Pending'}</span>
      <span className="certificate__label">{at ? stamp(at) : 'Not yet signed'}</span>
    </div>
  );
}

/** A numeric result keeps its digits; a qualitative one keeps its text. */
function result(line: CoaLine): string {
  if (line.resultValue !== null) return line.resultValue;
  if (line.resultText !== null) return line.resultText;
  return '—';
}

function limits(line: CoaLine): string {
  if (line.lowerLimit === null && line.upperLimit === null) return '—';
  if (line.upperLimit === null) return `≥ ${line.lowerLimit}`;
  if (line.lowerLimit === null) return `≤ ${line.upperLimit}`;
  return `${line.lowerLimit} – ${line.upperLimit}`;
}