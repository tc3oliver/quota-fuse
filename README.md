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
npm run setup
```

Setup creates three **Git-ignored**, owner-readable files without overwriting existing settings:

| File | What to configure |
| --- | --- |
| `config.json` | Data Sharing project ID, organization tier, eligible model IDs, safety policy |
| `.env.proxy` | Your project-scoped `OPENAI_API_KEY`; a random proxy access token is generated |
| `.env.collector` | Your separate `OPENAI_ADMIN_KEY` for usage reporting |

**Do not put your Admin API key in `.env.proxy`.** Keep the two processes and their credentials separate.

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

The supported request format is **standalone text-only `POST /v1/responses`** (JSON and streaming). Clients must include a stable `Idempotency-Key`, `X-Quota-Guard-Data-Classification: public`, and a bounded `max_output_tokens`. The `/v1/chat/completions` route, function tools, multimodal input and stored conversations are not available yet. See [API examples and error codes](docs/usage.md).

## Guides

- [Deployment and service management](docs/deployment.md) — setup, credentials, startup, and status
- [Data Sharing project and tier](docs/data-sharing-configuration.md) — eligible model groups, shared caps, and migration
- [Billing checklist](docs/billing-validation.md) — what to verify before enabling live traffic
- [API usage](docs/usage.md) — requests, responses, and fallback behavior
- [Troubleshooting and recovery](docs/runbook.md) — pause states, unknown outcomes, and safe recovery
- [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Technical documentation](docs/development.md)

QuotaFuse is an independent Apache-2.0 project, not affiliated with OpenAI.
