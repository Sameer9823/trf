-- Migration 023: ARD Approvals and TRF Locks (Part 1)
-- This migration adds:
-- 1. FRD/ARD Approval Records - track approvals with approver identity
-- 2. TRF Lock Information - final lock by AGM
-- 3. TRF Lock History - audit trail for lock/unlock

-- 1. FRD/ARD Approval Records - track approvals with approver identity
CREATE TABLE IF NOT EXISTS trf_approvals (
  id                    BIGSERIAL PRIMARY KEY,
  trf_id                INTEGER NOT NULL REFERENCES trfs(id) ON DELETE CASCADE,
  track                 TEXT NOT NULL CHECK (track IN ('FORMULATION', 'ARD')),
  status                TEXT NOT NULL DEFAULT 'Pending'
    CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Returned')),
  requested_by_employee_id INTEGER NOT NULL REFERENCES employees(id),
  requested_by_account_id INTEGER REFERENCES team_accounts(id),
  requested_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by            INTEGER REFERENCES employees(id),
  decided_at            TIMESTAMPTZ,
  reason                TEXT,
  version               INTEGER NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trf_approvals_trf ON trf_approvals (trf_id);
CREATE INDEX IF NOT EXISTS idx_trf_approvals_track ON trf_approvals (track);
CREATE INDEX IF NOT EXISTS idx_trf_approvals_status ON trf_approvals (status);
CREATE INDEX IF NOT EXISTS idx_trf_approvals_decided_by ON trf_approvals (decided_by);

-- 2. TRF Lock Information - final lock by AGM
CREATE TABLE IF NOT EXISTS trf_locks (
  id                    BIGSERIAL PRIMARY KEY,
  trf_id                INTEGER NOT NULL REFERENCES trfs(id) ON DELETE CASCADE,
  locked_by             INTEGER NOT NULL REFERENCES employees(id),
  locked_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  lock_reason           TEXT,
  final_status          TEXT NOT NULL,
  all_tests_completed   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trf_locks_trf ON trf_locks (trf_id);
CREATE INDEX IF NOT EXISTS idx_trf_locks_locked_by ON trf_locks (locked_by);

-- 3. TRF Lock History - audit trail for lock/unlock
CREATE TABLE IF NOT EXISTS trf_lock_history (
  id                    BIGSERIAL PRIMARY KEY,
  trf_id                INTEGER NOT NULL REFERENCES trfs(id) ON DELETE CASCADE,
  action                TEXT NOT NULL CHECK (action IN ('LOCKED', 'UNLOCKED')),
  locked_by             INTEGER REFERENCES employees(id),
  unlocked_by           INTEGER REFERENCES employees(id),
  locked_at             TIMESTAMPTZ,
  unlocked_at           TIMESTAMPTZ,
  lock_reason           TEXT,
  unlock_reason         TEXT,
  changed_by            INTEGER NOT NULL REFERENCES employees(id),
  changed_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trf_lock_history_trf ON trf_lock_history (trf_id);
CREATE INDEX IF NOT EXISTS idx_trf_lock_history_changed_by ON trf_lock_history (changed_by);