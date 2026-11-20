-- Migration 026: Dosage Form multi-select junction table, Other option support, and new dosage options
-- This migration adds:
-- 1. trf_dosage_forms junction table for multi-select dosage forms on TRFs
-- 2. dosage_form_other column on trfs for custom dosage descriptions
-- 3. New dosage form options listed in the FRD spec
-- 4. Audit view for assignment history

-- 1. Add dosage_form_other column to trfs for custom dosage descriptions
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS dosage_form_other TEXT;

-- 2. Create trf_dosage_forms junction table for multi-select dosage forms
CREATE TABLE IF NOT EXISTS trf_dosage_forms (
  id                    BIGSERIAL PRIMARY KEY,
  trf_id                INTEGER NOT NULL REFERENCES trfs(id) ON DELETE CASCADE,
  dosage_form_option_id INTEGER NOT NULL REFERENCES dosage_form_options(id) ON DELETE RESTRICT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by            INTEGER REFERENCES employees(id),
  UNIQUE (trf_id, dosage_form_option_id)
);
CREATE INDEX IF NOT EXISTS idx_trf_dosage_forms_trf ON trf_dosage_forms (trf_id);
CREATE INDEX IF NOT EXISTS idx_trf_dosage_forms_option ON trf_dosage_forms (dosage_form_option_id);

-- 3. Add new dosage form options from the FRD specification
-- Existing options from migration 021 are preserved; these are additions.
INSERT INTO dosage_form_options (name, display_order) VALUES
  ('Tablet', 101),
  ('Capsule', 102),
  ('Softgel', 103),
  ('Ready-to-Drink (RTD) Beverage', 104),
  ('Gummy', 105),
  ('Nutrition Bar', 106),
  ('Other', 107)
ON CONFLICT (name) DO NOTHING;

-- 4. Update the ard_test_assignment_history table to also reference the assigning employee
--    (already exists from migration 022, but ensure the analyst_id is stored for completeness)
CREATE INDEX IF NOT EXISTS idx_ard_test_assignment_history_changed_at ON ard_test_assignment_history (changed_at);

-- 5. Create a view that combines TRF test requests with their ARD assignments
--    This supports the employee dashboard showing assigned tests
CREATE OR REPLACE VIEW ard_employee_assignments AS
SELECT
  ata.id AS assignment_id,
  ata.trf_id,
  t.trf_number,
  t.batch_number,
  t.batch_size,
  ata.test_name,
  ata.test_requested_option_id,
  tro.name AS test_option_name,
  ata.status AS test_status,
  ata.assigned_by,
  ab.full_name AS assigned_by_name,
  ata.assigned_at,
  ata.created_at AS assignment_created_at,
  ata.updated_at AS assignment_updated_at,
  e.id AS analyst_id,
  e.full_name AS analyst_name,
  e.employee_code AS analyst_code,
  d.name AS analyst_department,
  ataa.assigned_at AS analyst_assigned_at
FROM ard_test_assignments ata
JOIN trfs t ON t.id = ata.trf_id
LEFT JOIN test_requested_options tro ON tro.id = ata.test_requested_option_id
LEFT JOIN ard_test_assignment_analysts ataa ON ataa.assignment_id = ata.id
LEFT JOIN employees e ON e.id = ataa.analyst_id AND e.is_active = TRUE
LEFT JOIN departments d ON d.id = e.department_id
LEFT JOIN employees ab ON ab.id = ata.assigned_by
WHERE e.id IS NOT NULL OR ata.assigned_by IS NOT NULL
ORDER BY ata.assigned_at DESC, ata.test_name;

-- 6. Create a view for the ARD overview showing all tests with assignments
CREATE OR REPLACE VIEW ard_overview AS
SELECT
  ata.id AS assignment_id,
  ata.trf_id,
  t.trf_number,
  t.batch_number,
  t.batch_size,
  t.status AS trf_status,
  t.workflow_status AS ard_workflow_status,
  t.remarks_status AS formulation_status,
  t.final_approval_status,
  t.locked_at,
  ata.test_name,
  ata.test_requested_option_id,
  tro.name AS test_option_name,
  ata.status AS test_status,
  ata.assigned_by,
  ab.full_name AS assigned_by_name,
  ata.assigned_at,
  COALESCE(
    json_agg(
      json_build_object(
        'analyst_id', e.id,
        'analyst_name', e.full_name,
        'analyst_code', e.employee_code,
        'analyst_department', d.name,
        'assigned_at', ataa.assigned_at
      )
    ) FILTER (WHERE e.id IS NOT NULL),
    '[]'::json
  ) AS analysts
FROM ard_test_assignments ata
JOIN trfs t ON t.id = ata.trf_id
LEFT JOIN test_requested_options tro ON tro.id = ata.test_requested_option_id
LEFT JOIN ard_test_assignment_analysts ataa ON ataa.assignment_id = ata.id
LEFT JOIN employees e ON e.id = ataa.analyst_id AND e.is_active = TRUE
LEFT JOIN departments d ON d.id = e.department_id
LEFT JOIN employees ab ON ab.id = ata.assigned_by
GROUP BY ata.id, t.id, tro.name, ab.full_name
ORDER BY t.trf_date DESC, ata.test_name;
