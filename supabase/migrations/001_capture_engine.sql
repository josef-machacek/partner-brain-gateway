-- ============================================================
-- Partner OS — Capture Engine
-- Migration 001: capture_events, actions, decisions, people,
--                projects_memory, commitments
-- ============================================================

-- Immutable raw inputs — everything that enters Partner
CREATE TABLE IF NOT EXISTS capture_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT NOT NULL DEFAULT 'local',
  type          TEXT NOT NULL,   -- text | voice | email | slack | telegram | github | ...
  source        TEXT NOT NULL,   -- manual | partner_voice | gmail | slack | ...
  raw           TEXT NOT NULL,   -- original input, never modified
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- AI classification output — linked 1:1 to capture_event
CREATE TABLE IF NOT EXISTS capture_analyses (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  capture_id       UUID NOT NULL REFERENCES capture_events(id) ON DELETE CASCADE,
  category         TEXT NOT NULL,  -- ACTION | NOTE | IDEA | DECISION | COMMITMENT | WAITING | FOLLOW_UP | RISK | PROJECT_UPDATE
  title            TEXT NOT NULL,  -- short human label
  summary          TEXT,
  priority_score   INT DEFAULT 50 CHECK (priority_score BETWEEN 0 AND 100),
  priority_reason  TEXT,
  project_hint     TEXT,
  person_hints     TEXT[],         -- names extracted from raw
  due_date         TIMESTAMPTZ,
  status           TEXT DEFAULT 'inbox',  -- inbox | active | done | dismissed
  reviewed         BOOLEAN DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Actionable items (from capture or manual)
CREATE TABLE IF NOT EXISTS actions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT NOT NULL DEFAULT 'local',
  capture_id      UUID REFERENCES capture_events(id),
  title           TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | active | waiting | done | cancelled
  priority_score  INT DEFAULT 50 CHECK (priority_score BETWEEN 0 AND 100),
  priority_reason TEXT,
  due_date        TIMESTAMPTZ,
  remind_at       TIMESTAMPTZ,
  reminded        BOOLEAN DEFAULT false,
  project_id      UUID,  -- FK after projects_memory created
  person_id       UUID,  -- FK after people created
  company_id      TEXT,
  postpone_count  INT DEFAULT 0,
  last_activity   TIMESTAMPTZ DEFAULT now(),
  meeting_id      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Committed promises ("I'll send it by Friday")
CREATE TABLE IF NOT EXISTS commitments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL DEFAULT 'local',
  capture_id  UUID REFERENCES capture_events(id),
  title       TEXT NOT NULL,
  to_person   TEXT,         -- who I committed to
  due_date    TIMESTAMPTZ,
  status      TEXT NOT NULL DEFAULT 'active',  -- active | fulfilled | broken | cancelled
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Key decisions made
CREATE TABLE IF NOT EXISTS decisions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL DEFAULT 'local',
  capture_id  UUID REFERENCES capture_events(id),
  meeting_id  UUID,
  title       TEXT NOT NULL,
  context     TEXT,
  outcome     TEXT,
  rationale   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- People memory (context about contacts)
CREATE TABLE IF NOT EXISTS people (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          TEXT NOT NULL DEFAULT 'local',
  name             TEXT NOT NULL,
  email            TEXT,
  phone            TEXT,
  company          TEXT,
  role             TEXT,
  last_contact     TIMESTAMPTZ,
  notes            TEXT,
  open_commitments INT DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Project context memory
CREATE TABLE IF NOT EXISTS projects_memory (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT NOT NULL DEFAULT 'local',
  name         TEXT NOT NULL,
  description  TEXT,
  status       TEXT DEFAULT 'active',  -- active | paused | done | archived
  company_id   TEXT,
  last_activity TIMESTAMPTZ DEFAULT now(),
  open_actions  INT DEFAULT 0,
  risks         TEXT[],
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Daily missions (computed each morning)
CREATE TABLE IF NOT EXISTS daily_missions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT NOT NULL DEFAULT 'local',
  date          DATE NOT NULL,
  mission_text  TEXT,           -- one-sentence mission for the day
  top3          JSONB DEFAULT '[]',  -- [{action_id, title, estimated_minutes, reason}]
  quick_wins    JSONB DEFAULT '[]',  -- [{title, minutes}]
  capacity_min  INT,            -- available minutes after meetings
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, date)
);

-- ── Indexes ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_capture_events_user    ON capture_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_capture_analyses_cap   ON capture_analyses(capture_id);
CREATE INDEX IF NOT EXISTS idx_capture_analyses_status ON capture_analyses(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_actions_user_status    ON actions(user_id, status, priority_score DESC);
CREATE INDEX IF NOT EXISTS idx_actions_due            ON actions(due_date) WHERE due_date IS NOT NULL AND status != 'done';
CREATE INDEX IF NOT EXISTS idx_commitments_status     ON commitments(user_id, status);
CREATE INDEX IF NOT EXISTS idx_daily_missions_date    ON daily_missions(user_id, date DESC);
