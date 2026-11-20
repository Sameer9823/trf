-- Migration 012: ARD stages as a master table; drop the ard_stage CHECK.
--
-- Stage is no longer a CHECK-enumerated free text. It is a value from the
-- ard_stages master table and is validated by the application: a value that is
-- not in ard_stages is a 400 with a field message, never a 500.
--
-- Existing rows hold workflow statuses (Received, In Progress, Completed,
-- Cancelled) in ard_stage. Those are not stages, so they are inserted into
-- ard_stages as inactive legacy values: existing TRFs still display their
-- value, but only active stages are offered in the dropdown. New TRFs default
-- to the active stage "Initial".
--
-- Migration 011 widened trfs_ard_stage_check; that constraint is dropped here
-- (011 is applied and is never edited). ard_stage stays TEXT.
-- 012 is idempotent: safe to run on a fresh database and on one that already
-- has TRFs.

-- Drop the CHECK constraint on ard_stage (auto-named, created inline).
ALTER TABLE trfs DROP CONSTRAINT IF EXISTS trfs_ard_stage_check;

-- Master table of ARD stages.
CREATE TABLE IF NOT EXISTS ard_stages (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by INTEGER REFERENCES employees(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive unique index on name.
CREATE UNIQUE INDEX IF NOT EXISTS ard_stages_name_unique ON ard_stages (lower(name));

-- Seed the default stage. New TRFs default to "Initial". Re-running keeps it
-- active even if a previous run left it inactive.
INSERT INTO ard_stages (name, is_active) VALUES ('Initial', TRUE)
  ON CONFLICT (lower(name)) DO UPDATE SET is_active = TRUE;

-- Legacy workflow values that older TRF rows still hold in ard_stage. Keep
-- them so nothing is lost, but mark them inactive so they are not offered in
-- the dropdown. Re-running leaves them inactive.
INSERT INTO ard_stages (name, is_active) VALUES
  ('Received', FALSE), ('In Progress', FALSE), ('Completed', FALSE), ('Cancelled', FALSE)
ON CONFLICT (lower(name)) DO NOTHING;

-- New TRFs default to the active "Initial" stage.
ALTER TABLE trfs ALTER COLUMN ard_stage SET DEFAULT 'Initial';

-- Reporting: add "Rejected" to the allowed values. Old values stay valid.
ALTER TABLE trfs DROP CONSTRAINT IF EXISTS trfs_reporting_status_check;
ALTER TABLE trfs ADD CONSTRAINT trfs_reporting_status_check
  CHECK (reporting_status IN ('Pending', 'Draft', 'Submitted', 'Reviewed', 'Approved', 'Rejected'));
