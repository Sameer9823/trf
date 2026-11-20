-- Migration 018: System settings table and default form header values.
-- Idempotent: running it twice leaves the database unchanged the second time.

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  description TEXT,
  updated_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default values for the TRF print form header.
INSERT INTO system_settings (key, value, description) VALUES
  ('FORM_SOP_NO', 'QAGN:003:F1', 'SOP number printed on the TRF form'),
  ('FORM_REVISION', '00', 'Revision number printed on the TRF form'),
  ('FORM_EFFECTIVE_DATE', '', 'Effective date printed on the TRF form'),
  ('FORM_ISSUED_BY', '', 'Issued by name printed on the TRF form'),
  ('FORM_DEPARTMENT', 'Quality Assurance', 'Department name printed on the TRF form')
ON CONFLICT (key) DO NOTHING;