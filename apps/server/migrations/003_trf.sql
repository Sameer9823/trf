-- Phase 3: TRF management. Lookup tables, the TRF record and its status history.
-- Overdue is computed in queries (required_completion_date < today AND status not terminal),
-- so it never has to be kept in step with the status.

CREATE TABLE customers (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  code        TEXT UNIQUE,
  contact_person TEXT,
  email       TEXT,
  phone       TEXT,
  address     TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_customers_name_lower ON customers (lower(name));
CREATE TRIGGER trg_customers_updated BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE products (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  code        TEXT UNIQUE,
  description TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_products_name_lower ON products (lower(name));
CREATE TRIGGER trg_products_updated BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE trfs (
  id                        SERIAL PRIMARY KEY,
  trf_number                TEXT NOT NULL UNIQUE,
  trf_date                  DATE NOT NULL,
  customer_id               INTEGER REFERENCES customers(id),
  product_id                INTEGER REFERENCES products(id),
  batch_number              TEXT,
  sample_quantity           TEXT,
  sample_received_date      DATE,
  required_completion_date  DATE,
  priority                  TEXT NOT NULL DEFAULT 'Normal' CHECK (priority IN ('Low', 'Normal', 'High', 'Urgent')),
  requested_analysis        TEXT,
  special_instructions      TEXT,
  assigned_employee_id      INTEGER REFERENCES employees(id),
  department_id             INTEGER REFERENCES departments(id),
  status                    TEXT NOT NULL DEFAULT 'New'
                              CHECK (status IN ('New', 'Assigned', 'In Progress', 'Analysis Completed', 'COA Pending', 'Completed', 'Cancelled')),
  remarks                   TEXT,
  created_by                INTEGER REFERENCES employees(id),
  version                   INTEGER NOT NULL DEFAULT 1,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_trfs_number ON trfs (trf_number);
CREATE INDEX idx_trfs_status ON trfs (status);
CREATE INDEX idx_trfs_customer ON trfs (customer_id);
CREATE INDEX idx_trfs_product ON trfs (product_id);
CREATE INDEX idx_trfs_batch_lower ON trfs (lower(batch_number));
CREATE INDEX idx_trfs_assigned ON trfs (assigned_employee_id);
CREATE INDEX idx_trfs_due_date ON trfs (required_completion_date);
CREATE INDEX idx_trfs_trf_date ON trfs (trf_date DESC);
CREATE INDEX idx_trfs_department ON trfs (department_id);
-- Supports the overdue filter and the list's date-range searches.
CREATE INDEX idx_trfs_status_due ON trfs (status, required_completion_date);
CREATE INDEX idx_trfs_customer_lower ON trfs (customer_id) INCLUDE (trf_number);
CREATE TRIGGER trg_trfs_updated BEFORE UPDATE ON trfs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE trf_status_history (
  id          BIGSERIAL PRIMARY KEY,
  trf_id      INTEGER NOT NULL REFERENCES trfs(id) ON DELETE CASCADE,
  old_status  TEXT,
  new_status  TEXT NOT NULL,
  changed_by  INTEGER REFERENCES employees(id),
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  note        TEXT
);
CREATE INDEX idx_trf_history_trf ON trf_status_history (trf_id, changed_at DESC);
CREATE INDEX idx_trf_history_changed_at ON trf_status_history (changed_at DESC);
