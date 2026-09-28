-- SHIP IT — PostgreSQL schema (Phase 2 storage backend)
-- The v0.1 slice persists each game as a JSON snapshot through the Storage
-- interface (server/src/state.ts). This DDL is the migration target when the
-- game goes multi-user / hosted; the Storage interface is the seam.

CREATE TABLE IF NOT EXISTS players (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  handle        TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS games (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id     UUID NOT NULL REFERENCES players(id),
  company_name  TEXT NOT NULL,
  founder       TEXT NOT NULL,
  mode          TEXT NOT NULL DEFAULT 'career',      -- tutorial | career | sandbox | challenge
  status        TEXT NOT NULL DEFAULT 'active',      -- active | archived | bankrupt
  sim_day       INTEGER NOT NULL DEFAULT 1,
  sim_minute    INTEGER NOT NULL DEFAULT 480,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS game_snapshots (          -- full world blob for fast resume
  game_id       UUID PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  world         JSONB NOT NULL,                      -- serialized World (hosts, docker, ci, …)
  saved_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS resources (               -- denormalized infra inventory (costs, map)
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id       UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                       -- vm | managed_db | dns_zone | bucket | cluster …
  provider      TEXT NOT NULL DEFAULT 'stratus',
  region        TEXT NOT NULL DEFAULT 's1-east',
  label         TEXT NOT NULL,
  spec          JSONB NOT NULL DEFAULT '{}',
  monthly_cost  NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS mission_progress (
  game_id       UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  mission_id    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'in_progress', -- locked | in_progress | completed
  rating        CHAR(1),                             -- S | A | B | C
  hints_used    INTEGER NOT NULL DEFAULT 0,
  attempts      INTEGER NOT NULL DEFAULT 0,
  completed_at  TIMESTAMPTZ,
  PRIMARY KEY (game_id, mission_id)
);

CREATE TABLE IF NOT EXISTS incidents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id       UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                       -- disk_full | bad_deploy | db_saturation …
  title         TEXT NOT NULL,
  opened_at     TIMESTAMPTZ NOT NULL,
  resolved_at   TIMESTAMPTZ,
  severity      TEXT NOT NULL DEFAULT 'SEV2',
  customer_impact TEXT,
  root_cause    TEXT,
  timeline      JSONB NOT NULL DEFAULT '[]',         -- [{t, actor, text}]
  corrective_actions JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS deployments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id       UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  service       TEXT NOT NULL,
  image         TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'ci',          -- ci | manual | rollback
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  rolled_back_to UUID
);

CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGSERIAL PRIMARY KEY,
  game_id       UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  sim_t         BIGINT NOT NULL,                     -- absolute sim minute
  actor         TEXT NOT NULL,                       -- player | system | engineer-name
  kind          TEXT NOT NULL,                       -- deploy | alert | incident | command | economy …
  text          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_game_t ON audit_log (game_id, sim_t);

CREATE TABLE IF NOT EXISTS metrics_hourly (          -- rolled-up series for charts
  game_id       UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  metric        TEXT NOT NULL,                       -- req_rate | error_pct | p95_ms | cpu_pct | db_cpu | disk_pct …
  bucket_start  TIMESTAMPTZ NOT NULL,
  avg_val       DOUBLE PRECISION NOT NULL,
  max_val       DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (game_id, metric, bucket_start)
);

CREATE TABLE IF NOT EXISTS costs_daily (
  game_id       UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  day           INTEGER NOT NULL,
  category      TEXT NOT NULL,                       -- compute | database | storage | network | monitoring
  amount        NUMERIC(10,2) NOT NULL,
  PRIMARY KEY (game_id, day, category)
);

CREATE TABLE IF NOT EXISTS skills (
  player_id     UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  skill         TEXT NOT NULL,                       -- linux | git | docker | cicd | databases | …
  xp            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, skill)
);
