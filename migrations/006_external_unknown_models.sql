-- 006: external unknown-model diagnostics (additive only).
-- External-scope rows for models outside the reviewed official group map
-- are conservatively counted in the Premium external watermark (never
-- ignored, never assumed free). This table records which models were seen
-- so operators can review group mapping and eligibility. Day-scoped,
-- CREATE TABLE IF NOT EXISTS so reopening is a no-op. Never backfilled.
CREATE TABLE IF NOT EXISTS external_unknown_models (
  utc_day TEXT NOT NULL,
  model TEXT NOT NULL,
  group_name TEXT NOT NULL CHECK(group_name IN ('premium','economy')),
  tokens INTEGER NOT NULL CHECK(tokens >= 0),
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  PRIMARY KEY (utc_day, model)
);
