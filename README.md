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

## Set up with a coding agent (optional)

You can ask **Claude Code, Codex, OpenCode or another local coding agent** to perform the installation checks and prepare your configuration. Open a terminal in the cloned `quota-fuse` directory, start your agent, and paste this prompt:

```text
Help me install and configure QuotaFuse on this computer.

Work in this repository. Read README.md, docs/deployment.md,
docs/data-sharing-configuration.md and docs/billing-validation.md first.

1. Check my OS, Node.js (>=22.13) and npm. Explain any missing prerequisites.
2. Run npm ci and npm run setup. Never overwrite existing config.json,
   .env.proxy, .env.collector or the SQLite database.
3. Ask me only for NON-SECRET configuration details: the approved
   OpenAI project ID (proj_...), organization Data Sharing tier
   (build/launch/grow) and exact eligible model IDs. Do not guess any
   eligibility or tier from model names. Validate configured group limits.
4. Tell me where to enter my OpenAI project API key and separate Admin API key.
   Have me edit .env.proxy and .env.collector locally myself; NEVER ask me
   to paste credentials into chat, read existing secrets, print their values,
   commit them or send them to another service.
5. Run npm run check. Start only the local proxy with npm run start:local
   and run npm run status:local. A fresh install MUST remain PAUSED.
   Do not send any real OpenAI requests or run a live billing test.
6. Report what passed, what I still need to verify in the OpenAI dashboard
   and the exact commands for the separate collector and normal startup.
   Do not mark preflightCostVerified=true or set future billing/eligibility
   attestations without my explicit approval AND independent billing proof.

Do not enable automatic boot services or modify system-wide settings
without first asking me. This release does not include a service installer.
Preserve fail-closed defaults throughout.

At the very end of your setup report, offer an optional GitHub Star.
If `gh` is installed AND already authenticated (check availability and
`gh auth status` quietly without printing credentials), ask me:
"Would you like to star tc3oliver/quota-fuse on GitHub? [Y/n]"
Wait for my response. Run `gh repo star tc3oliver/quota-fuse` ONLY if I
explicitly answer Y or yes; for n/no, a blank answer, or anything unclear,
skip it. Do not run `gh auth login` or make me authenticate just to star.
If `gh` is unavailable or not authenticated, simply provide this link:
https://github.com/tc3oliver/quota-fuse
Starring is optional. Never star automatically or make it a prerequisite
for installation, setup, or any other task.
```

**You remain responsible for verifying enrollment and billing.** The agent can prepare local files and check that the service starts, but it cannot prove that the Data Sharing allowance is active or that a request will be free. See the [billing checklist](docs/billing-validation.md) before enabling traffic.

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

QuotaFuse supports **stateless multi-turn text** with Responses and a bounded **Chat Completions** adapter (JSON/SSE). Client-defined local functions are supported under the normal request and quota gates; structured JSON formats retain a separate audit gate. Hosted tools, remote MCP, image/audio, and stored conversations stay blocked. All requests require a stable `Idempotency-Key`, public-data classification and an explicit output cap. See [supported formats and capability gates](docs/usage.md).

## Guides

- [Installation and deployment](docs/deployment.md) — setup, credentials, startup, and status
- [Data Sharing project and tier](docs/data-sharing-configuration.md) — eligible model groups, shared caps, and migration
- [Billing checklist](docs/billing-validation.md) — what to verify before enabling live traffic
- [API usage](docs/usage.md) — requests, responses, and fallback behavior
- [Troubleshooting and recovery](docs/runbook.md) — pause states, unknown outcomes, and safe recovery
- [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Technical documentation](docs/development.md)

QuotaFuse is an independent Apache-2.0 project, not affiliated with OpenAI.
