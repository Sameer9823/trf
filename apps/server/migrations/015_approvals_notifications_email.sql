-- Migration 015: Approvals, notifications, email outbox, mailboxes, and audit attribution.
--
-- Continuation of shared team accounts feature.

-- 3. TRF approvals table (history of every decision)
CREATE TABLE IF NOT EXISTS trf_approvals (
  id                      BIGSERIAL PRIMARY KEY,
  trf_id                  INTEGER NOT NULL REFERENCES trfs(id) ON DELETE CASCADE,
  track                   TEXT NOT NULL CHECK (track IN ('FORMULATION', 'ARD')),
  status                  TEXT NOT NULL CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Returned')),
  requested_by_employee_id INTEGER NOT NULL REFERENCES employees(id),
  requested_by_account_id  INTEGER NOT NULL REFERENCES team_accounts(id),
  requested_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by              INTEGER REFERENCES employees(id),
  decided_at              TIMESTAMPTZ,
  reason                  TEXT,
  version                 INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_trf_approvals_trf ON trf_approvals (trf_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_trf_approvals_track_status ON trf_approvals (track, status);

-- 4. Notifications table
CREATE TABLE IF NOT EXISTS notifications (
  id                      BIGSERIAL PRIMARY KEY,
  recipient_type          TEXT NOT NULL CHECK (recipient_type IN ('EMPLOYEE', 'TEAM')),
  recipient_employee_id   INTEGER REFERENCES employees(id) ON DELETE CASCADE,
  recipient_team          TEXT CHECK (recipient_team IN ('FRD', 'ARD')),
  type                    TEXT NOT NULL,
  title                   TEXT NOT NULL,
  body                    TEXT NOT NULL,
  related_trf_id          INTEGER REFERENCES trfs(id) ON DELETE SET NULL,
  link                    TEXT,
  is_read                 BOOLEAN NOT NULL DEFAULT FALSE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at                 TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_notifications_employee ON notifications (recipient_employee_id, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_team ON notifications (recipient_team, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_trf ON notifications (related_trf_id);

-- 5. Email outbox table (queue-based sending)
CREATE TABLE IF NOT EXISTS email_outbox (
  id                      BIGSERIAL PRIMARY KEY,
  to_addr                 TEXT NOT NULL,
  cc                      TEXT,
  subject                 TEXT NOT NULL,
  body_html               TEXT NOT NULL,
  body_text               TEXT NOT NULL,
  from_mailbox            TEXT NOT NULL,
  related_trf_id          INTEGER REFERENCES trfs(id) ON DELETE SET NULL,
  acting_employee_id      INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  status                  TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts                INTEGER NOT NULL DEFAULT 0,
  last_error              TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at                 TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_email_outbox_status ON email_outbox (status, created_at);
CREATE INDEX IF NOT EXISTS idx_email_outbox_trf ON email_outbox (related_trf_id);

-- 6. Department mailboxes table (SMTP settings per team)
CREATE TABLE IF NOT EXISTS department_mailboxes (
  team                    TEXT PRIMARY KEY CHECK (team IN ('FRD', 'ARD')),
  address                 TEXT NOT NULL,
  display_name            TEXT NOT NULL,
  smtp_host               TEXT NOT NULL,
  smtp_port               INTEGER NOT NULL,
  smtp_secure             BOOLEAN NOT NULL DEFAULT TRUE,
  smtp_user               TEXT NOT NULL,
  smtp_pass_encrypted     TEXT NOT NULL, -- encrypted at rest, key from env
  is_active               BOOLEAN NOT NULL DEFAULT TRUE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_department_mailboxes_updated BEFORE UPDATE ON department_mailboxes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed default mailboxes (Admin configures real SMTP via UI)
INSERT INTO department_mailboxes (team, address, display_name, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass_encrypted, is_active)
VALUES
  ('FRD', 'frd@company.local', 'Formulation Team', 'smtp.example.com', 465, TRUE, 'frd@company.local', '', FALSE),
  ('ARD', 'ard@company.local', 'Analytical Team', 'smtp.example.com', 465, TRUE, 'ard@company.local', '', FALSE)
ON CONFLICT (team) DO NOTHING;