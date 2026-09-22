-- ============================================================
-- Partner Brain — Migration 002: Brain v1
-- Bilateral commitment tracking + brain embeddings + reminders
-- ============================================================

-- Enable pgvector (requires Supabase with vector extension)
CREATE EXTENSION IF NOT EXISTS vector;

-- ── Upgrade existing commitments table ───────────────────────────────────
-- Add bilateral direction + person_id FK + urgency + richer status

ALTER TABLE commitments
  ADD COLUMN IF NOT EXISTS direction    TEXT NOT NULL DEFAULT 'outbound'
    CHECK (direction IN ('outbound', 'inbound')),
  ADD COLUMN IF NOT EXISTS person_id    UUID REFERENCES people(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS urgency      INT  NOT NULL DEFAULT 50
    CHECK (urgency BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS source       TEXT DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ NOT NULL DEFAULT now();

-- Align status values (existing: active|fulfilled|broken|cancelled → pending|done|overdue|dismissed)
-- We keep backward compat: existing rows stay valid, new rows use new values
ALTER TABLE commitments DROP CONSTRAINT IF EXISTS commitments_status_check;
ALTER TABLE commitments
  ADD CONSTRAINT commitments_status_check
  CHECK (status IN ('pending', 'done', 'overdue', 'dismissed', 'active', 'fulfilled', 'broken', 'cancelled'));

-- ── Brain items — searchable knowledge with embeddings ───────────────────
CREATE TABLE IF NOT EXISTS brain_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL DEFAULT 'local',
  capture_id  UUID REFERENCES capture_events(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  embedding   vector(1536),           -- text-embedding-3-small
  metadata    JSONB DEFAULT '{}',     -- {people:[], date:, topics:[], source:}
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- HNSW index for fast approximate nearest-neighbor search
CREATE INDEX IF NOT EXISTS brain_items_embedding_idx
  ON brain_items
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS brain_items_user_idx
  ON brain_items(user_id, created_at DESC);

-- ── Reminders ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reminders (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        TEXT NOT NULL DEFAULT 'local',
  commitment_id  UUID REFERENCES commitments(id) ON DELETE CASCADE,
  scheduled_at   TIMESTAMPTZ NOT NULL,
  sent_at        TIMESTAMPTZ,
  type           TEXT NOT NULL DEFAULT 'deadline_approaching'
    CHECK (type IN ('deadline_approaching', 'overdue', 'follow_up'))
);

CREATE INDEX IF NOT EXISTS reminders_scheduled_idx
  ON reminders(user_id, scheduled_at)
  WHERE sent_at IS NULL;

-- ── People: add aliases array ─────────────────────────────────────────────
ALTER TABLE people
  ADD COLUMN IF NOT EXISTS aliases TEXT[] DEFAULT '{}';

-- ── Indexes ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_commitments_direction
  ON commitments(user_id, direction, status);

CREATE INDEX IF NOT EXISTS idx_commitments_person
  ON commitments(person_id) WHERE person_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_commitments_due
  ON commitments(due_date) WHERE due_date IS NOT NULL AND status = 'pending';
