-- Migration 010: ARD remarks status column + product re-seed.
--
-- Adds ard_remarks_status to trfs for the ARD team's free-text remark field.
-- Also re-seeds the 19 standard products idempotently, so a database that was
-- created before the product seed migration gets the full catalog.
--
-- Never edit an applied migration; this one is additive and idempotent.

-- ARD remark status: tracks where the ARD remark note stands.
ALTER TABLE trfs ADD COLUMN IF NOT EXISTS ard_remarks_status TEXT NOT NULL DEFAULT 'Pending'
  CHECK (ard_remarks_status IN ('Pending', 'Sample Received', 'Under Analysis', 'Result Reported', 'Retest Required', 'On Hold', 'Completed'));

CREATE INDEX IF NOT EXISTS idx_trfs_ard_remarks_status ON trfs (ard_remarks_status);

-- Backfill existing rows so NULL columns get their default values.
UPDATE trfs SET ard_remarks_status = 'Pending' WHERE ard_remarks_status IS NULL;

-- Seed the 19 standard products. ON CONFLICT on the unique code column
-- makes the migration safe to re-run. Case-insensitive name uniqueness is
-- handled by a separate migration; here we guard the insert itself.
INSERT INTO products (name, code, description, is_active) VALUES
  ('CafRelExAct™', 'CAFRELEXC', 'Caffeine', TRUE),
  ('AsparExAct™', 'ASPARREXC', 'Aspartame', TRUE),
  ('NacExAct™ 85%', 'NACRELEXC', 'N-Acetyl Cysteine 85%', TRUE),
  ('AlphaExAct™ 75%', 'ALPHA75', 'Alpha-lipoic acid 75%', TRUE),
  ('AlphaExAct™ 15% (WS)', 'ALPHA15WS', 'Alpha-lipoic acid 15% water-soluble', TRUE),
  ('CarniExAct™', 'CARNIREXC', 'Carnitine', TRUE),
  ('ArginExAct™', 'ARGRELEXC', 'Arginine', TRUE),
  ('MetExAct™', 'METRELEXC', 'Methionine', TRUE),
  ('α-ketoExAct™', 'AKRELEXC', 'Alpha-ketoglutarate', TRUE),
  ('BranChExAct RD™', 'BRANCRELEXC', 'Branched-chain amino acids', TRUE),
  ('TelmiExAct™', 'TELMERELEXC', 'Telmisartan', TRUE),
  ('VitExAct™ B12 1%', 'VITB121', 'Vitamin B12 1%', TRUE),
  ('VitExAct™ B12 0.1%', 'VITB1201', 'Vitamin B12 0.1%', TRUE),
  ('CoQExAct™ 10%', 'COQ10', 'Coenzyme Q10 10%', TRUE),
  ('CoQExAct™ 20%', 'COQ20', 'Coenzyme Q10 20%', TRUE),
  ('CoQExAct™', 'COQRELEXC', 'Coenzyme Q10', TRUE),
  ('DHA ExAct™ : CWD', 'DHARELEXC', 'DHA in coconut water', TRUE),
  ('SoluExAct™ MCT : CWS', 'SOLUEXACTMCT', 'MCT oil water-soluble', TRUE),
  ('SoluExAct™ Orange : CWS', 'SOLUEXACTORANGE', 'Orange flavor water-soluble', TRUE)
ON CONFLICT (code) DO NOTHING;
