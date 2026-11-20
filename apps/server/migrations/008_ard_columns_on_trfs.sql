-- Phase 12 follow-up: add ARD Analysis Details columns directly to trfs.
--
-- The original 007_ard_tracking.sql was applied with a different shape (separate
-- ards table + a subset of columns on trfs). Phase 12 moved those columns onto
-- trfs itself, but never re-ran because the migration was already marked applied.
-- This migration adds the missing columns to trfs; it is idempotent (IF NOT EXISTS).

-- ARD Analysis Details: Part B of the same TRF record.
-- Existing rows keep their current values; new rows get the defaults.
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS ard_number TEXT;
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS ard_stage TEXT NOT NULL DEFAULT 'Received'
  CHECK (ard_stage IN ('Received', 'In Progress', 'Completed', 'Cancelled'));
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS ard_analyst_id INTEGER REFERENCES employees(id);
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS analysis_start_date DATE;
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS ard_remarks TEXT;

-- Ensure the CHECK-constrained status columns exist (they may have been added
-- by the original migration, but guard against that too).
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS reporting_status TEXT NOT NULL DEFAULT 'Pending'
  CHECK (reporting_status IN ('Pending', 'Draft', 'Submitted', 'Reviewed', 'Approved'));
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS coa_status TEXT NOT NULL DEFAULT 'Pending'
  CHECK (coa_status IN ('Pending', 'Draft', 'Under Review', 'Approved', 'Issued'));
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS workflow_status TEXT NOT NULL DEFAULT 'Received'
  CHECK (workflow_status IN ('Received', 'In Progress', 'Completed', 'Cancelled'));

-- Timestamped when the workflow reaches a terminal status, so TAT has a fixed
-- endpoint instead of always recomputing "today".
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ;

-- Soft delete: keep the TRF row and its number reserved, but hide it everywhere.
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS deleted_by INTEGER REFERENCES employees(id);
CREATE INDEX IF NOT EXISTS idx_trfs_deleted ON trfs (deleted_at) WHERE deleted_at IS NOT NULL;

-- Backfill: any existing trfs row that has a NULL workflow_status gets 'Received'.
-- (The ALTER above only sets the default for new rows; backfill existing ones.)
UPDATE trfs SET workflow_status = 'Received' WHERE workflow_status IS NULL;
UPDATE trfs SET ard_stage = 'Received' WHERE ard_stage IS NULL;
UPDATE trfs SET reporting_status = 'Pending' WHERE reporting_status IS NULL;
UPDATE trfs SET coa_status = 'Pending' WHERE coa_status IS NULL;

-- Indexes for the list and filter queries.
CREATE INDEX IF NOT EXISTS idx_trfs_ard_number ON trfs (ard_number);
CREATE INDEX IF NOT EXISTS idx_trfs_workflow_status ON trfs (workflow_status);
CREATE INDEX IF NOT EXISTS idx_trfs_ard_analyst ON trfs (ard_analyst_id);
CREATE INDEX IF NOT EXISTS idx_trfs_reporting_status ON trfs (reporting_status);
CREATE INDEX IF NOT EXISTS idx_trfs_coa_status ON trfs (coa_status);
CREATE INDEX IF NOT EXISTS idx_trfs_analysis_start ON trfs (analysis_start_date);
