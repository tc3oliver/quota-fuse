# QuotaFuse

**Keep OpenAI Data Sharing API usage within a conservative token budget.**

[![CI](https://github.com/tc3oliver/quota-fuse/actions/workflows/ci.yml/badge.svg)](https://github.com/tc3oliver/quota-fuse/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

QuotaFuse is a local OpenAI-compatible proxy for **OpenAI Data Sharing complimentary tokens**. It reserves capacity before a request, tracks completed and uncertain usage in SQLite, checks organization usage through a separate collector, and **blocks requests when it cannot verify the budget**.

- **Conservative by default:** No automatic switch to paid API usage.
- **Shared quota tracking:** Select your OpenAI project and Build / Launch / Grow tier. Premium and economy model groups have separate daily caps.
- **Local access:** The proxy listens on `127.0.0.1`. Project and Admin API keys run in separate processes.
- **Safe fallback signal:** Clients can use quota-related 429/503 responses to switch to another provider at a safe task boundary.

> **Important:** QuotaFuse reduces the risk of unexpected charges; it cannot guarantee a zero-cost bill. OpenAI's usage data may be delayed, and direct or other-project API traffic may consume the same allowance. **The current release is not yet validated against a live Data Sharing bill. Keep inference disabled until you complete the [billing checklist](docs/billing-validation.md).** Use only public, non-sensitive input.

## Install

Requires **Node.js 22.13+**, npm, and a local machine or VM. Docker and remote listening are not supported by this release.

```bash
git clone https://github.com/tc3oliver/quota-fuse.git
cd quota-fuse
npm ci
npm run onboard
```

Setup creates three **Git-ignored**, owner-readable files without overwriting existing settings:

| File | What to configure |
| --- | --- |
| `config.json` | Existing API routing Project ID, org tier, all eligible model IDs prefilled; optional narrower allowlist |
| `.env.proxy` | Your project-scoped `OPENAI_API_KEY`; a random proxy access token is generated |
| `.env.collector` | Your separate `OPENAI_ADMIN_KEY` for usage reporting |

**Do not put your Admin API key in `.env.proxy`.** Keep the two processes and their credentials separate.

## Zero-question onboarding

`npm run onboard` does not ask users to manually type dozens of model IDs,
does not call OpenAI, and does not switch on live billing admissions. On fresh
setups it includes **all model IDs in the reviewed official Data Sharing
complimentary-token list** (except models explicitly announced as shut down).
These are exact IDs, not wildcard access to arbitrary paid models.

Organizations enrolled under **All projects** may select **any existing**
Project ID for QuotaFuse API routing. A special Data Sharing-only Project is
not required. The shared allowance is org-wide; this version's collector
deliberately pauses on usage from other projects (one-routing-project
limitation). Do not run unmanaged usage from other projects when relying on
this proxy's conservative budget.

```bash
npm run doctor
# Nonsecret details can be set once, whenever available:
npm run onboard -- --project=proj_YOUR_EXISTING_ID --tier=launch
# Optional: restrict to a manually selected official eligible-model subset:
npm run onboard -- --only=gpt-6-sol,gpt-5.6-terra
# Restore complete published catalog before an operational ledger exists:
npm run onboard -- --only=all
```

The template starts at the conservative Build cap (250K/2.5M) until
you confirm your actual org tier; Launch/Grow caps are 1M/10M.
Model entries are a **snapshot** of the [official offer](https://help.openai.com/en/articles/10306912-sharing-feedback-evaluation-and-fine-tuning-data-and-api-inputs-and-outputs-with-openai),
not a promise that every model is currently accessible in your Project or
supports this proxy's restricted API shapes. Unknown models remain blocked.
A pre-existing SQLite ledger prevents automatic project/tier/model changes:
follow [the recovery runbook](docs/runbook.md) rather than deleting history.

### Set up with a coding agent

Use your already working OpenCode/Codex/Claude Code and paste:

> Install or safely update tc3oliver/quota-fuse. Run npm ci, npm run onboard,
> npm run doctor, and the offline tests. **Do not ask me for a dedicated
> Data Sharing Project:** All projects is enabled; I can select any existing
> API routing Project later. Use the **all eligible models default**, no
> model questionnaire. Only narrow the allowlist if I request it. Confirm
> my org tier if needed. Guide me to edit project and separate Admin API
> keys **locally**, never print or copy secrets into chat. Preserve any
> existing SQLite ledger; never force-overwrite configuration. Keep
> eligibility/preflight/Costs/exclusivity gates fail-closed unless independently
> verified. Do not send live OpenAI requests, enable paid fallback, or
> install auto-start services without asking. Finish with a short list
> of only genuinely missing steps.

For live inference, the independent [billing validation](docs/billing-validation.md)
(preflight Costs, attribution and traffic isolation), keys, collector baseline
and explicit public-only data declaration are still required. An org Data
Sharing enrollment check that has already been completed need not be repeated.

## Start

Run these commands **in separate terminals**, from the repository directory:

```bash
# Terminal 1 — API proxy
npm run start:local
```

```bash
# Terminal 2 — organization usage collector (refreshes every 120 seconds)
npm run collector:local
```

```bash
# Terminal 3 — status and guarded quota estimates
npm run status:local
```

The proxy serves `http://127.0.0.1:8787`. A fresh installation shows **PAUSED**, and requests are rejected until the [eligibility and billing checks](docs/billing-validation.md) have been completed. This is intentional; simply adding keys or selecting a tier does not enable paid traffic.

## Configure your allowance

In `config.json`, set the project's actual `proj_...` ID and the **organization Data Sharing tier** confirmed in your OpenAI dashboard:

```json
{
  "dataSharing": {
    "projectId": "proj_your_project",
    "tier": "build"
  }
}
```

The example above is a **fragment**; keep the other fields generated in `config.json`. Supported tiers:

| Tier | Premium tokens/day | Economy tokens/day |
| --- | ---: | ---: |
| Build | 250,000 | 2,500,000 |
| Launch / Grow | 1,000,000 | 10,000,000 |

Those are **organization-shared group allowances**, not per-project quotas. QuotaFuse allows lower local caps and defaults to an **85% admission ceiling**. Exact eligible models must be entered in `quotas.premium.models` and `quotas.economy.models` after verification; no models are enabled by default. See [project and tier settings](docs/data-sharing-configuration.md).

## Connect a client

After completing the billing checklist, point a local Responses API client at:

```text
Base URL: http://127.0.0.1:8787/v1
Auth:      Bearer <QG_PROXY_TOKEN from .env.proxy>
```

QuotaFuse supports **stateless multi-turn text** with Responses and a bounded **Chat Completions** adapter (JSON/SSE). Client-defined local functions are supported under the normal request and quota gates; structured JSON formats retain a separate audit gate. Hosted tools, remote MCP, image/audio, and stored conversations stay blocked. All requests require a stable `Idempotency-Key`, public-data classification and an explicit output cap. See [supported formats and capability gates](docs/usage.md). OpenCode requires an adapter for unique request IDs and bounded output; **never auto-label private workspace content as public**. Use only a public test fixture: [docs/opencode-agent.md](docs/opencode-agent.md).

## Guides

- [Installation and deployment](docs/deployment.md) — setup, credentials, startup, and status
- [Data Sharing project and tier](docs/data-sharing-configuration.md) — eligible model groups, shared caps, and migration
- [Billing checklist](docs/billing-validation.md) — what to verify before enabling live traffic
- [API usage](docs/usage.md) — requests, responses, and fallback behavior
- [Troubleshooting and recovery](docs/runbook.md) — pause states, unknown outcomes, and safe recovery
- [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Technical documentation](docs/development.md)

QuotaFuse is an independent Apache-2.0 project, not affiliated with OpenAI.
