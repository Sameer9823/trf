-- Migration 022: ARD Analyst Assignment and Approval Workflow (Part 1)
-- This migration adds tables for:
-- 1. ARD test assignments (multiple analysts per test, multiple tests per TRF)
-- 2. Assignment history for audit trail
-- 3. FRD/ARD approval records with approver tracking
-- 4. TRF lock information
-- 5. Test status tracking per test

-- 1. ARD Test Assignments - links TRF tests to analysts
CREATE TABLE IF NOT EXISTS ard_test_assignments (
  id                    BIGSERIAL PRIMARY KEY,
  trf_id                INTEGER NOT NULL REFERENCES trfs(id) ON DELETE CASCADE,
  test_requested_option_id INTEGER NOT NULL REFERENCES test_requested_options(id) ON DELETE RESTRICT,
  test_name             TEXT NOT NULL, -- denormalized for display
  status                TEXT NOT NULL DEFAULT 'Pending Assignment'
    CHECK (status IN ('Pending Assignment', 'Assigned', 'In Progress', 'Completed', 'Re-test Required', 'Cancelled')),
  assigned_by           INTEGER REFERENCES employees(id), -- AGM/Admin who assigned
  assigned_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ard_test_assignments_trf ON ard_test_assignments (trf_id);
CREATE INDEX idx_ard_test_assignments_test_option ON ard_test_assignments (test_requested_option_id);
CREATE INDEX idx_ard_test_assignments_status ON ard_test_assignments (status);
CREATE TRIGGER trg_ard_test_assignments_updated BEFORE UPDATE ON ard_test_assignments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 2. ARD Test Assignment Analysts - many-to-many between assignments and analysts
CREATE TABLE IF NOT EXISTS ard_test_assignment_analysts (
  id                    BIGSERIAL PRIMARY KEY,
  assignment_id         BIGINT NOT NULL REFERENCES ard_test_assignments(id) ON DELETE CASCADE,
  analyst_id            INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  assigned_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_by           INTEGER REFERENCES employees(id), -- AGM/Admin who assigned
  UNIQUE (assignment_id, analyst_id)
);
CREATE INDEX idx_ard_test_assignment_analysts_assignment ON ard_test_assignment_analysts (assignment_id);
CREATE INDEX idx_ard_test_assignment_analysts_analyst ON ard_test_assignment_analysts (analyst_id);

-- 3. ARD Test Assignment History - audit trail for assignments/reassignments
CREATE TABLE IF NOT EXISTS ard_test_assignment_history (
  id                    BIGSERIAL PRIMARY KEY,
  assignment_id         BIGINT NOT NULL REFERENCES ard_test_assignments(id) ON DELETE CASCADE,
  action                TEXT NOT NULL CHECK (action IN ('ASSIGNED', 'REASSIGNED', 'UNASSIGNED', 'STATUS_CHANGED')),
  old_analyst_ids       INTEGER[], -- previous analyst IDs
  new_analyst_ids       INTEGER[], -- new analyst IDs
  old_status            TEXT,
  new_status            TEXT,
  changed_by            INTEGER NOT NULL REFERENCES employees(id),
  changed_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason                TEXT
);
CREATE INDEX idx_ard_test_assignment_history_assignment ON ard_test_assignment_history (assignment_id);
CREATE INDEX idx_ard_test_assignment_history_changed_by ON ard_test_assignment_history (changed_by);