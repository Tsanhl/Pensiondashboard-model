CREATE TABLE IF NOT EXISTS public_facts (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  label TEXT NOT NULL,
  value_json JSONB NOT NULL,
  unit TEXT,
  operator TEXT,
  condition_text TEXT,
  jurisdiction TEXT NOT NULL,
  valid_from DATE NOT NULL,
  valid_to DATE NOT NULL,
  source_url TEXT NOT NULL,
  source_section TEXT,
  last_verified_at DATE NOT NULL,
  review_cycle_days INTEGER NOT NULL DEFAULT 7,
  status TEXT NOT NULL DEFAULT 'active',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_public_facts_validity ON public_facts(valid_from, valid_to, status);
CREATE INDEX IF NOT EXISTS idx_public_facts_topic ON public_facts USING gin(to_tsvector('english', topic || ' ' || label));
