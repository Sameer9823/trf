-- Migration 024: TRF Lock Columns and Views (Part 2)
-- This migration adds:
-- 1. Additional columns on trfs table for lock tracking
-- 2. Views for analyst dashboard and ARD overview

-- 1. Add columns to trfs for lock tracking
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS locked_by INTEGER REFERENCES employees(id);
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS final_approval_status TEXT DEFAULT 'None'
  CHECK (final_approval_status IN ('None', 'Pending', 'Approved', 'Rejected'));
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS final_decided_at TIMESTAMPTZ;
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS final_decided_by INTEGER REFERENCES employees(id);

-- 2. Add formulation approval tracking to trfs
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS formulation_decided_at TIMESTAMPTZ;
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS formulation_decided_by INTEGER REFERENCES employees(id);
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS formulation_approval_status TEXT DEFAULT 'None'
  CHECK (formulation_approval_status IN ('None', 'Pending', 'Approved', 'Rejected', 'Returned'));

-- 3. Add ard_approval_status to trfs
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS ard_approval_status TEXT DEFAULT 'None'
  CHECK (ard_approval_status IN ('None', 'Pending', 'Approved', 'Rejected', 'Returned'));
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS ard_decided_at TIMESTAMPTZ;
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS ard_decided_by INTEGER REFERENCES employees(id);

-- 4. Create view for analyst dashboard - assigned tests
CREATE OR REPLACE VIEW analyst_assigned_tests AS
SELECT
  ata.id AS assignment_id,
  ata.trf_id,
  t.trf_number,
  p.name AS product_name,
  t.generic_name,
  t.batch_number,
  ata.test_name,
  ata.status AS test_status,
  ata.assigned_at,
  ata.assigned_by,
  e.id AS analyst_id,
  e.full_name AS analyst_name,
  e.employee_code AS analyst_code,
  d.name AS analyst_department
FROM ard_test_assignments ata
JOIN trfs t ON t.id = ata.trf_id
JOIN products p ON p.id = t.product_id
JOIN ard_test_assignment_analysts ataa ON ataa.assignment_id = ata.id
JOIN employees e ON e.id = ataa.analyst_id
LEFT JOIN departments d ON d.id = e.department_id
WHERE e.is_active = TRUE
  AND ata.status NOT IN ('Cancelled')
ORDER BY ata.assigned_at DESC;

-- 5. Create view for ARD dashboard - test assignment overview
CREATE OR REPLACE VIEW ard_test_assignment_overview AS
SELECT
  ata.id AS assignment_id,
  ata.trf_id,
  t.trf_number,
  p.name AS product_name,
  t.generic_name,
  t.batch_number,
  t.status AS trf_status,
  t.workflow_status AS ard_workflow_status,
  ata.test_name,
  ata.status AS test_status,
  ata.assigned_at,
  ata.assigned_by,
  ab.full_name AS assigned_by_name,
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
GROUP BY ata.id, t.id, p.name, ab.full_name
ORDER BY t.trf_date DESC, ata.test_name;