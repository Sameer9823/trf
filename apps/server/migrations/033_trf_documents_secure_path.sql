-- Migration 033: Secure TRF document storage
-- Replace client-supplied file_path with server-generated relative_path
-- The server generates the filename and stores files under DOCUMENT_DIR

-- 1. Add relative_path column (server-generated, relative to DOCUMENT_DIR)
ALTER TABLE trf_documents
  ADD COLUMN IF NOT EXISTS relative_path TEXT;

-- 2. For existing rows, extract just the filename from file_path as relative_path
-- This assumes existing files are directly under DOCUMENT_DIR
UPDATE trf_documents
SET relative_path = CASE
  WHEN file_path LIKE '%/%' THEN split_part(file_path, '/', -1)
  WHEN file_path LIKE '%\%%' THEN split_part(file_path, '\', -1)
  ELSE file_path
END
WHERE relative_path IS NULL AND file_path IS NOT NULL;

-- 3. Make relative_path NOT NULL for future rows
ALTER TABLE trf_documents
  ALTER COLUMN relative_path SET NOT NULL;

-- 4. Drop the old file_path column (it was a security risk: client-controlled absolute path)
ALTER TABLE trf_documents
  DROP COLUMN IF EXISTS file_path;

-- 5. Add a check constraint to ensure relative_path has no directory traversal
ALTER TABLE trf_documents
  ADD CONSTRAINT chk_trf_documents_relative_path_no_traversal
  CHECK (relative_path NOT LIKE '%/%' AND relative_path NOT LIKE '%\%%' AND relative_path NOT LIKE '%..%');

-- 6. Update the unique index to use the new column name (already on trf_id, version)
-- No change needed for uq_trf_documents_trf_version

-- Comment: The server now generates the filename (e.g., "<trfId>-v<version>-<random>.pdf")
-- and stores it under DOCUMENT_DIR. The client never supplies a path or filename.
-- On download, the server resolves relative_path against DOCUMENT_DIR and verifies
-- the resolved path stays inside DOCUMENT_DIR before streaming.