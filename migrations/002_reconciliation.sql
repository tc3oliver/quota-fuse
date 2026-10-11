-- Applied after the additive anchor_tokens / phase column migrations. Existing
-- observations keep anchor_tokens NULL and cannot automatically resume service.
CREATE TABLE IF NOT EXISTS reconciliation_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL,
  operator TEXT NOT NULL,
  evidence TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(idempotency_key) REFERENCES reservations(idempotency_key)
);
