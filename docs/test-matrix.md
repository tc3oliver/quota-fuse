# Acceptance / security verification matrix

All automated tests use mock upstream responses; no live billing calls are made.

| SPEC §12 | Status | Evidence / gap |
| --- | --- | --- |
| 1–2 Premium / economy caps | PASS | Unit caps at 850K / 8.5M |
| 3 Concurrent quota race | PASS mock multi-process | In-process and two independent OS-process race tests; sustained load pending |
| 4 No upstream before denied admission | PASS | Integration call counter |
| 5 JSON/SSE final usage | PASS for Responses | Chat/SSE variants pending |
| 6 Client disconnect SSE | PASS mock | Explicit abort sets UNKNOWN before upstream stream ends |
| 7 Timeout/connection reset | PASS mock | UNKNOWN, no retry |
| 8 Duplicate idempotency key | PASS | 409, exactly one dispatch |
| 9 Collector API unavailable/pagination | PASS mock | Fail closed on incomplete pages; failures preserve checkpoint, next cycle still polls |
| 10 Watermark regression | PASS | Unit rejection per proxy/external scope; baseline + post-anchor local usage regression |
| 11 UTC midnight rollover | PARTIAL | Prior-day PENDING/UNKNOWN blocks next day; live-edge test pending |
| 12 Restart/busy/full/corrupt SQLite | PARTIAL | Restart recovery and corrupt-file denial tested; busy/full fault injection pending |
| 13 Unknown model/tools/paid features | PASS | Strict request allowlist |
| 14 Chat n>1 / unknown counter | PASS deny-only | Full Chat compatibility intentionally unavailable |
| 15 Data Sharing eligibility revoked | PARTIAL | Manual attestation expiry; no auto API verification |
| 16 Auth/host/header/path restrictions | PARTIAL | Auth and path/header mock tests; hostile remote origin test pending |
| 17 OMP fallback | DEMO ONLY | Provider contract; real OMP integration pending |
| 18 Uncontrolled org traffic | PASS mock | External scope recorded, whitelist bypassed for external models, unknown models conservative + diagnostics, admission tightened; collection never stops; in-project mixing trips sticky lock |
| 19 Billing dashboard reconciliation | NOT RUN | Needs real audited eligible project, human verification |
| 20 Fault tracking + recovery | PARTIAL | Fail closed/UNKNOWN; reviewed manual recovery SOP only |

**Release classification:** `v0.1.1` OSS technical preview. **NO-GO production quota/billing assurance**, including unverified free counter billing. Do not interpret mock test passing as production activation approval.

Admin usage and initial-day baseline are **conditionally trusted only**; no mock test verifies delayed upstream reporting. See [billing-validation.md](billing-validation.md). `estimated_remaining` is a conservative admission estimate, not an official free-balance promise; unbounded external traffic cannot guarantee zero fees.

### Organization-shared accounting (mock-covered)

External-scope recording, `effective_used` formula, no-double-count dedup via
`max()`, unreflected-reservation retention, delayed catch-up monotonicity,
atomic multi-reservation races under external load, failure-then-retry
collection, recoverable auto-recovery vs sticky `MANUAL_HOLD`, per-scope
regression refusal, unknown-model/unattributable refusal, UTC-day
independence with UNKNOWN retention, restart/migration/legacy
compatibility, `/quota` null-on-untrusted shape, saturation denial, and the
unchanged FREE_ONLY/OMP error contract are covered by
`tests/unit/shared-quota.test.ts` and
`tests/fault-injection/shared-collector.test.ts` (mock only). Project
dedication gating, the `PROXY_PROJECT_SHARED` tripwire, external
unknown-model diagnostics, delayed partial reflection, and the audited
in-place shared-accounting migration (history/idempotency preserving) are
covered by `tests/unit/dedication-migration.test.ts`.

### Incomplete generation accounting

Mock integration coverage includes valid `incomplete/max_output_tokens`
terminal receipts for JSON, Responses SSE and Chat compatibility; strict
usage validation, persisted incomplete settlement evidence, duplicate replay
denial, bounded reservation overrun, malformed-stream UNKNOWN retention and
legacy UNKNOWN immutability. This changes **future** accounting behavior only,
not any existing production ledger row.
