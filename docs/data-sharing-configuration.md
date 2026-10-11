# Data Sharing project and tier configuration

QuotaFuse protects **one explicitly selected API routing project per SQLite ledger**. An OpenAI organization may have Data Sharing enabled for **All projects**; the user does not need a specially enrolled project. OpenAI's complimentary token limits are **organization-wide for each model group**, never per project or per model.

Official terms: https://help.openai.com/en/articles/10306912-sharing-feedback-evaluation-and-fine-tuning-data-and-api-inputs-and-outputs-with-openai

| Org tier | Premium/day | Economy/day | At 85% safety |
| --- | ---: | ---: | --- |
| build | 250,000 | 2,500,000 | 212,500 / 2,125,000 |
| launch | 1,000,000 | 10,000,000 | 850,000 / 8,500,000 |
| grow | 1,000,000 | 10,000,000 | 850,000 / 8,500,000 |

The words premium/economy are **QuotaFuse model groups**, not the OpenAI usage `service_tier`, organization enrollment tier, or subscription plan.

## Required configuration (no model-by-model questionnaire)

Run `npm run onboard` on a fresh checkout. The shipped template
prepopulates `quotas.*.models` with **all exact model IDs listed under the
official Data Sharing incentive offer** as of 2026-10-11, excluding
`gpt-4.5-preview-2025-02-27` (explicitly shut down). This is a
**reviewed snapshot** in `config.example.json`, not a wildcard or
proof that every model remains available. Reconcile the official offer when
new models are published; don't enable arbitrary names as a shortcut.

Default is **all documented eligible models**. Restrict only if the user wants
a custom whitelist:

```bash
npm run onboard -- --only=gpt-6-sol,gpt-5.6-terra
# Undo restriction in a fresh, unused setup:
npm run onboard -- --only=all
```

For **All projects** Data Sharing, choose an existing Project for QuotaFuse's
API routing rather than asking for a "Data Sharing-only Project":

```bash
npm run onboard -- --project=proj_YOUR_EXISTING_ID --tier=launch
```

The `build` default is deliberately conservative (250K/2.5M); confirmed
Launch/Grow offers allow 1M/10M. Daily limits are **organization-wide per
model group**. Leave the `FREE_ONLY` policy, 85% safety cap and billing
attestations fail-closed until independently confirmed.

**Operational limitation:** Admin Usage is queried across all organization
projects; currently QuotaFuse pauses if an official usage row belongs to a
different project or an unreviewed model. "All projects" in OpenAI settings
does **not** make QuotaFuse a cross-project router. Unmanaged bypass traffic
may spend the same org quota. Do not create separate ledgers for one org pool.

Project-scoped `OPENAI_API_KEY` belongs only in `.env.proxy`; the distinct
organization `OPENAI_ADMIN_KEY` belongs only in `.env.collector`.
Never paste either key into an agent conversation.

Official model groups and program terms:
https://help.openai.com/en/articles/10306912-sharing-feedback-evaluation-and-fine-tuning-data-and-api-inputs-and-outputs-with-openai

## Migration

Prior versions used `upstream.projectId`. Move it to `dataSharing.projectId`, **remove** the old property, set `dataSharing.tier`, and audit your `quotas.*.dailyTokens`. The old property is rejected rather than silently overridden.

Changing project, tier, model lists or quota caps invalidates the SQLite policy fingerprint. Preserve the ledger and UNKNOWN reservations; do not delete the DB to work around `POLICY_CHANGED`. Follow [runbook](runbook.md) for reviewed recovery.

v0.1 does not support allocating separate free pools per project. Do **not** deploy multiple independent ledgers against one organization's free-token entitlement. This remains a Technical Preview, not a guarantee of zero charges.
