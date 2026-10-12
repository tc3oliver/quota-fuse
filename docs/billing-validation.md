# Billing validation (operator runbook)

QuotaFuse does **not** know the official remaining Data Sharing balance and cannot guarantee zero charges.

**Client-defined Function Calling:** Functions executed by the local agent (file, Bash, Git, or agent-managed MCP operations) do not incur separate OpenAI-hosted tool execution fees. Their definitions, arguments and responses still consume model tokens, and QuotaFuse applies the same model allowlist, input preflight, SQLite reservation and collector policy as for other text requests. The official Data Sharing exclusion for *tool use* does not explicitly clarify these native client-side function-call model tokens; the absence of hosted tool fees is **not** proof of complimentary model tokens. No extra function-specific attestation is required by QuotaFuse, but live inference remains subject to the general billing validation gates below. Hosted OpenAI tools continue to be rejected.


## Credentials and source of truth

- Proxy: `OPENAI_API_KEY` (dedicated `dataSharing.projectId`, generation and exact input preflight; server-controlled `OpenAI-Project` header).
- Collector: `OPENAI_ADMIN_KEY` (organization-wide `GET /v1/organization/usage/completions`, grouped by `model,project_id`, complete pagination). Run in a **separate process**. Never provide the Admin key to the Proxy.
- Client: `QG_PROXY_TOKEN`, a local bearer token.

Admin Usage includes aggregate input/output token usage, **not** real-time, atomically reserved, or incentive-only balances. Use official Dashboard **Data sharing incentive tier (input + output)** and Costs independently to verify eligibility and charges. A project Budget is not a guaranteed real-time hard stop.

## Verified first observation / baseline

The **first official observation** for a UTC day/group becomes a baseline only if no local reservation for that day/group exists. Admission then uses organization-shared accounting — official usage plus fully-additive local commitments plus lifecycle carry plus a conservative external reserve:

`effective_used = official_proxy + official_external_known + unknown_external + outstanding + settled + cross_day_carry + reserve`

`remaining = max(0, floor(daily_limit × safety_pct) − effective_used)`

- `official_proxy`: 路由專案官方累計。`official_external_known`：其他專案官方累計（已確認群組）。`outstanding`：當日未結算預留；`settled`：當日已結算實際用量——同日兩者**全額外加**，不做任何淨額扣除。`cross_day_carry`：生命週期結轉（僅 DISPATCHED-phase、窗口仍重疊新日的舊日未決列，見下）。`reserve`：外部安全保留。
- **禁令——官方增量 ≠ 本地已反映**：官方讀數上升永不視為本地已結算用量已被反映的證明。混合流量反例：settled 100 未反映＋同專案外部 100＋官方讀數 100 → 計 200 + reserve（官方 100＋settled 100＋外部 100 的全額加法，不低估）。同理，官方讀數下降或持平也不得解讀為本地用量已被吸收。
- **重複扣除聲明（利用率代價）**：已反映的 settled 會被重複扣除——官方已計、本地又加計。這是刻意的安全方向保守（只縮小可用額度，永不放大），代價是利用率：高外部流量日時准入會偏緊。`proxy_unreflected_tokens` 快照欄位已刪除，不再有「未反映差額」概念。
- `unknown_external`: the same-day token total of models from **any** project (proxy or external) outside the official group map. It is a single group-independent total counted into **both** Premium and Economy `effective_used`, so each group's upper bound stays safe. Confirmed-group rows are never double-subtracted. Unknown models are never ignored and never assumed free; per-day `external_unknown_models` diagnostics are retained for operator review. All sums use safe-int overflow checks; any overflow yields `INVALID_USAGE` fail-closed.
- 執行窗口三要素（`src/config.ts`，`server.ts` 真實強制 abort）：`PREFLIGHT_TIMEOUT_MS` = 30000（preflight 強制超時）＋`UPSTREAM_TIMEOUT_MS` = 120000（上游 generation 強制超時）＋時鐘邊界 5000 = `EXECUTION_WINDOW_MS` = 155000ms。這是本地可執行的上界（連線到期即 abort），不是假設的官方延遲上界，更不是任意 TTL。官方延遲只影響 Token「出現」時間，不改變日歸屬；結轉到期只憑窗口證明，不憑逾時猜測。
- `cross_day_carry` 只計 phase='DISPATCHED' 且 `admitted_at ≥ 新日 00:00Z − 155000ms` 的舊日未決列（PENDING/UNKNOWN/MANUAL_REVIEW，經證實終結於原日的 review 豁免除外）。PREFLIGHT-phase 列從未發送上游，可證零消耗，永不攜帶。逾時本身不等於零消耗：窗口重疊日照扣全額。admit 不阻擋，歷史與冪等保留。
- 殘餘風險（如實保留，不用假設掩蓋）：client abort 後提供者端續跑可能存在；`store:false` 下 abort 即取消的解讀是**假設前提**，已在文件中寫明。每列風險仍以其准入時 reserve 為界；窗口到期釋放的是「每日扣除」，不是歷史責任。
- `official_external_known`: all other projects' cumulative usage in this group/day, classified by the reviewed official group map only — the proxy admission whitelist never applies to them (`policy.classify` gates Proxy admission only, unchanged). External production services may legally bypass the proxy; their consumption is **expected and never an anomaly**. It only tightens admission. No out-of-whitelist model on any project stops the Collector; unmapped models go to diagnostics.
- `external_safety_reserve`: operator-configured per-group bound (`policy.externalSafetyReserve`) for external consumption during official visibility delay plus the 120s poll interval. Estimate it as `peak external tokens/sec × (visibility delay + poll interval + margin)`. If no credible bound exists, keep the proxy paused. A fixed 0 is only valid with independently verified ~zero external traffic.
- `estimated_remaining` is a conservative admission estimate, **not** an official free-balance promise, and **not** a zero-fee guarantee under unbounded external traffic.

**Preflight attribution unverified:** the official billing attribution of the `POST /v1/responses/input_tokens` preflight **cannot be confirmed** — it cannot be verified with a real paid API — so no verified-safe claim is made. Stay fail-closed on counter uncertainty.

**Preconditions:** the routing project needs no dedication (it may be shared with other services; shared usage is absorbed conservatively), the proxy baseline covers all preceding proxy-scope usage before any local admission (the Admin API may lag), the entire usage read is complete (all pages, exact day bucket, model mapping matches the offer), and both proxy and external scopes have fresh observations within `reconcileMaxAgeSeconds`. Official totals above the local ledger are normal shared-pool consumption, not a pause trigger. Smaller delayed usage masked by already-settled local tokens still cannot be detected by polling alone; verify through Dashboard and Costs. The Admin API **cannot prove** real-time remaining balance. If unsure, **NO-GO** and keep the Proxy paused. Delayed pre-baseline usage can invalidate an assumed baseline; there is no official real-time Data Sharing reservation API.

Legacy checkpoint rows are upgraded with a `NULL` baseline and **remain unverified**, rather than guessed from later measurements. Wait until a new, clean UTC day with no cross-day uncertainty or conduct an externally reviewed ledger migration. Never delete an existing ledger to bypass uncertainty.

## Before any live requests

1. Confirm input/output Data Sharing enrollment, positive balance, exact eligible model versions, `dataSharing.projectId`, and the organization's declared `dataSharing.tier`. Build is 250K/2.5M; Launch/Grow are 1M/10M, all shared by model group across enabled projects. See [configuration guide](data-sharing-configuration.md).
2. Inspect Dashboard *Data sharing incentive tier* including both input and output tokens, then Costs for unexpected charges.
3. Independently test the **`POST /v1/responses/input_tokens`** call's billing classification for the exact allowed input shape using the smallest possible request. Do not enable `preflightCostVerified` until both usage and Costs have been audited.
4. Run `npm run check` and `npm run demo`. Tests are mocked, not billing evidence.
5. Measure which other projects/keys consume the same eligible groups and set `policy.externalSafetyReserve` per group to cover their peak consumption during stats delay. External bypass traffic is legitimate; it tightens admission instead of pausing collection. No model needs a whitelist match for collection: known groups classify via the official map in every project, unknown models (proxy or external scope) count conservatively into both Premium and Economy `effective_used` with diagnostics.
6. Set the one-time eligibility attestation and preserve evidence/date and model versions outside the public repo, not keys/screenshots containing secrets. (`proxyProjectDedicatedAttestedUntil`, `manualCostsAuditedUntil` and `exclusiveOrgTrafficAttestedUntil` are kept in old configs only for compatibility and are no longer admission gates — no periodic re-attestation required.) The routing project may be shared with other services; shared usage is absorbed conservatively. Re-confirm eligibility before `eligibilityAttestedUntil` lapses: expiry fail-closes, with an `ELIGIBILITY_ATTESTATION_EXPIRING` warning during the last 72h so re-confirmation never becomes a surprise outage. No programmatic Data Sharing enrollment check exists (verified 2026-10 against the Admin/Usage API surface), so the date cannot be auto-extended; protection is layered instead — one-time attestation, fingerprint-bound project/tier (any change fail-closes), continuous official-usage monitoring, and Dashboard Usage/Costs review.
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

True accounting invariant failures (`ACTUAL_EXCEEDS_RESERVED`, watermark regression, unverified baseline) cannot be cleared by a successful collector refresh. They require a separately reviewed recovery; there is no automatic recovery pathway. Recoverable pauses (`UNACCOUNTED_OFFICIAL_USAGE`, `PROXY_PROJECT_SHARED`, `ANCHOR_UNVERIFIED`, and other legacy pauses) clear automatically on the next complete trusted observation. Ordinary external-service consumption is not an invariant failure.
