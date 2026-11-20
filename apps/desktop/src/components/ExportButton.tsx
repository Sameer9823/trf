import { exportSummary, useExportButton } from '../lib/export';
import type { ExportSheetName } from '@trf/shared';

/**
 * Export sits beside the list it exports. The filters handed in are whatever the
 * list is currently showing, so the file matches the screen without the employee
 * having to set them twice. The role's absence of permission hides the button,
 * but the server refuses regardless.
 */
export function ExportButton({
  filters, sheet, label = 'Export',
}: {
  filters: Record<string, string | number | boolean | undefined>;
  sheet?: ExportSheetName;
  label?: string;
}) {
  const { state, start, clear, busy } = useExportButton();
  const summary = exportSummary(state);

  return (
    <span className="export">
      <button
        className="btn"
        disabled={busy}
        onClick={() => void start(filters)}
        title={busy ? 'Preparing the workbook…' : `Save the current ${label.toLowerCase()} as an Excel file`}
      >
        {busy ? 'Exporting…' : label}
      </button>
      {summary && (
        <span className={`export__note ${state.status === 'failed' ? 'export__note--error' : ''}`} role="status">
          {summary}
          <button className="btn btn--ghost btn--tiny" onClick={clear} aria-label="Dismiss">×</button>
        </span>
      )}
    </span>
  );
}