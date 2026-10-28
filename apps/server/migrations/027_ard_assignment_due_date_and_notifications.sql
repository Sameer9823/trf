-- Migration 027: Add due_date to ARD test assignments and enhance notification support
-- This migration adds:
-- 1. due_date column to ard_test_assignments table
-- 2. Additional indexes for assignment queries

-- 1. Add due_date to ard_test_assignments
ALTER TABLE ard_test_assignments
  ADD COLUMN IF NOT EXISTS due_date DATE;

-- 2. Add index for due_date queries
CREATE INDEX IF NOT EXISTS idx_ard_test_assignments_due_date ON ard_test_assignments (due_date);

-- 3. Add index for assignment queries by analyst and status
CREATE INDEX IF NOT EXISTS idx_ard_test_assignment_analysts_analyst_status ON ard_test_assignment_analysts (analyst_id);

-- 4. Ensure notifications table exists (from migration 015) - just in case
-- The notifications table should already exist from migration 015

-- 5. Add index for unread notification count queries
CREATE INDEX IF NOT EXISTS idx_notifications_employee_unread ON notifications (recipient_employee_id, is_read) WHERE is_read = FALSE;

-- 6. Drop existing views if they exist (to avoid column name conflicts)
DROP VIEW IF EXISTS ard_employee_assignments;
DROP VIEW IF EXISTS ard_overview;

-- 7. Create a view for ARD employee assignments with due dates
CREATE VIEW ard_employee_assignments AS
SELECT
  ata.id AS assignment_id,
  ata.trf_id,
  t.trf_number,
  t.ard_number,
  p.name AS product_name,
  t.generic_name,
  t.batch_number,
  t.required_completion_date,
  ata.test_requested_option_id,
  ata.test_name,
  ata.status,
  ata.assigned_by,
  ab.full_name AS assigned_by_name,
  ata.assigned_at,
  ata.due_date,
  ata.created_at AS assignment_created_at,
  ata.updated_at AS assignment_updated_at,
  e.id AS analyst_id,
  e.full_name AS analyst_name,
  e.employee_code AS analyst_code,
  d.name AS analyst_department,
  ataa.assigned_at AS analyst_assigned_at
FROM ard_test_assignments ata
JOIN trfs t ON t.id = ata.trf_id
JOIN products p ON p.id = t.product_id
LEFT JOIN ard_test_assignment_analysts ataa ON ataa.assignment_id = ata.id
LEFT JOIN employees e ON e.id = ataa.analyst_id AND e.is_active = TRUE
LEFT JOIN departments d ON d.id = e.department_id
LEFT JOIN employees ab ON ab.id = ata.assigned_by
WHERE e.id IS NOT NULL OR ata.assigned_by IS NOT NULL
ORDER BY ata.created_at ASC;

-- 8. Create a view for ARD overview with all tests
CREATE VIEW ard_overview AS
SELECT
  ata.id AS assignment_id,
  ata.trf_id,
  t.trf_number,
  p.name AS product_name,
  t.generic_name,
  t.batch_number,
  t.status AS trf_status,
  t.workflow_status AS ard_workflow_status,
  t.remarks_status AS formulation_status,
  t.final_approval_status,
  t.locked_at,
  t.required_completion_date,
  ata.test_name,
  ata.test_requested_option_id,
  ata.status AS test_status,
  ata.assigned_by,
  ab.full_name AS assigned_by_name,
  ata.assigned_at,
  ata.due_date,
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
JOIN products p ON p.id = t.product_id
LEFT JOIN ard_test_assignment_analysts ataa ON ataa.assignment_id = ata.id
LEFT JOIN employees e ON e.id = ataa.analyst_id AND e.is_active = TRUE
LEFT JOIN departments d ON d.id = e.department_id
LEFT JOIN employees ab ON ab.id = ata.assigned_by
GROUP BY ata.id, t.id, p.name, t.generic_name, t.batch_number, t.status, t.workflow_status, t.remarks_status, t.final_approval_status, t.locked_at, t.required_completion_date, ata.test_name, ata.test_requested_option_id, ata.status, ata.assigned_by, ab.full_name, ata.assigned_at, ata.due_date
ORDER BY t.trf_date DESC, ata.test_name;