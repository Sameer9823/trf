-- Migration 011: Sample Submitted By (employee FK) + widened ard_stage CHECK.
--
-- sample_given_by is TEXT today. We add sample_submitted_by_id (INTEGER FK to
-- employees) without dropping the legacy column, so old rows keep their text.
-- A backfill matches the old text to employees.full_name case-insensitively and
-- exactly; unmatched rows stay NULL and are shown read-only as
-- "Previously entered: <text>" on the form, where the user can pick an employee
-- to replace the free text.
--
-- ard_stage only allows the four ARD workflow statuses today. The new Stage
-- dropdown needs distinct lab stages (Sample Received, Sample Preparation,
-- Under Analysis, Data Review, Reporting, COA Preparation). The CHECK widens to
-- the union of old and new values so no existing row breaks; workflow_status
-- keeps its narrower constraint because it still holds the Final Status.

ALTER TABLE trfs ADD COLUMN IF NOT EXISTS sample_submitted_by_id INTEGER REFERENCES employees(id);

CREATE INDEX IF NOT EXISTS idx_trfs_sample_submitted_by ON trfs (sample_submitted_by_id);

-- Widening the CHECK constraint on ard_stage to the union of workflow statuses
-- and the new lab stages. PostgreSQL cannot ALTER CONSTRAINT, so the old one is
-- dropped and a wider one added. The constraint name matches the pattern from
-- 007/008/009, so re-running on a drifted database is safe.
ALTER TABLE trfs DROP CONSTRAINT IF EXISTS trfs_ard_stage_check;
ALTER TABLE trfs ADD CONSTRAINT trfs_ard_stage_check
  CHECK (ard_stage IN ('Received', 'In Progress', 'Completed', 'Cancelled',
                       'Sample Received', 'Sample Preparation', 'Under Analysis',
                       'Data Review', 'Reporting', 'COA Preparation'));

-- Backfill: match sample_given_by text to employees.full_name case-insensitively.
-- Only exact (case-insensitive) matches are filled; unmatched rows stay NULL.
-- When two employees share a name the lowest id wins, so the backfill is
-- deterministic and can be run twice without changing the result.
UPDATE trfs t
  SET sample_submitted_by_id = matched.id
  FROM (
    SELECT DISTINCT ON (lower(e.full_name)) e.id, lower(e.full_name) AS name
    FROM employees e
    WHERE e.full_name IS NOT NULL
    ORDER BY lower(e.full_name), e.id ASC
  ) matched
  WHERE t.sample_given_by IS NOT NULL
    AND t.sample_submitted_by_id IS NULL
    AND matched.name = lower(btrim(t.sample_given_by));

-- The ard_stage column already has a default of 'Received' from migration
-- 007/009, so no backfill is needed: existing rows keep their value.
