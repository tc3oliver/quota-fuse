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
4. Stop and investigate if official high watermark regresses, official totals exceed verified baseline plus all locally accounted tokens, foreign-project traffic appears, unexpected actual tokens breach their reservation, or Data Sharing enrollment changes. Accounting invariant failures remain paused even after a successful collector poll; do not manually change guard_control without an audited recovery procedure. Config attestation expiration blocks usage.
5. To resume, document the independent evidence, use the documented offline `npm run reconcile` operation only for audited preflight-only UNKNOWN results; all other unknown outcomes require separate reviewed procedures, and re-run the collector. Production unpause is **not** represented as automatic recovery in this release.

Changes to project, Data Sharing tier, model allowlists, safety caps, or token counter modes also fail closed via the persisted policy fingerprint. A persistent previous-day PENDING/UNKNOWN causes new-day requests to fail closed. Without an audited resolution there is no safe self-service bypass. For a forgotten/compromised API key, revoke the upstream credential and proxy token directly at their source.

## Checks

```bash
npm test
npm run typecheck
```

Offline integration tests exercise a mock `fetch`, not the official incentive billing system. Real production Go/No-Go includes a documented zero-unexpected-cost comparison of actual Dashboard/Costs and a scoped project key.
