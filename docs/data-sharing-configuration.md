# Data Sharing project and tier configuration

QuotaFuse protects **one explicitly selected project per SQLite ledger**. OpenAI's complimentary token limits are **organization-wide for each model group**, never per project or per model.

Official terms: https://help.openai.com/en/articles/10306912-sharing-feedback-evaluation-and-fine-tuning-data-and-api-inputs-and-outputs-with-openai

| Org tier | Premium/day | Economy/day | At 85% safety |
| --- | ---: | ---: | --- |
| build | 250,000 | 2,500,000 | 212,500 / 2,125,000 |
| launch | 1,000,000 | 10,000,000 | 850,000 / 8,500,000 |
| grow | 1,000,000 | 10,000,000 | 850,000 / 8,500,000 |

The words premium/economy are **QuotaFuse model groups**, not the OpenAI usage `service_tier`, organization enrollment tier, or subscription plan.

## Required configuration

Copy `config.example.json`, then set:

```json
"dataSharing": {
  "projectId": "proj_your_verified_project",
  "tier": "launch"
},
"quotas": {
  "premium": {"dailyTokens": 1000000, "models": []},
  "economy": {"dailyTokens": 10000000, "models": []}
}
```

This JSON fragment belongs inside the full config object. Example defaults are **build** with 250K/2.5M (safer for first use). Changing tier requires reviewing the daily group caps. Values may be lower than the tier's entitlement but cannot exceed it. Populate exact model IDs only after independently validating their current eligibility; never infer them from the tier.

1. As an OpenAI Org Owner, enable **Share inputs and outputs with OpenAI** for the selected project in Data Controls, and independently confirm complimentary-token enrollment, organization tier, positive account balance, and eligible models in the Dashboard. Enabling only feedback or eval sharing is insufficient.
2. Supply a **project-scoped** `OPENAI_API_KEY` to Proxy and a **separate** `OPENAI_ADMIN_KEY` to Collector. The selected `dataSharing.projectId` controls the server-side `OpenAI-Project` header and the collector's allowed project check.
3. Admin Usage is queried for **all organization projects**, grouped by model/project. A row from another project or unexpected model **pauses** the proxy. This is intentional: multiple enabled projects share the same incentive pools, and delayed or unseen bypass traffic still prevents a zero-cost guarantee.
4. Complete the [billing validation](billing-validation.md), including actual free incentive entries and Costs. Configuration is a declaration, **not proof** of Data Sharing eligibility. Operator attestations and the verified preflight gate stay deny-by-default.

## Migration

Prior versions used `upstream.projectId`. Move it to `dataSharing.projectId`, **remove** the old property, set `dataSharing.tier`, and audit your `quotas.*.dailyTokens`. The old property is rejected rather than silently overridden.

Changing project, tier, model lists or quota caps invalidates the SQLite policy fingerprint. Preserve the ledger and UNKNOWN reservations; do not delete the DB to work around `POLICY_CHANGED`. Follow [runbook](runbook.md) for reviewed recovery.

v0.1 does not support allocating separate free pools per project. Do **not** deploy multiple independent ledgers against one organization's free-token entitlement. This remains a Technical Preview, not a guarantee of zero charges.
