-- ============================================================
-- Partner Brain — Migration 003: Vector search RPC
-- ============================================================

-- Funkce pro semantic search nad brain_items
CREATE OR REPLACE FUNCTION match_brain_items(
  query_embedding  vector(1536),
  match_count      int     DEFAULT 5,
  match_threshold  float   DEFAULT 0.65
)
RETURNS TABLE (
  id          uuid,
  content     text,
  metadata    jsonb,
  similarity  float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    brain_items.id,
    brain_items.content,
    brain_items.metadata,
    1 - (brain_items.embedding <=> query_embedding) AS similarity
  FROM brain_items
  WHERE brain_items.user_id = 'local'
    AND 1 - (brain_items.embedding <=> query_embedding) > match_threshold
  ORDER BY brain_items.embedding <=> query_embedding
  LIMIT match_count;
$$;
