# Changelog

## 0.1.1 — 2026-10-11

- Deny admission if the collector pauses inside the SQLite admission transaction.
- Block UTC rollover while a prior-day request remains PENDING (not only UNKNOWN).
- Limit SSE frame buffering and reject unsupported request Content-Type.
- Prevent overlapping collector processes with a separate filesystem lock.
- Add regression tests (including separate-OS-process quota race), deterministic dependency versions/lockfile, and `npm ci` CI.
- Production use remains NO-GO pending real account eligibility and billing reconciliation.

## 0.1.0 — 2026-10-11

- Initial security-focused OSS technical preview.
- Text-only Responses JSON/SSE, guarded reservations and settlement, SQLite WAL ledger, persistent unknown outcomes.
- Independent paginated Usage API collector, read-only quota/status endpoints, explicit safety attestations, deterministic mock tests.
- No real account billing audit; no verified Chat counter; no production Go approval.
