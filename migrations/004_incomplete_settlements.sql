-- A terminal but truncated generation can have a final verified token count.
-- Accounting can be settled without representing the generation as successful.
-- Never backfill previously UNKNOWN reservations without independent audit.
CREATE TABLE IF NOT EXISTS incomplete_settlements (
  idempotency_key TEXT PRIMARY KEY REFERENCES reservations(idempotency_key),
  upstream_response_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason='max_output_tokens'),
  input_tokens INTEGER NOT NULL CHECK(input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK(output_tokens >= 0),
  total_tokens INTEGER NOT NULL CHECK(total_tokens = input_tokens + output_tokens),
  observed_at TEXT NOT NULL
);
