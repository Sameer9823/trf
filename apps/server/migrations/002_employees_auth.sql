-- Phase 2: employees, roles, refresh tokens and the audit trail.
-- Plain parameterized writes only; the application never uses dynamic identifiers.

CREATE TABLE employees (
  id                   SERIAL PRIMARY KEY,
  employee_code        TEXT NOT NULL UNIQUE,
  full_name            TEXT NOT NULL,
  designation          TEXT,
  department_id        INTEGER REFERENCES departments(id),
  email                TEXT NOT NULL UNIQUE,
  phone                TEXT,
  username             TEXT NOT NULL UNIQUE,
  password_hash        TEXT NOT NULL,
  role                 TEXT NOT NULL CHECK (role IN ('Admin', 'Manager', 'Analyst', 'Viewer')),
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  failed_login_count   INTEGER NOT NULL DEFAULT 0,
  locked_until         TIMESTAMPTZ,
  last_login_at        TIMESTAMPTZ,
  version              INTEGER NOT NULL DEFAULT 1,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by           INTEGER REFERENCES employees(id)
);
CREATE INDEX idx_employees_username ON employees (lower(username));
CREATE INDEX idx_employees_email ON employees (lower(email));
CREATE INDEX idx_employees_department ON employees (department_id);
CREATE INDEX idx_employees_role ON employees (role);
CREATE INDEX idx_employees_active_role ON employees (is_active, role);
CREATE TRIGGER trg_employees_updated BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Only a hash of the refresh token is stored, so a database copy cannot be replayed.
CREATE TABLE refresh_tokens (
  id         SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_agent TEXT
);
CREATE INDEX idx_refresh_tokens_employee ON refresh_tokens (employee_id);
CREATE INDEX idx_refresh_tokens_expires ON refresh_tokens (expires_at);

-- Password reset tokens (hashed, single-use, time-limited)
CREATE TABLE password_reset_tokens (
  id         SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_password_reset_tokens_employee ON password_reset_tokens (employee_id);
CREATE INDEX idx_password_reset_tokens_expires ON password_reset_tokens (expires_at);

-- Append-only audit trail (Phase 9 completes the coverage; the table starts here).
CREATE TABLE audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER,
  user_name   TEXT,
  action      TEXT NOT NULL,
  module      TEXT NOT NULL,
  record_type TEXT,
  record_ref  TEXT,
  old_value   JSONB,
  new_value   JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_logs_user ON audit_logs (user_id);
CREATE INDEX idx_audit_logs_module ON audit_logs (module);
CREATE INDEX idx_audit_logs_record ON audit_logs (record_type, record_ref);
CREATE INDEX idx_audit_logs_created ON audit_logs (created_at DESC);
