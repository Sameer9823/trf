# Printing and PDF export of the TRF

The printed TRF is the company's controlled TEST REQUEST FORM (SOP QAQN-003:F1), laid out as on the paper form, with the
product's **Generic Name** added under the product name.

- **When:** only for a TRF that is approved and locked. Before that the Print and Save as PDF buttons are disabled.
- **Where:** `Print / Save as PDF` on the TRF page and the print icon in the TRF list open the form page (`#/trfs/:id/print`).
  Print opens the system print dialog; Save as PDF asks where to save an A4 PDF named `TRF-<number>.pdf`.
- **What it shows:** header (logo, company, SOP number, revision, MASTER, effective date, issued by), product and generic name,
  batch, customer, quantities, dates, storage, pack, label claim, "Analysis Required for" (the tests requested, then the purpose),
  remarks, the four sample cells (Sampled by, TRF Number, Sample Received by, AR number), and Prepared by and Approved by as blank
  signature boxes to be signed by hand. The creator and approver are still recorded in the system and in the print audit log; only the
  printed form leaves their names and dates off so the boxes can be signed by hand.
- **Header values** are the `FORM_*` settings (SOP number, revision, effective date, issued by, department), read through
  `GET /api/settings/form` and edited by administrators in Settings.
- **Audit:** every print and every PDF is recorded first (`POST /api/trfs/:id/print-log`, action `trf.printed`). The server names
  the person from the session, with the shared team account used, and refuses a TRF that is not locked. If the record cannot be
  made, nothing is printed.
- **How the PDF is made:** the desktop shell opens the app's own print page in a hidden window, waits for the page to report
  `data-print-state="ready"` (record, header values and logo all drawn), and prints it with A4 and 10 mm margins. Electron reads
  margins as inches, so they are converted from millimetres.
