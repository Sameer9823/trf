-- Phase 12: Formulation Team TRF form fields + ARD Analysis Details on the same record.
-- The new columns are all nullable so existing rows stay valid.

-- Ten extra columns from the Formulation Team's paper Test Request Form.
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS batch_size TEXT;
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS dosage_form TEXT;
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS manufacturing_location TEXT;
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS label_claim TEXT;
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS pack_size TEXT;
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS pack_type TEXT;
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS storage_condition TEXT;
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS storage_period TEXT;
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS manufacturing_date DATE;
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS expiry_date DATE;
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS analysis_purpose TEXT;
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS sample_given_by TEXT;
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS signature_date DATE;

CREATE INDEX IF NOT EXISTS idx_trfs_manufacturing_date ON trfs (manufacturing_date);
CREATE INDEX IF NOT EXISTS idx_trfs_expiry_date ON trfs (expiry_date);

-- ARD Analysis Details: Part B of the same TRF record. Nullable until the ARD
-- team fills them in, so existing TRFs are unaffected.
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS ard_number TEXT;
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS ard_stage TEXT NOT NULL DEFAULT 'Received'
  CHECK (ard_stage IN ('Received', 'In Progress', 'Completed', 'Cancelled'));
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS ard_analyst_id INTEGER REFERENCES employees(id);
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS analysis_start_date DATE;
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS reporting_status TEXT NOT NULL DEFAULT 'Pending'
  CHECK (reporting_status IN ('Pending', 'Draft', 'Submitted', 'Reviewed', 'Approved'));
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS coa_status TEXT NOT NULL DEFAULT 'Pending'
  CHECK (coa_status IN ('Pending', 'Draft', 'Under Review', 'Approved', 'Issued'));
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS workflow_status TEXT NOT NULL DEFAULT 'Received'
  CHECK (workflow_status IN ('Received', 'In Progress', 'Completed', 'Cancelled'));
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS ard_remarks TEXT;
-- Timestamped when the workflow reaches a terminal status, so TAT has a fixed
-- endpoint instead of always recomputing "today".
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_trfs_ard_number ON trfs (ard_number);
CREATE INDEX IF NOT EXISTS idx_trfs_workflow_status ON trfs (workflow_status);
CREATE INDEX IF NOT EXISTS idx_trfs_ard_analyst ON trfs (ard_analyst_id);
CREATE INDEX IF NOT EXISTS idx_trfs_reporting_status ON trfs (reporting_status);
CREATE INDEX IF NOT EXISTS idx_trfs_coa_status ON trfs (coa_status);
CREATE INDEX IF NOT EXISTS idx_trfs_analysis_start ON trfs (analysis_start_date);

-- Soft delete: keep the TRF row and its number reserved, but hide it everywhere.
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS deleted_by INTEGER REFERENCES employees(id);
CREATE INDEX IF NOT EXISTS idx_trfs_deleted ON trfs (deleted_at) WHERE deleted_at IS NOT NULL;

-- History for workflow_status transitions, mirroring trf_status_history.
CREATE TABLE ard_status_history (
  id              BIGSERIAL PRIMARY KEY,
  trf_id          INTEGER NOT NULL REFERENCES trfs(id) ON DELETE CASCADE,
  old_status      TEXT,
  new_status      TEXT NOT NULL,
  changed_by      INTEGER REFERENCES employees(id),
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  note            TEXT
);
CREATE INDEX IF NOT EXISTS idx_ard_history_trf ON ard_status_history (trf_id, changed_at DESC);

-- Backfill: existing TRFs start with the defaults above (all NULL/Pending).
-- No data migration is needed.
