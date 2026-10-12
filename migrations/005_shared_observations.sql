-- 005: organization-aware shared-quota observations (additive only).
-- The org complimentary pool is shared with production services that bypass
-- the proxy. Each day/group row now tracks proxy-scope and external-scope
-- official usage separately, plus poll diagnostics. All new columns are
-- nullable: pre-existing rows get NULL external usage (= unknown) and stay
-- fail-closed until a trusted new observation arrives. Never backfill,
-- delete, or reinterpret history here.
ALTER TABLE observations ADD COLUMN official_external INTEGER CHECK(official_external >= 0);
ALTER TABLE observations ADD COLUMN last_poll_attempt TEXT;
ALTER TABLE observations ADD COLUMN last_poll_error TEXT;
