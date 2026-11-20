-- Migration 019: TRF generated documents (PDFs)
-- Stores the final approved PDF for each TRF so it remains accessible after restart.

CREATE TABLE IF NOT EXISTS trf_documents (
  id              BIGSERIAL PRIMARY KEY,
  trf_id          INTEGER NOT NULL REFERENCES trfs(id) ON DELETE CASCADE,
  file_path       TEXT NOT NULL,
  file_name       TEXT NOT NULL,
  file_size       BIGINT,
  mime_type       TEXT NOT NULL DEFAULT 'application/pdf',
  version         INTEGER NOT NULL DEFAULT 1,
  generated_by    INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status          TEXT NOT NULL DEFAULT 'generated'
    CHECK (status IN ('generated', 'failed', 'regenerated')),
  error_message   TEXT
);
CREATE INDEX IF NOT EXISTS idx_trf_documents_trf ON trf_documents (trf_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_trf_documents_status ON trf_documents (status) WHERE status = 'failed';

-- Only one generated document per TRF per version (the approved version)
CREATE UNIQUE INDEX IF NOT EXISTS uq_trf_documents_trf_version
  ON trf_documents (trf_id, version) WHERE status IN ('generated', 'regenerated');

-- Comment: When a TRF is approved and locked, a PDF is generated and stored here.
-- If the TRF is reopened and re-approved (version increments), a new document is created.
-- The old document is preserved for audit trail.