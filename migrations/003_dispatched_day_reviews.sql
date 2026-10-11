-- Immutable operator-reviewed exemption for a bounded prior-day dispatched UNKNOWN.
-- Reservation remains UNKNOWN and its full token reservation remains accounted.
CREATE TABLE IF NOT EXISTS dispatched_day_reviews (
 idempotency_key TEXT PRIMARY KEY REFERENCES reservations(idempotency_key),
 utc_day TEXT NOT NULL,
 reserved INTEGER NOT NULL CHECK(reserved > 0),
 terminal_observed_at TEXT NOT NULL,
 operator TEXT NOT NULL,
 evidence TEXT NOT NULL,
 reviewed_at TEXT NOT NULL
);

-- Group-accounting upgrades are explicit, on empty-new-day boundaries only.
CREATE TABLE IF NOT EXISTS accounting_migration_audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 operator TEXT NOT NULL,
 evidence TEXT NOT NULL,
 effective_utc_day TEXT NOT NULL,
 from_fingerprint TEXT NOT NULL,
 to_fingerprint TEXT NOT NULL,
 created_at TEXT NOT NULL
);
