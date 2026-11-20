-- Migration 020: Composite indexes for TRF list query performance
-- These indexes support the common filter combinations used in the TRF list query

-- Composite index for status + required_completion_date (overdue filter)
CREATE INDEX IF NOT EXISTS idx_trfs_status_due_date ON trfs (status, required_completion_date);

-- Composite index for customer_id + status (customer filter + status filter)
CREATE INDEX IF NOT EXISTS idx_trfs_customer_status ON trfs (customer_id, status);

-- Composite index for product_id + status (product filter + status filter)
CREATE INDEX IF NOT EXISTS idx_trfs_product_status ON trfs (product_id, status);

-- Composite index for assigned_employee_id + status (assignee filter + status filter)
CREATE INDEX IF NOT EXISTS idx_trfs_assigned_status ON trfs (assigned_employee_id, status);

-- Composite index for department_id + status (department filter + status filter)
CREATE INDEX IF NOT EXISTS idx_trfs_department_status ON trfs (department_id, status);

-- Composite index for trf_date DESC + id DESC (default sort order)
CREATE INDEX IF NOT EXISTS idx_trfs_trf_date_id_desc ON trfs (trf_date DESC, id DESC);

-- Composite index for workflow_status + ard_analyst_id (ARD filters)
CREATE INDEX IF NOT EXISTS idx_trfs_workflow_analyst ON trfs (workflow_status, ard_analyst_id);

-- Composite index for remarks_status + final_approval_status (approval pending filter)
CREATE INDEX IF NOT EXISTS idx_trfs_remarks_final_approval ON trfs (remarks_status, final_approval_status);

-- Composite index for deleted_at + trf_date (soft delete + date ordering)
CREATE INDEX IF NOT EXISTS idx_trfs_deleted_trf_date ON trfs (deleted_at, trf_date DESC) WHERE deleted_at IS NOT NULL;

-- Partial index for active TRFs only (excludes soft-deleted)
CREATE INDEX IF NOT EXISTS idx_trfs_active_trf_date ON trfs (trf_date DESC) WHERE deleted_at IS NULL;

-- Partial index for non-terminal status TRFs (for overdue queries)
CREATE INDEX IF NOT EXISTS idx_trfs_active_due_date ON trfs (required_completion_date) 
  WHERE deleted_at IS NULL AND status NOT IN ('Completed', 'Cancelled');

-- Partial index for ARD workflow TRFs (for ARD team queries)
CREATE INDEX IF NOT EXISTS idx_trfs_ard_workflow ON trfs (workflow_status, analysis_start_date) 
  WHERE deleted_at IS NULL AND workflow_status IN ('Received', 'In Progress');

-- Index for search on trf_number (already exists but ensure it's there)
CREATE INDEX IF NOT EXISTS idx_trfs_number_lower ON trfs (lower(trf_number));

-- Index for search on batch_number (already exists but ensure it's there)
CREATE INDEX IF NOT EXISTS idx_trfs_batch_lower ON trfs (lower(batch_number));

-- Index for search on customer name (via join)
CREATE INDEX IF NOT EXISTS idx_customers_name_lower ON customers (lower(name));

-- Index for search on product name (via join)
CREATE INDEX IF NOT EXISTS idx_products_name_lower ON products (lower(name));

-- Index for search on employee full_name (via joins)
CREATE INDEX IF NOT EXISTS idx_employees_full_name_lower ON employees (lower(full_name));