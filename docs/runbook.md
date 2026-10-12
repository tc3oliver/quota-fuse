# Operator runbook — v0.1

## Setup / startup

Run Node.js 22.13 or later (prefer exactly pinned environment). Copy `config.example.json` to ignored `config.json`. Configure `dataSharing.projectId`, the verified org `dataSharing.tier`, and per-group limits as in [configuration guide](data-sharing-configuration.md). A brand-new install is paused until verification; do not use default placeholder IDs in real requests. Store secrets outside the repository and avoid long-lived admin credentials on developer desktops when possible.

Use `npm run setup` to generate `config.json`, `.env.proxy` and `.env.collector`; then use `npm run start:local` and `npm run collector:local` in separate terminals. See [deployment](deployment.md) for the user workflow.

Keep the proxy and usage collector as **distinct processes and credentials**. The proxy refuses to boot when `OPENAI_ADMIN_KEY` is present, and the collector refuses to boot when `OPENAI_API_KEY` is present. This stops an accidental shared environment, not a privileged OS adversary.

```bash
# proxy process
QG_CONFIG=./config.json QG_PROXY_TOKEN="$QG_PROXY_TOKEN" OPENAI_API_KEY="$OPENAI_API_KEY" npm start

# separate collector process, environment WITHOUT OPENAI_API_KEY
QG_CONFIG=./config.json OPENAI_ADMIN_KEY="$OPENAI_ADMIN_KEY" npm run collector -- --once

# read local guarded capacity without opening a network port
QG_CONFIG=./config.json npm run quota
```

Run only **one** collector process per database; a dedicated `.collector.lock` prevents accidental overlapping runs. Run collector continuously to refresh every 120s. Failures immediately set persistent `COLLECTOR_UNVERIFIED` pause; a later **complete** successful paginated cycle unpauses. Check `/health/ready` before sending new requests. Check the OpenAI Dashboard Data Sharing incentive tier and the separate Costs page before calling this production ready.

## Expected denials

| Code | Meaning / response |
| --- | --- |
| `FREE_QUOTA_EXHAUSTED` (429) | Guarded capacity exhausted; don't retry the same provider/group until reviewed next UTC day |
| `FREE_QUOTA_UNVERIFIED` (503) | Enrollment, counter, clock/checkpoint, storage, collector, or outcome untrusted; no paid fallback |
| `MODEL_NOT_ELIGIBLE` (403) | Exact model not manually reviewed |
| `PAID_FEATURE_BLOCKED` (403) | Unsupported endpoint/tool/shape/state/multimodal usage |
| `DUPLICATE_REQUEST` (409) | Existing key; do not automatically replay |
| `IDEMPOTENCY_KEY_REQUIRED` (400) | Add stable unique key per logical operation |
| `DATA_POLICY_DENIED` (403) | Only demonstrably public/non-sensitive requests permitted |

See [billing-validation.md](billing-validation.md) before enabling any actual OpenAI project traffic, and for the conditional initial baseline assumptions.

## Recovery

**Never delete, set `actual=0`, or force-complete an UNKNOWN row because it looks old.**

1. Pause client traffic. Keep an external snapshot of the DB and record key/time/model from ledger; no prompt body is retained.
2. Compare complete official usage pages and Dashboard Costs, including requests around UTC midnight.
3. For incomplete or ambiguous outcomes, keep `UNKNOWN` and do not reissue the same operation. The only recovery command is **manual, audited preflight-only zero-billable-usage reconciliation**; it cannot release a generation-dispatched UNKNOWN.
4. Stop and investigate if the official watermark regresses, per-project attribution breaks (unattributable rows, unknown models), official totals exceed any plausible bound, unexpected actual tokens breach their reservation, or Data Sharing enrollment changes. Ordinary external-service growth is **not** a fault — it only tightens admission. Accounting invariant failures remain paused even after a successful collector poll; do not manually change guard_control without an audited recovery procedure. Config attestation expiration blocks usage.
5. To resume, document the independent evidence, use the documented offline `npm run reconcile` operation only for audited preflight-only UNKNOWN results; all other unknown outcomes require separate reviewed procedures, and re-run the collector. Production unpause is **not** represented as automatic recovery in this release.

Changes to project, Data Sharing tier, model allowlists, safety caps, external reserves, or token counter modes also fail closed via the persisted policy fingerprint. A persistent previous-day PENDING/UNKNOWN causes new-day requests to fail closed. Without an audited resolution there is no safe self-service bypass. For a forgotten/compromised API key, revoke the upstream credential and proxy token directly at their source.

## Cutover to organization-shared accounting

Releases with shared-pool accounting change the policy fingerprint (new
`externalSafetyReserve`). An existing history-bearing ledger will report
`POLICY_CHANGED` at boot — this is fail-closed working as designed, not a
bug. Do not edit the fingerprint, delete the database, or clear
`guard_control`:

1. Pick a fresh UTC day with no PENDING/UNKNOWN/MANUAL_REVIEW rows and no current-day observations (00:00 UTC = 08:00 Asia/Taipei). Stop Proxy and Collector.
2. Back up `data/` (SQLite file plus WAL) and `config.json` to durable storage outside the repo.
3. Add per-group `policy.externalSafetyReserve` bounds to `config.json` (peak external tokens/sec × visibility delay + 120s poll interval + margin).
4. Point `server.storage` at a **new** SQLite file; keep the old file as the audit archive. Never delete it.
5. Start the Collector first, verify fresh proxy AND external baselines for both groups via `/quota` (`official_external_usage` must be a number, not null), check Dashboard Usage/Costs, then start the Proxy.
6. Drain or rotate client idempotency keys across the cutover: the new ledger cannot see the old ledger's keys.

## Reviewed DISPATCHED UNKNOWN at UTC rollover

A generation response that has already reached a **terminal status before UTC
midnight**, but whose usage could not be trusted, may be bounded to its original
day after a separate, independent accounting review. **This is not a way to
release an ambiguous network timeout or an unverified request.** If the server
did not positively observe a terminal response *that day*, keep UNKNOWN and
PAUSED and obtain provider-specific proof before attempting review.

The new `dispatched-day-bounded` operation is deliberately restricted:
- The reservation must remain `UNKNOWN / DISPATCHED`; it is **never**
  converted to COMPLETED, never given `actual=0`, and its entire reserve is
  retained on the original day.
- Evidence must identify the request, terminal response timestamp and status,
  complete and fully settled old-day **and new-day** official Usage, reviewed
  Costs, absence of other project/bypass traffic, and an external audit ticket.
  Official aggregation/Costs can be delayed; a positive `payer=openai`
  marker alone does not prove final accounting.
- At least **24 hours must pass after the old UTC day ends** before a review;
  even then, the operator must independently determine that reports are final.
  Both new-day group baselines must be current and complete.
- Stop **both** Proxy and Collector first. The reconciliation command takes
  both instance locks and requires `MANUAL_REVIEW`. If it fails, remain
  PAUSED. Make encrypted durable backups **outside /tmp** first.
- No replay of the same idempotency key is permitted. Any other unresolved
  old-day reservation still blocks the new day. After success, restart the
  Collector and verify the current-day baseline and `/health/ready`.

Example syntax (**do not run without the above evidence or user approval**):

```bash
npm run reconcile -- dispatched-day-bounded live-trial-000001 operator-id \
  2026-10-11T12:34:56Z --attest-finalized-usage-and-costs \
  'Audit ticket URL, full original response log/request ID, terminal status, original and next UTC-day Usage totals, verified Costs, project isolation evidence and review date'
```

This command records a separate immutable `dispatched_day_reviews` row and
`reconciliation_audit` entry. The original reservation remains UNKNOWN with
its entire `reserved` amount. The review only exempts this *proven bounded*
request from **cross-day** blocking; it does not forgive billing, weaken
same-day bounds or allow other unknown outcomes. Never fabricate a terminal
timestamp to override the safety gate.

## Audited legacy-to-official group-accounting upgrade

**Fresh installations** already have `modelGroupAccounting: "official_v1"`.
For an **existing** SQLite ledger that accounted all unlisted models as
Premium, the upgrade must be explicit: abruptly reclassifying historical
official usage as Economy would create false watermark errors.

After independent review of the affected organization's Usage, Costs,
and **all older UNKNOWN** outcomes, arrange a maintenance window **at
the beginning of a new UTC day before the Collector has written any
observations or clients have made any requests for that day**.
(00:00 UTC = 08:00 Asia/Taipei.) Safely stop both Proxy and Collector,
take durable SQLite and config backups, and document a detailed ticket.
Do not attempt the command if today's baseline already exists; use
another unobserved UTC day instead.

```bash
npm run accounting:upgrade -- operator-id \
  'Audit record URL, reviewed prior-day reservations and terminal response evidence, verified official Usage and Costs, maintenance window, no new-day admission or collector baseline'
```

This command:
1. Takes both instance locks and enters MANUAL_REVIEW.
2. Requires the old fingerprint and no unresolved, unreviewed prior-day
   reservations.
3. Requires **zero** current-day or later reservations AND official observations.
4. Transactionally changes only the policy fingerprint and writes a
   `accounting_migration_audit` record; then atomically writes the updated
   0600 `config.json`. History is never relabeled or erased.
5. Requires starting the Collector first for new, group-aware official
   baselines, checking Usage/Costs, and restarting Proxy only when safe.

A crash between SQLite and config replacement intentionally leaves
`POLICY_CHANGED` and PAUSED. Do **not** override the fingerprint or reset
the ledger to recover. Inspect the audit record, then repair the configuration
through reviewed operator procedures. Never run this automatically from
Agent installation or from a scheduler.

## Checks

```bash
npm test
npm run typecheck
```

Offline integration tests exercise a mock `fetch`, not the official incentive billing system. Real production Go/No-Go includes a documented zero-unexpected-cost comparison of actual Dashboard/Costs and a scoped project key.

## Verifiable incomplete generation usage (new requests only)

An upstream Responses generation ending with `status: incomplete` and
`incomplete_details.reason: max_output_tokens` can still have final,
verified token usage. A newly dispatched request settles **accounting only**
when the terminal response has a valid response ID and model, no upstream
error, nonnegative integer input/output/total token counts, a consistent
`total_tokens = input_tokens + output_tokens`, plausible token details,
output not exceeding the configured cap, and actual total not exceeding the
persisted reservation. The same rules apply to JSON and streamed
`response.incomplete` terminal events; streaming is settled only after EOF.

The ledger uses `COMPLETED` to mean **accounting settled**, not that the
generation produced an answer. An append-only `incomplete_settlements` row
records upstream response ID, truncation reason and exact usage atomically.
Responses callers receive the original `incomplete` payload/event.
Chat compatibility responds with an explicit `UPSTREAM_INCOMPLETE` error
instead of a false successful assistant turn. Duplicate idempotency keys
remain forbidden. Missing or contradictory receipts, transport failures,
unknown terminal causes, client disconnects and bounds violations stay
fail-closed as before.

**This release does not reconcile prior UNKNOWN requests** such as
`live-trial-000001`. Do not set `actual`, overwrite UNKNOWN, reset the
ledger, or use an inferred usage delta as proof. Previously ambiguous
records continue to require independent evidence and the operator process
documented above.
