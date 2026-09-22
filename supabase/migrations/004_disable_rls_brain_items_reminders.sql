-- Brain items and reminders are accessed only via the ai-gateway service role.
-- RLS is disabled so the gateway's anon key can insert without per-user policies.
ALTER TABLE brain_items DISABLE ROW LEVEL SECURITY;
ALTER TABLE reminders  DISABLE ROW LEVEL SECURITY;
