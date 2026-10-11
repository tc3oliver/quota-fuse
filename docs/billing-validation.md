# Billing validation (operator runbook)

QuotaFuse does **not** know the official remaining Data Sharing balance and cannot guarantee zero charges.

## Credentials and source of truth

- Proxy: `OPENAI_API_KEY` (dedicated Data Sharing-enabled project, generation and exact input preflight).
- Collector: `OPENAI_ADMIN_KEY` (organization-wide `GET /v1/organization/usage/completions`, grouped by `model,project_id`, complete pagination). Run in a **separate process**. Never provide the Admin key to the Proxy.
- Client: `QG_PROXY_TOKEN`, a local bearer token.

Admin Usage includes aggregate input/output token usage, **not** real-time, atomically reserved, or incentive-only balances. Use official Dashboard **Data sharing incentive tier (input + output)** and Costs independently to verify eligibility and charges. A project Budget is not a guaranteed real-time hard stop.

## Verified first observation / baseline

The **first official observation** for a UTC day/group becomes a baseline only if no local reservation for that day/group exists. Each local request's settled usage or still-reserved tokens are counted on top of this baseline:

`effective_committed = max(latest_official_observed, baseline + local_settled + reserved_outstanding)`

This fixes the `MAX(official, local)` undercount when official traffic predates local requests, without automatically double-counting local usage once the official number catches up.

**Preconditions:** the baseline covers all preceding relevant usage (the Admin API may lag), the affected organization has **no eligible bypass traffic after that baseline**, the entire usage read is complete and the versioned-model mapping actually matches the user's offer. The collector enters a sticky manual-review pause if later official usage exceeds the baseline plus all locally settled and reserved upper bounds. Smaller delayed or bypass usage masked by already settled local tokens cannot be detected by this check. The operator must independently verify the baseline through Dashboard and isolate bypass traffic. The Admin API **cannot prove** these conditions itself. If unsure, **NO-GO** and keep the Proxy paused. Delayed pre-baseline usage can invalidate an assumed baseline; there is no official real-time Data Sharing reservation API.

Legacy checkpoint rows are upgraded with a `NULL` baseline and **remain unverified**, rather than guessed from later measurements. Wait until a new, clean UTC day with no cross-day uncertainty or conduct an externally reviewed ledger migration. Never delete an existing ledger to bypass uncertainty.

## Before any live requests

1. Confirm Data Sharing enrollment, positive balance, the eligible exact model versions, limits applicable to the account's usage tier and project-level policy. The included 1M/10M defaults are not universal.
2. Inspect Dashboard *Data sharing incentive tier* including both input and output tokens, then Costs for unexpected charges.
3. Independently test the **`POST /v1/responses/input_tokens`** call's billing classification for the exact allowed input shape using the smallest possible request. Do not enable `preflightCostVerified` until both usage and Costs have been audited.
4. Run `npm run check` and `npm run demo`. Tests are mocked, not billing evidence.
5. Confirm no other project/key/workspace can consume the same eligible group while the proxy is serving. Unexpected rows cause collector pause, but delayed or unseen bypass traffic cannot be ruled out by polling alone.
6. Set expiring eligibility, exclusive-org and Costs audit attestations; preserve evidence/date and model versions outside the public repo, not keys/screenshots containing secrets.
7. Run the isolated Admin Collector and verify a complete daily baseline. `GET /quota` reports estimated local admission capacity, never official remaining free tokens.
8. Only send a single small *public, text-only* trial request, then reconcile its `usage` against the actual dashboard. Stop immediately on differences or unexpected billed amounts.

## Operation and recovery

- The collector polls every 120 seconds; incomplete pages, unexpected projects/models, stale snapshots or failures pause admissions. If the current UTC day changed, a new checkpoint is required.
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

Accounting invariant failures (`UNACCOUNTED_OFFICIAL_USAGE`, `ACTUAL_EXCEEDS_RESERVED`, watermark regression) cannot be cleared by a successful collector refresh. They require a separately reviewed recovery; v0.1 has no automatic recovery pathway.
