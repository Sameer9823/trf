-- Phase 12 follow-up: reconcile migration drift and seed lookup data.
--
-- Some databases applied an earlier version of 007 that created ard_status_history
-- with a FK to an ards table (ard_id → ards.id) instead of to trfs (trf_id →
-- trfs.id). The current code uses ARD columns inline on trfs and has no ards
-- table. Drop the old shape before recreating so CREATE TABLE IF NOT EXISTS
-- always produces the correct schema on both fresh and drifted databases.
--
-- This migration is fully idempotent (CREATE TABLE IF NOT EXISTS, ADD COLUMN IF
-- NOT EXISTS, DROP ... IF EXISTS) so it can run safely on both fresh and existing
-- databases.
--
-- New columns added in this migration:
--   remarks_status    – pending/approved/rejected on TRF remarks
--   sample_received_by – employee who received the sample (ARD section)

-- Reconcile: drop the old ard_status_history (which may have ard_id instead of
-- trf_id) and the obsolete ards table, so CREATE TABLE IF NOT EXISTS below
-- creates the correct shape from scratch. Both tables are dropped unconditionally:
-- ard_status_history exists without trf only when it was created by an earlier
-- 007; ards is only present for the same reason. No application code references
-- either in its current form.
DROP TABLE IF EXISTS ard_status_history CASCADE;
DROP TABLE IF EXISTS ards CASCADE;

-- Re-create ard_status_history with the current schema (trf_id → trfs.id).
CREATE TABLE IF NOT EXISTS ard_status_history (
  id          BIGSERIAL PRIMARY KEY,
  trf_id      INTEGER NOT NULL REFERENCES trfs(id) ON DELETE CASCADE,
  old_status  TEXT,
  new_status  TEXT NOT NULL,
  changed_by  INTEGER REFERENCES employees(id),
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_ard_history_trf ON ard_status_history (trf_id, changed_at DESC);

-- Re-assert every column the code reads from trfs, so an existing database
-- that applied an older 007 shape gets everything the current code expects.
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

-- ARD Analysis Details (Part B).
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS ard_number TEXT;
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS ard_stage TEXT NOT NULL DEFAULT 'Received'
  CHECK (ard_stage IN ('Received', 'In Progress', 'Completed', 'Cancelled'));
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS ard_analyst_id INTEGER REFERENCES employees(id);
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS analysis_start_date DATE;
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS ard_remarks TEXT;

-- Status columns with CHECK constraints.
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS reporting_status TEXT NOT NULL DEFAULT 'Pending'
  CHECK (reporting_status IN ('Pending', 'Draft', 'Submitted', 'Reviewed', 'Approved'));
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS coa_status TEXT NOT NULL DEFAULT 'Pending'
  CHECK (coa_status IN ('Pending', 'Draft', 'Under Review', 'Approved', 'Issued'));
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS workflow_status TEXT NOT NULL DEFAULT 'Received'
  CHECK (workflow_status IN ('Received', 'In Progress', 'Completed', 'Cancelled'));

ALTER TABLE trfs ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ;

-- Soft delete.
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS deleted_by INTEGER REFERENCES employees(id);
CREATE INDEX IF NOT EXISTS idx_trfs_deleted ON trfs (deleted_at) WHERE deleted_at IS NOT NULL;

-- New column: remarks_status (6a).
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS remarks_status TEXT NOT NULL DEFAULT 'Pending'
  CHECK (remarks_status IN ('Pending', 'Approved', 'Rejected'));

-- New column: sample_received_by (employee FK, ARD section) (6c).
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS sample_received_by INTEGER REFERENCES employees(id);

-- Re-assert indexes for the list and filter queries.
CREATE INDEX IF NOT EXISTS idx_trfs_manufacturing_date ON trfs (manufacturing_date);
CREATE INDEX IF NOT EXISTS idx_trfs_expiry_date ON trfs (expiry_date);
CREATE INDEX IF NOT EXISTS idx_trfs_ard_number ON trfs (ard_number);
CREATE INDEX IF NOT EXISTS idx_trfs_workflow_status ON trfs (workflow_status);
CREATE INDEX IF NOT EXISTS idx_trfs_ard_analyst ON trfs (ard_analyst_id);
CREATE INDEX IF NOT EXISTS idx_trfs_reporting_status ON trfs (reporting_status);
CREATE INDEX IF NOT EXISTS idx_trfs_coa_status ON trfs (coa_status);
CREATE INDEX IF NOT EXISTS idx_trfs_analysis_start ON trfs (analysis_start_date);
CREATE INDEX IF NOT EXISTS idx_trfs_sample_received_by ON trfs (sample_received_by);
CREATE INDEX IF NOT EXISTS idx_trfs_remarks_status ON trfs (remarks_status);

-- Backfill existing rows so NULL columns get their default values.
UPDATE trfs SET workflow_status = 'Received' WHERE workflow_status IS NULL;
UPDATE trfs SET ard_stage = 'Received' WHERE ard_stage IS NULL;
UPDATE trfs SET reporting_status = 'Pending' WHERE reporting_status IS NULL;
UPDATE trfs SET coa_status = 'Pending' WHERE coa_status IS NULL;
UPDATE trfs SET remarks_status = 'Pending' WHERE remarks_status IS NULL;

-- Seed the two required departments (Formulation and ARD) so department-based
-- permissions work on a fresh database. Idempotent: ON CONFLICT has no effect.
INSERT INTO departments (name) VALUES ('Formulation') ON CONFLICT (name) DO NOTHING;
INSERT INTO departments (name) VALUES ('ARD') ON CONFLICT (name) DO NOTHING;

-- Seed the 19 standard products. ON CONFLICT on the unique code column
-- makes the migration safe to re-run.
INSERT INTO products (name, code, description, is_active) VALUES
  ('CafRelExAct™', 'CAFRELEXC', 'Caffeine', TRUE),
  ('AsparExAct™', 'ASPARREXC', 'Aspartame', TRUE),
  ('NacExAct™ 85%', 'NACRELEXC', 'N-Acetyl Cysteine 85%', TRUE),
  ('AlphaExAct™ 75%', 'ALPHA75', 'Alpha-lipoic acid 75%', TRUE),
  ('AlphaExAct™ 15% (WS)', 'ALPHA15WS', 'Alpha-lipoic acid 15% water-soluble', TRUE),
  ('CarniExAct™', 'CARNIREXC', 'Carnitine', TRUE),
  ('ArginExAct™', 'ARGRELEXC', 'Arginine', TRUE),
  ('MetExAct™', 'METRELEXC', 'Methionine', TRUE),
  ('α-ketoExAct™', 'AKRELEXC', 'Alpha-ketoglutarate', TRUE),
  ('BranChExAct RD™', 'BRANCRELEXC', 'Branched-chain amino acids', TRUE),
  ('TelmiExAct™', 'TELMERELEXC', 'Telmisartan', TRUE),
  ('VitExAct™ B12 1%', 'VITB121', 'Vitamin B12 1%', TRUE),
  ('VitExAct™ B12 0.1%', 'VITB1201', 'Vitamin B12 0.1%', TRUE),
  ('CoQExAct™ 10%', 'COQ10', 'Coenzyme Q10 10%', TRUE),
  ('CoQExAct™ 20%', 'COQ20', 'Coenzyme Q10 20%', TRUE),
  ('CoQExAct™', 'COQRELEXC', 'Coenzyme Q10', TRUE),
  ('DHA ExAct™ : CWD', 'DHARELEXC', 'DHA in coconut water', TRUE),
  ('SoluExAct™ MCT : CWS', 'SOLUEXACTMCT', 'MCT oil water-soluble', TRUE),
  ('SoluExAct™ Orange : CWS', 'SOLUEXACTORANGE', 'Orange flavor water-soluble', TRUE)
ON CONFLICT (code) DO NOTHING;
