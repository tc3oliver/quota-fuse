## Unreleased

- Redesign QuotaFuse as an organization-aware shared quota guard: the org complimentary pool is shared with production services that bypass the proxy. The collector queries full-organization usage every 120s, splits proxy vs external scope per group, and keeps polling under every proxy state; external consumption tightens admission instead of pausing collection. Admission uses `effective_used = official_external + max(official_proxy, verified_proxy_baseline + proxy_local_committed) + external_safety_reserve` with a new required per-group `policy.externalSafetyReserve` bound (fingerprinted; old ledgers cut over via the runbook, never by deleting SQLite). New `/quota` fields (`official_org/external/proxy_usage`, `proxy_local_committed`, `effective_used`, poll timestamps, `pause_reason`, detailed `READY/EXHAUSTED/STALE/DATA_UNVERIFIED/MANUAL_HOLD` states; null when untrusted, never fabricated zero). Additive migration `005_shared_observations.sql`; legacy rows stay fail-closed until a trusted shared baseline. The `UNACCOUNTED_OFFICIAL_USAGE` invariant and the exclusive-org-traffic admission gate are removed; `ACTUAL_EXCEEDS_RESERVED`, watermark regression, unverified baselines and manual holds stay sticky, recoverable pauses auto-clear on trusted success. Docs updated (README, SPEC, runbook, billing-validation, deployment, test-matrix); 21 new mock tests in `shared-quota` + `shared-collector` suites.

- Add stateless multi-turn Responses text and bounded Chat text compatibility via Responses preflight.
- Add client-owned function call/output support under existing quota gates; structured JSON retains a separate, default-off billing gate. Hosted tools remain blocked.

- Add an idempotent `npm run setup` to create private config and separate proxy/collector credentials, plus local start/status scripts.
- Rewrite README for installation and end users; move development details to `docs/development.md` and add deployment/API guides.


- Configure selected Data Sharing project and organization tier (`build`, `launch`, `grow`) explicitly. Reject limits above verified tier entitlements, retain project/tier in policy fingerprint, and document migration from `upstream.projectId`.

- Review hardening: reject unexplained official token overages, preserve a sticky pause on usage-bound violations, recheck attestation after preflight, and require completed response status before settlement.

- Keep the first daily Admin Usage observation as a guarded baseline and count post-baseline local usage without double counting; unknown legacy anchors remain paused.
- Split preflight-only versus dispatched reservation phases, atomically shrink trusted provisional reservations and add audited, offline, preflight-only reconciliation.
- Make quota CLI genuinely read-only; document Admin Usage limitations, real-billing validation and upgrade recovery.

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
