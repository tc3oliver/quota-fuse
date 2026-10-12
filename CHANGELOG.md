## Unreleased

- Live billing experiment (PROVISIONAL_PASS): 2026-10-12 real-API local-function-calling
  evidence on `gpt-4.1-mini-2025-04-14` — operational PASS, usage incentive-tier VERIFIED
  for function-call generation and tool-loop continuation, preflight zero-usage, proxy loop
  settles correctly, hosted tools still rejected. Final Costs reconciliation PENDING with
  operator-accepted residual risk (tested local-function shapes only); status upgrades or
  corrects when the Costs followup lands.
- Unknown models counted bilaterally in ANY project: proxy-scope group-unconfirmed rows no longer fall back to premium-only (that undercounted Economy). They leave per-group sums untouched, land in `external_unknown_models` diagnostics, and bind both groups' estimates. Legacy operator-listed groupings unchanged; known models classified exactly once.
- Eligibility expiry stays fail-closed with a 72h `ELIGIBILITY_ATTESTATION_EXPIRING` warning: no programmatic Data Sharing enrollment check exists (verified against the Admin/Usage API surface), so the date cannot auto-extend and unknown eligibility is never assumed free. Layered protection documented instead: one-time attestation, fingerprint-bound project/tier, continuous usage monitoring, Dashboard costs review.
- Lifecycle carry: `crossDayCarry` counts only DISPATCHED-phase prior-day unresolved reservations (PENDING/UNKNOWN/MANUAL_REVIEW, reviewed-day exemption aside) with `admitted_at ≥ day-00:00Z − 155000ms`. PREFLIGHT-phase rows provably consumed zero and never carry; window-overlapping days keep the full reserve (timeout alone releases nothing); only the daily deduction expires on window proof, history/idempotency preserved.
- Additive formula: `effective_used = official_proxy + official_external_known + unknown_external + outstanding + settled + cross_day_carry + reserve`. Official increments are never proof of local reflection (mixed-traffic counterexample: settled-unreflected 100 + foreign 100 + official 100 → 200 + reserve); reflected settled is double-deducted at deliberate utilization cost. `proxy_unreflected_tokens` snapshot field removed.
- Collector/admission whitelist separation: the whitelist (`policy.classify`, unchanged) gates Proxy admission only; no out-of-whitelist model on any project stops the Collector — all usage classifies via the reviewed official group map, unmapped models go to diagnostics.
- Execution-window constants: `EXECUTION_WINDOW_MS` = 30000 (`PREFLIGHT_TIMEOUT_MS`) + 120000 (`UPSTREAM_TIMEOUT_MS`) + 5000 (clock skew) in `src/config.ts`, enforced by real aborts in `server.ts` — a locally enforceable bound, not an assumed official-delay bound or arbitrary TTL. Residual risk stated: provider-side continuation after client abort possible (`store:false` abort-as-cancel is a documented assumption).

- Cross-day UNKNOWN auto-carry: prior-day unresolved reservations (PENDING/UNKNOWN/MANUAL_REVIEW) no longer block admit/prepareDispatch/gate; their full `reserved` auto-counts into the new day's same-group `effective_used` (`cross_day_carry`). History and idempotency preserved — never re-sent, forged COMPLETED, or deleted. The `reviewDispatchedDay` review (with 24h cooldown) is now an optional conservative narrowing tool for proven DISPATCHED UNKNOWN only; daily recovery needs no review or cooldown.
- Gate witness simplification: one-time setup checks only (non-placeholder projectId, valid `eligibilityAttestedUntil`, `OPENAI_API_KEY`/`QG_PROXY_TOKEN` present, unpaused, `preflightCostVerified` with `inputCounter='responses_preflight'`, conditional dual-group snapshots). `proxyProjectDedicatedAttestedUntil` / `manualCostsAuditedUntil` / `exclusiveOrgTrafficAttestedUntil` kept for compatibility only — no longer gates, no periodic re-attestation.
- Collector auto-recovery: `UNACCOUNTED_OFFICIAL_USAGE`, `PROXY_PROJECT_SHARED` and `ANCHOR_UNVERIFIED` are recoverable (legacy pauses auto-clear on the next complete trusted publish); only true data corruption (`ACTUAL_EXCEEDS_RESERVED`, `OFFICIAL_WATERMARK_REGRESSION`) stays sticky. The `PROXY_PROJECT_SHARED` tripwire is removed; the routing project may be shared, with overages absorbed conservatively.
- New admission formula: `effective_used = official_proxy + official_external_known + unknown_external + outstanding + max(0, anchor + settled − official_proxy) + cross_day_carry + reserve`. No project-dedication premise; uncertain tokens are double-deducted rather than ever increasing admissible capacity.
- Painless upgrade: `verifyPolicy` auto-advances a stored fingerprint that differs only by the `reserve` addition, writing an idempotent, verifiable auto-upgrade audit row. Swapping DB files remains a last resort.
- Count external unknown-model tokens bilaterally as a conservative bound: new formula `effective_used = official_external_known + unknown_external + max(official_proxy, verified_proxy_baseline + proxy_local_committed) + external_safety_reserve`, where `unknown_external` is the single group-independent same-day total counted into both Premium and Economy `effective_used`. Confirmed groups are never double-subtracted; diagnostics retained; safe-int overflow yields `INVALID_USAGE` fail-closed.
- Keep the `PROXY_PROJECT_SHARED` tripwire tight with no tolerance: `/responses/input_tokens` preflight official attribution cannot be confirmed (no real paid-API verification), so preflight usage attributed to the routing project can also trip it. Diagnostics point at both project sharing and preflight attribution; the runbook lists preflight attribution as a排查 item with no verified-safe claim. Collector stays on the 120s poll interval. `scripts/status.mjs` reflects both hypotheses in the `PROXY_PROJECT_SHARED` pause detail.
- Separate the admission whitelist (proxy scope only) from org-usage classification (always the reviewed official group map): external models outside the whitelist classify normally, officially-unknown external models are recorded with diagnostics and counted bilaterally (see above) and pause nothing. Proxy-project rows outside a populated whitelist fail closed as a dedication signal.
- Require a dedicated routing project: new expiring `policy.proxyProjectDedicatedAttestedUntil` admission gate (proxy-project scoped, not org-wide) plus a sticky `PROXY_PROJECT_SHARED` runtime tripwire when proxy-scope official usage exceeds the local upper bound. Without dedication evidence, `max()`-dedup is not claimed and admission fails closed.
- Audited in-place shared-accounting migration (`npm run accounting:shared-migration`): advances only the policy fingerprint with an audit row after proving the stored policy differs solely by the reserve addition; reservations, UNKNOWN/PENDING, observations, idempotency keys and pause state untouched. New-DB swaps documented as last resort with explicit idempotency risks. Additive migration `006_external_unknown_models.sql`.

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
