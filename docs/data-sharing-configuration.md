# OpenAI Data Sharing: Project and quotas

QuotaFuse is a local proxy with a **single selected API routing Project** per
SQLite ledger. The OpenAI Data Sharing setting can be **All projects** or
**Selected projects**; this is separate from QuotaFuse's routing setting.

Official terms, free token groups, eligibility and conditions:
https://help.openai.com/en/articles/10306912-sharing-feedback-evaluation-and-fine-tuning-data-and-api-inputs-and-outputs-with-openai

| OpenAI enrollment | What to configure |
| --- | --- |
| All projects | Choose **any existing** API Project ID (`proj_...`); no dedicated Data Sharing Project needed |
| Selected projects | Choose **one of the already opted-in** Projects. A non-enrolled Project is not assumed free |
| Unknown or not verified | Finish the offline installation; keep live inference PAUSED until the operator confirms eligibility |

The installer cannot infer which Data Sharing projects are enrolled from a
Project ID, and will never automatically certify them. Do **not** ask the
user to opt in a Project again if they have already verified it.

| Organization tier | Premium/day | Economy/day | Admission at 85% |
| --- | ---: | ---: | --- |
| Build | 250,000 | 2,500,000 | 212,500 / 2,125,000 |
| Launch / Grow | 1,000,000 | 10,000,000 | 850,000 / 8,500,000 |

These pools are **shared across the entire organization**, not per Project
and not per model. The template starts with Build's lower caps and
requires explicit selection of the actual tier to increase them.

## Quick local configuration

```bash
npm run onboard
npm run doctor
# Only once the user selects an existing Project and verifies their tier:
npm run onboard -- --project=proj_EXISTING_ID --tier=launch
```

Do not ask for model IDs. By default both model lists are empty:

```json
"quotas": {
  "premium": { "dailyTokens": 250000, "models": [] },
  "economy": { "dailyTokens": 2500000, "models": [] }
}
```

**Both model lists empty means no model-ID whitelist**, not that all models
are eligible for the free Data Sharing offer. The Proxy and Collector count
every request in this mode against the smaller **Premium** pool, regardless
of which group the model actually belongs to. This is conservative for
token *quantity* but does **not** prevent billing if an ineligible or paid
model is used. Only officially covered models and API request shapes are
eligible for complimentary tokens.

An operator who wants stricter controls can configure an optional
model-ID whitelist (IDs and groups require review of official terms):

```bash
npm run onboard -- --premium=gpt-6-sol --economy=gpt-5.6-terra
# Restore no model-ID whitelist before an operational ledger exists
npm run onboard -- --allow-all
```

Once either list contains model IDs, both lists together form a strict
whitelist. No wildcard paid-model fallback is added by QuotaFuse. Never
delete an existing SQLite ledger to bypass `POLICY_CHANGED` or `UNKNOWN`;
policy changes require operator reconciliation.

## Existing All projects limitation

The collector observes organization-wide usage but deliberately PAUSES
if a row is attributed to another Project; this maintains the
single-routing-Project accounting assumption. **All projects** enrollment
does not make this a multi-Project quota router. Using other projects
may consume the same incentive allowance and requires appropriate
traffic isolation or later explicit multi-Project support.

Use a Project-scoped `OPENAI_API_KEY` in `.env.proxy`, and an independent
Organization `OPENAI_ADMIN_KEY` in `.env.collector`. The default
`FREE_ONLY` admission policy and billing verification are fail-closed.
See [agent install](agent-install.md), [deployment](deployment.md), and
[billing validation](billing-validation.md).
