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
| 9 Collector API unavailable/pagination | PASS mock | Fail closed on incomplete pages |
| 10 Watermark regression | PASS | Unit rejection |
| 11 UTC midnight rollover | PARTIAL | Prior-day PENDING/UNKNOWN blocks next day; live-edge test pending |
| 12 Restart/busy/full/corrupt SQLite | PARTIAL | Restart recovery and corrupt-file denial tested; busy/full fault injection pending |
| 13 Unknown model/tools/paid features | PASS | Strict request allowlist |
| 14 Chat n>1 / unknown counter | PASS deny-only | Full Chat compatibility intentionally unavailable |
| 15 Data Sharing eligibility revoked | PARTIAL | Manual attestation expiry; no auto API verification |
| 16 Auth/host/header/path restrictions | PARTIAL | Auth and path/header mock tests; hostile remote origin test pending |
| 17 OMP fallback | DEMO ONLY | Provider contract; real OMP integration pending |
| 18 Uncontrolled org traffic | PASS mock | Reject foreign-project usage; operator exclusivity still needed |
| 19 Billing dashboard reconciliation | NOT RUN | Needs real audited eligible project, human verification |
| 20 Fault tracking + recovery | PARTIAL | Fail closed/UNKNOWN; reviewed manual recovery SOP only |

**Release classification:** `v0.1.1` OSS technical preview. **NO-GO production quota/billing assurance**, including unverified free counter billing. Do not interpret mock test passing as production activation approval.
