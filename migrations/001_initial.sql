PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS reservations (
  idempotency_key TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  body_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  group_name TEXT NOT NULL CHECK(group_name IN ('premium','economy')),
  utc_day TEXT NOT NULL,
  reserved INTEGER NOT NULL CHECK(reserved > 0),
  actual INTEGER CHECK(actual >= 0),
  state TEXT NOT NULL CHECK(state IN ('PENDING','COMPLETED','UNKNOWN','RECONCILED','MANUAL_REVIEW')),
  admitted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reservations_day_group ON reservations(utc_day, group_name, state);
CREATE TABLE IF NOT EXISTS observations (
  utc_day TEXT NOT NULL,
  group_name TEXT NOT NULL,
  official_high_watermark INTEGER NOT NULL CHECK(official_high_watermark >= 0),
  reconciled_at TEXT NOT NULL,
  PRIMARY KEY(utc_day, group_name)
);

CREATE TABLE IF NOT EXISTS guard_control (id INTEGER PRIMARY KEY CHECK(id=1), paused_reason TEXT);
INSERT OR IGNORE INTO guard_control(id,paused_reason) VALUES(1,'COLLECTOR_NOT_VERIFIED');
CREATE TABLE IF NOT EXISTS policy_fingerprint (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  sha256 TEXT NOT NULL
);
