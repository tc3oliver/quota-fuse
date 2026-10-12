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
| 11 UTC midnight rollover | PASS mock | Window-overlapping DISPATCHED PENDING/UNKNOWN carries into new-day `effective_used`; PREFLIGHT-phase and window-expired rows carry nothing; admit unblocked; history preserved |
| 12 Restart/busy/full/corrupt SQLite | PARTIAL | Restart recovery and corrupt-file denial tested; busy/full fault injection pending |
| 13 Unknown model/tools/paid features | PASS | Strict request allowlist |
| 14 Chat n>1 / unknown counter | PASS deny-only | Full Chat compatibility intentionally unavailable |
| 15 Data Sharing eligibility revoked | PARTIAL | Manual attestation expiry; no auto API verification |
| 16 Auth/host/header/path restrictions | PARTIAL | Auth and path/header mock tests; hostile remote origin test pending |
| 17 OMP fallback | DEMO ONLY | Provider contract; real OMP integration pending |
| 18 Uncontrolled org traffic | PASS mock | External scope recorded, whitelist bypassed for external models, unknown models conservative + diagnostics, admission tightened; collection never stops; shared routing-project usage absorbed conservatively, no tripwire |
| 18a External unknown models counted bilaterally | PASS mock | Formula `official_proxy + official_external_known + unknown_external + outstanding + settled + cross_day_carry + reserve`; known models never double-counted; safe-int overflow fails closed |
| 18b Shared routing project absorbed | PASS mock | Local settled/outstanding added in full on top of official usage, never netted; uncertain tokens double-deducted, never increasing capacity; legacy `PROXY_PROJECT_SHARED` pauses auto-clear on next trusted publish |
| 18c Cross-day lifecycle carry | PASS mock | Only DISPATCHED-phase PENDING/UNKNOWN/MANUAL_REVIEW with `admitted_at ≥ day-00:00Z − 155000ms` carries into new-day same-group `effective_used`; PREFLIGHT-phase and window-expired rows carry nothing; admit/gate unblocked; history + idempotency preserved; optional dispatched-day review narrows only proven DISPATCHED UNKNOWN |
| 18d Mixed-traffic no-undercount | PASS mock | Settled-unreflected + foreign same-project + official increment counted additively (counterexample: 100+100+100 → 200+reserve); reflected settled double-deducted (safe direction) |
| 18e Three-day window simulation | PASS mock | DISPATCHED UNKNOWN carries on window-overlapping day, expires after `EXECUTION_WINDOW_MS`; history/idempotency retained, never re-sent or forged COMPLETED |
| 19 Billing dashboard reconciliation | NOT RUN | Needs real audited eligible project, human verification |
| 20 Fault tracking + recovery | PARTIAL | Fail closed/UNKNOWN; reviewed manual recovery SOP only |

**Release classification:** `v0.1.1` OSS technical preview. **NO-GO production quota/billing assurance**, including unverified free counter billing. Do not interpret mock test passing as production activation approval.

Admin usage and initial-day baseline are **conditionally trusted only**; no mock test verifies delayed upstream reporting. See [billing-validation.md](billing-validation.md). `estimated_remaining` is a conservative admission estimate, not an official free-balance promise; unbounded external traffic cannot guarantee zero fees.

### Organization-shared accounting (mock-covered)

External-scope recording, `effective_used` formula, fully-additive local
commitments, delayed catch-up monotonicity,
atomic multi-reservation races under external load, failure-then-retry
collection, recoverable auto-recovery vs sticky `MANUAL_HOLD`, per-scope
regression refusal, unknown-model/unattributable refusal, windowed lifecycle
carry with UNKNOWN retention, restart/migration/legacy
compatibility, `/quota` null-on-untrusted shape, saturation denial, and the
unchanged FREE_ONLY/OMP error contract are covered by
`tests/unit/shared-quota.test.ts` and
`tests/fault-injection/shared-collector.test.ts` (mock only). Shared
routing-project absorption, external
unknown-model diagnostics, delayed partial reflection, cross-day carry,
and the policy auto-upgrade (history/idempotency preserving) are
covered by `tests/unit/dedication-migration.test.ts`. Lifecycle-carry
(PREFLIGHT never carried, window expiry, mixed-traffic additivity) is
covered by `tests/fault-injection/unattended-lifecycle.test.ts`.

### Incomplete generation accounting

Mock integration coverage includes valid `incomplete/max_output_tokens`
terminal receipts for JSON, Responses SSE and Chat compatibility; strict
usage validation, persisted incomplete settlement evidence, duplicate replay
denial, bounded reservation overrun, malformed-stream UNKNOWN retention and
legacy UNKNOWN immutability. This changes **future** accounting behavior only,
not any existing production ledger row.
