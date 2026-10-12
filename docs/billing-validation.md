# Billing validation (operator runbook)

QuotaFuse does **not** know the official remaining Data Sharing balance and cannot guarantee zero charges.

**Client-defined Function Calling:** Functions executed by the local agent (file, Bash, Git, or agent-managed MCP operations) do not incur separate OpenAI-hosted tool execution fees. Their definitions, arguments and responses still consume model tokens, and QuotaFuse applies the same model allowlist, input preflight, SQLite reservation and collector policy as for other text requests. The official Data Sharing exclusion for *tool use* does not explicitly clarify these native client-side function-call model tokens; the absence of hosted tool fees is **not** proof of complimentary model tokens. No extra function-specific attestation is required by QuotaFuse, but live inference remains subject to the general billing validation gates below. Hosted OpenAI tools continue to be rejected.


## Credentials and source of truth

- Proxy: `OPENAI_API_KEY` (dedicated `dataSharing.projectId`, generation and exact input preflight; server-controlled `OpenAI-Project` header).
- Collector: `OPENAI_ADMIN_KEY` (organization-wide `GET /v1/organization/usage/completions`, grouped by `model,project_id`, complete pagination). Run in a **separate process**. Never provide the Admin key to the Proxy.
- Client: `QG_PROXY_TOKEN`, a local bearer token.

Admin Usage includes aggregate input/output token usage, **not** real-time, atomically reserved, or incentive-only balances. Use official Dashboard **Data sharing incentive tier (input + output)** and Costs independently to verify eligibility and charges. A project Budget is not a guaranteed real-time hard stop.

## Verified first observation / baseline

The **first official observation** for a UTC day/group becomes a baseline only if no local reservation for that day/group exists. Admission then uses organization-shared accounting — official external usage, deduplicated proxy usage, and a conservative external reserve:

`effective_used = official_external + max(official_proxy, verified_proxy_baseline + proxy_local_committed) + external_safety_reserve`

`remaining = max(0, floor(daily_limit × safety_pct) − effective_used)`

- `official_external`: all other projects' cumulative usage in this group/day. External production services may legally bypass the proxy; their consumption is **expected and never an anomaly**. It only tightens admission. External rows are classified by the reviewed official group map only — the proxy admission whitelist never applies to them. External models outside that map are conservatively counted in Premium (never ignored, never assumed free) and recorded in `external_unknown_models` for operator review with explicit diagnostics.
- `max(official_proxy, baseline + committed)`: settled proxy tokens already reflected in the official aggregate are not double-counted, while locally committed but not-yet-visible proxy usage keeps its full reservation. The proxy project scope is the dedup boundary, and it is **only sound for a dedicated routing project** (see `proxyProjectDedicatedAttestedUntil`): foreign traffic inside the proxy project trips a sticky `PROXY_PROJECT_SHARED` pause instead of being laundered through `max()`. QuotaFuse never claims precise dedup when its project is shared.
- `external_safety_reserve`: operator-configured per-group bound (`policy.externalSafetyReserve`) for external consumption during official visibility delay plus the 120s poll interval. Estimate it as `peak external tokens/sec × (visibility delay + poll interval + margin)`. If no credible bound exists, keep the proxy paused. A fixed 0 is only valid with independently verified ~zero external traffic.
- `estimated_remaining` is a conservative admission estimate, **not** an official free-balance promise, and **not** a zero-fee guarantee under unbounded external traffic.

**Preconditions:** the routing project is dedicated to QuotaFuse (fresh `proxyProjectDedicatedAttestedUntil` with dated Dashboard evidence; other org projects remain free to share the pool), the proxy baseline covers all preceding proxy-scope usage before any local admission (the Admin API may lag), the entire usage read is complete (all pages, exact day bucket, model mapping matches the offer), and both proxy and external scopes have fresh observations within `reconcileMaxAgeSeconds`. Official totals above the local ledger are normal shared-pool consumption, not a pause trigger. Smaller delayed usage masked by already-settled local tokens still cannot be detected by polling alone; verify through Dashboard and Costs. The Admin API **cannot prove** real-time remaining balance. If unsure, **NO-GO** and keep the Proxy paused. Delayed pre-baseline usage can invalidate an assumed baseline; there is no official real-time Data Sharing reservation API.

Legacy checkpoint rows are upgraded with a `NULL` baseline and **remain unverified**, rather than guessed from later measurements. Wait until a new, clean UTC day with no cross-day uncertainty or conduct an externally reviewed ledger migration. Never delete an existing ledger to bypass uncertainty.

## Before any live requests

1. Confirm input/output Data Sharing enrollment, positive balance, exact eligible model versions, `dataSharing.projectId`, and the organization's declared `dataSharing.tier`. Build is 250K/2.5M; Launch/Grow are 1M/10M, all shared by model group across enabled projects. See [configuration guide](data-sharing-configuration.md).
2. Inspect Dashboard *Data sharing incentive tier* including both input and output tokens, then Costs for unexpected charges.
3. Independently test the **`POST /v1/responses/input_tokens`** call's billing classification for the exact allowed input shape using the smallest possible request. Do not enable `preflightCostVerified` until both usage and Costs have been audited.
4. Run `npm run check` and `npm run demo`. Tests are mocked, not billing evidence.
5. Measure which other projects/keys consume the same eligible groups and set `policy.externalSafetyReserve` per group to cover their peak consumption during stats delay. External bypass traffic is legitimate; it tightens admission instead of pausing collection. External models need no whitelist match: known groups classify via the official map, unknown models count conservatively in Premium with diagnostics.
6. Set expiring eligibility, proxy-project dedication and Costs audit attestations; preserve evidence/date and model versions outside the public repo, not keys/screenshots containing secrets. (`exclusiveOrgTrafficAttestedUntil` is kept in old configs only for compatibility and is no longer an admission gate.) Dedication evidence must show the routing project is used only by QuotaFuse (Dashboard project activity review); it cannot be auto-proved from aggregate usage data.
7. Run the isolated Admin Collector and verify a complete daily baseline for both proxy and external scopes. `GET /quota` reports estimated local admission capacity, never official remaining free tokens.
8. Only send a single small *public, text-only* trial request, then reconcile its `usage` against the actual dashboard. Stop immediately on differences or unexpected billed amounts.

## Operation and recovery

- The collector polls the full organization usage every 120 seconds and keeps polling read-only under every proxy state (READY, EXHAUSTED, STALE, DATA_UNVERIFIED, MANUAL_HOLD): a failure preserves the last valid checkpoint (never zero) and only sets a recoverable pause, so the next cycle still polls. External-scope growth never pauses collection. Each full paginated result is validated off-lock; proxy/external observations for both groups are published atomically in one short SQLite transaction. An incomplete page, unattributable row, unknown model, or failed Admin API sets a fail-closed pause without erasing any stronger operator/invariant hold (MANUAL_REVIEW, ACTUAL_EXCEEDS_RESERVED, watermark regression, unverified baseline — these never auto-clear). Independently, any checkpoint that expires during a slow poll denies admission, even before the poll completes. If the current UTC day changed, a new verified baseline is required and admissions remain blocked until both groups have fresh proxy and external observations.
- Each request receives an early provisional reservation in `PREFLIGHT` phase. A valid official input token count atomically shrinks the reservation and marks `DISPATCHED` **before** the generation HTTP call. Missing, disconnected or invalid input counts retain the original reservation as `UNKNOWN` (preflight may itself require billing review).
- To resolve an `UNKNOWN` with `phase=PREFLIGHT`, stop both Proxy and Collector, obtain an encrypted DB backup, keep admissions paused and independently verify the counter caused **zero billable usage**. With a durable evidence reference, run:

```bash
npm run reconcile -- preflight-zero 'stable-idempotency-key' 'operator-id' 'verified-billing-evidence-ticket-12345'
```

- The CLI holds both instance locks and marks the ledger `MANUAL_REVIEW` (paused). Recovery writes `reconciliation_audit` and retains idempotency keys. It will not release a `DISPATCHED` UNKNOWN. If costs, outcome or aggregation are ambiguous, **retain UNKNOWN**. No automatic replay, forced reset, paid overflow or bypass is permitted.
- For earlier pre-anchor usage, incomplete official observations and old cross-day reservations, a manual audit is required; do not infer safety from a clean new process or resetting SQLite.

Official references:
- https://help.openai.com/en/articles/10306912-sharing-feedback-evaluation-and-fine-tuning-data-and-api-inputs-and-outputs-with-openai
- https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/completions
- https://developers.openai.com/api/reference/resources/responses/subresources/input_tokens/methods/count

True accounting invariant failures (`ACTUAL_EXCEEDS_RESERVED`, `PROXY_PROJECT_SHARED`, watermark regression, unverified baseline) cannot be cleared by a successful collector refresh. They require a separately reviewed recovery; there is no automatic recovery pathway. Ordinary external-service consumption is not an invariant failure: recoverable collector pauses clear automatically on the next complete trusted observation, while `MANUAL_REVIEW`, UNKNOWN-safety blocks and untrusted baselines never auto-clear.
