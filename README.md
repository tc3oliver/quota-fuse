# QuotaFuse

**Fail-closed local proxy for OpenAI Data Sharing complimentary-token traffic.**

[![CI](https://github.com/tc3oliver/quota-fuse/actions/workflows/ci.yml/badge.svg)](https://github.com/tc3oliver/quota-fuse/actions/workflows/ci.yml)
[![Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

QuotaFuse provides a local Responses / limited Chat Completions proxy,
persistent SQLite quota reservations, a separate organization Usage collector,
and a localhost-only OpenCode adapter. It can block uncertain or over-budget
requests. **No API budget or delayed Usage estimate guarantees a zero-cost bill.**

## Install (Node.js 22.13+)

```bash
git clone https://github.com/tc3oliver/quota-fuse.git
cd quota-fuse
npm ci
npm run onboard   # offline, no questions, no OpenAI requests
npm run doctor    # read-only checklist
# Run this yourself in a separate local terminal when keys/project are missing:
# npm run configure:local   # private, hidden API Key entry; no agent tool
```

`onboard` prepares missing Git-ignored `config.json`, `.env.proxy` and
`.env.collector` without overwriting existing user files or SQLite history.
`configure:local` guides the owner through missing Project and API keys in a
**separate local terminal** with non-echoed secrets, never in an agent session.
If a service was started during setup, stop Proxy and Collector before
changing the Project or tier; pristine paused ledgers can be configured
without deleting their SQLite database.
It leaves real API requests **PAUSED** until remaining evidence-backed
safety gates are satisfied.

### Install with a coding agent

**OpenCode / Codex / Claude Code:** ask your agent to **read and carry out
[docs/agent-install.md](docs/agent-install.md)**. It should do the
installation and checks directly, and ask only for necessary missing
non-secret details and explicit approvals.

### Model filtering

The default `quotas.premium.models=[]` and `quotas.economy.models=[]`
mean **no model-ID whitelist**. Any syntactically valid exact model ID
can pass that filter. **This does not mean every model is free: paid or
ineligible models can incur charges.** In unfiltered mode all traffic is
conservatively counted toward the **smaller Premium budget**, and the usual
preflight, collector, operator attestation, data policy and FREE_ONLY gates
remain in force.

Only users who need a narrower model whitelist configure one:

```bash
npm run onboard -- --premium=gpt-6-sol --economy=gpt-5.6-terra
# On a new, unused ledger, restore unrestricted ID filtering:
npm run onboard -- --allow-all
```

Review OpenAI's [Data Sharing program and eligible models](https://help.openai.com/en/articles/10306912-sharing-feedback-evaluation-and-fine-tuning-data-and-api-inputs-and-outputs-with-openai)
before allowing billable live inference. An **All projects** enrollment
does not require a specially enrolled Project, but QuotaFuse still needs
**one existing routing Project ID**, and the shared incentive is
organization-wide. Cross-project usage may pause the current collector.

## Run

After safely entering local **Project** and separate **Admin** API keys
and completing the [billing checklist](docs/billing-validation.md), use
separate terminals:

```bash
npm run start:local         # Proxy: http://127.0.0.1:8787
npm run collector:local     # Separate process and Admin credential
npm run status:local        # READY or PAUSED and guarded quota estimate
```

For coding agents, start the loopback adapter and follow
[OpenCode integration](docs/opencode-agent.md). Only send **public,
non-sensitive** task data with explicit classification. Do not silently
mark private code or workspace contents as public.

Offline validation:

```bash
npm run check
npm run test:agent
npm run demo
```

## Documentation

- [Agent-guided installation](docs/agent-install.md)
- [Deployment, credential separation, startup](docs/deployment.md)
- [OpenCode adapter and public fixture](docs/opencode-agent.md)
- [Data Sharing groups, limits, All projects](docs/data-sharing-configuration.md)
- [Billing verification before live requests](docs/billing-validation.md)
- [API supported requests and errors](docs/usage.md)
- [Troubleshooting, SQLite recovery](docs/runbook.md)
- [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

**Technical preview:** QuotaFuse cannot atomically query the official remaining
complimentary balance. In the absence of independently confirmed enrollment,
project traffic isolation, input-counter billing behavior and collector health,
it fails closed; there is no automatic paid OpenAI fallback.

QuotaFuse is an independent Apache-2.0 project, not affiliated with OpenAI.
