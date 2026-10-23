-- Migration 014: Shared team accounts, PINs, approvals, notifications, and email outbox.
--
-- This migration adds support for FRD/ARD shared team accounts with per-member PINs,
-- approval workflows (GM for Formulation, AGM for ARD), in-app notifications,
-- and a queued email outbox with department mailboxes.

-- 1. Extend employees table with shared-team fields
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'INDIVIDUAL'
    CHECK (account_type IN ('INDIVIDUAL', 'SHARED_TEAM')),
  ADD COLUMN IF NOT EXISTS team TEXT
    CHECK (team IN ('FRD', 'ARD')),
  ADD COLUMN IF NOT EXISTS pin_hash TEXT,
  ADD COLUMN IF NOT EXISTS pin_failed_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pin_locked_until TIMESTAMPTZ;

-- Widen the role CHECK to include GM and AGM
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_role_check;
ALTER TABLE employees ADD CONSTRAINT employees_role_check
  CHECK (role IN ('Admin', 'Manager', 'Analyst', 'Viewer', 'GM', 'AGM'));

CREATE INDEX IF NOT EXISTS idx_employees_team ON employees (team);
CREATE INDEX IF NOT EXISTS idx_employees_account_type ON employees (account_type);

-- 2. Team accounts table (one FRD, one ARD)
CREATE TABLE IF NOT EXISTS team_accounts (
  id              SERIAL PRIMARY KEY,
  team            TEXT NOT NULL UNIQUE CHECK (team IN ('FRD', 'ARD')),
  username        TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_team_accounts_updated BEFORE UPDATE ON team_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed the two team accounts (passwords set by Admin later via UI)
INSERT INTO team_accounts (team, username, password_hash, email, is_active, must_change_password)
VALUES
  ('FRD', 'frd_team', '', 'frd@company.local', FALSE, TRUE),
  ('ARD', 'ard_team', '', 'ard@company.local', FALSE, TRUE)
ON CONFLICT (team) DO NOTHING;