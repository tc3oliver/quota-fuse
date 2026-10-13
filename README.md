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
The Collector Admin Key should use **read-only Organization Usage permission where supported**; the Project key needs inference POST access. See [deployment permissions](docs/deployment.md#which-permissions-should-the-two-api-keys-have).
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
accounted using the published Premium/Economy group mapping for **new installations**.
Unknown models use the smaller Premium bucket. Existing installations retain
the older Premium-only accounting until a reviewed migration; the usual
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
organization-wide. **Other production services may legally call OpenAI
directly without passing QuotaFuse; their usage shares the same org pool
and tightens QuotaFuse admission. It never pauses the collector.**
QuotaFuse must never be given a reason to interrupt those services.

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
complimentary balance. It fails closed without independently confirmed
enrollment, input-counter billing behavior and
collector health; there is no automatic paid OpenAI fallback. The routing
project may be shared with other services — shared usage is absorbed
conservatively, never assumed free. The collector polls organization usage
every 120s, but official statistics may lag, so admission adds a configured
`externalSafetyReserve` per group and `estimated_remaining` is a
conservative local admission estimate — never an official free-balance
promise, and never a zero-fee guarantee under unbounded external traffic.

**Local Function Calling is supported and operationally approved**
based on 2026-10-12 live verification: function-call
generation and tool-loop continuation tokens on the tested model landed in the
Data Sharing `incentivized-tier`, and the closed-day Costs book confirmed
US$0.00 with no tool-execution charges. Agents use local functions (Bash,
files, git) normally without re-confirming this risk (tested shapes only).
OpenAI-hosted tools stay blocked;
see [billing validation](docs/billing-validation.md).

QuotaFuse is an independent Apache-2.0 project, not affiliated with OpenAI.

### Accounting and lifecycle carry

New installs have `dataSharing.modelGroupAccounting: "official_v1"`; both
`models: []` lists still mean *no whitelist* — and the whitelist, when
populated, gates **Proxy admission only** (`policy.classify` unchanged). The
Collector classifies every project's usage through the reviewed official group
map, never stops on an out-of-whitelist model, and records unmapped models in
`external_unknown_models` diagnostics.
Older config files stay on
Premium-only accounting to preserve SQLite fingerprints and old official
baselines. Do **not** flip accounting modes directly on a live ledger.
See [UTC-day lifecycle carry](docs/runbook.md#cross-day-lifecycle-carry-windowed-deductions-expire-on-proof).


Existing production Ledgers can switch to the published group mapping with
[the explicit operator-reviewed new-day upgrade](docs/runbook.md#audited-legacy-to-official-group-accounting-upgrade).
No automatic migration or resetting SQLite is performed.

### Organization-shared accounting

The org pool is shared with production services that bypass the proxy.
Per UTC day and group, QuotaFuse tracks official proxy-scope usage,
official external-scope usage, and local committed reservations, and admits only when:

`effective_used = official_proxy + official_external_known + unknown_external + outstanding + settled + cross_day_carry + reserve`

`remaining = max(0, floor(daily_limit × safety_pct) − effective_used)`

Same-day `settled` (actual) and `outstanding` (reserved) are added **in full**
on top of the official reading. An official increment is **never** treated as
proof that local completions were reflected: under mixed-project traffic the
same official tokens could be foreign (counterexample: settled 100 unreflected
+ same-project external 100 + official 100 → count 200 + reserve, never net
down). Utilization cost, accepted deliberately: already-reflected settled
tokens are deducted twice (safe direction — capacity can only shrink, never
inflate). The `proxy_unreflected_tokens` snapshot field is removed.

Unknown models (outside the reviewed official group map, in **any** project —
proxy or external) form a
single group-independent daily total counted into **both** groups'
`effective_used`, keeping each group's upper bound safe (a premium-only
fallback would undercount Economy); confirmed groups
are never double-subtracted, diagnostics are retained, and any safe-int
overflow fails closed as `INVALID_USAGE`. `cross_day_carry` counts only
**DISPATCHED-phase** prior-day unresolved reservations
(PENDING/UNKNOWN/MANUAL_REVIEW, reviewed-day exemption aside) whose enforced
execution window (`EXECUTION_WINDOW_MS` = 30000 preflight abort + 120000
upstream abort + 5000 clock skew = 155000ms, enforced in `server.ts`) still
reaches the new day's midnight — i.e. `admitted_at ≥ day-00:00Z − 155000ms`.
PREFLIGHT-phase rows never left the proxy, provably consumed zero, and are
never carried. A timeout alone releases nothing: every day the window overlaps
keeps the full reserve deducted. History, idempotency and UNKNOWN rows are
preserved, never re-sent or forged COMPLETED. An optional
`reviewDispatchedDay` review can conservatively narrow a *proven*
DISPATCHED UNKNOWN bounded to its original day; day-to-day recovery never
needs it or its 24h cooldown. Residual risk is stated, not hand-waved:
provider-side continuation after a client abort is possible; the
`store:false` abort-as-cancel reading is an assumption premise. Configure `policy.externalSafetyReserve` per group as the conservative
upper bound for external consumption during official visibility delay plus
the 120s poll interval. QuotaFuse only gates its own admissions; it never
limits, stops, or modifies external services. The routing project **may be
shared with other services**: no project dedication is required or gated.
Collection and admission are separate duties: the model whitelist
(`policy.classify`) gates **Proxy admission only**; the Collector classifies
every project's usage through the reviewed official group map, never stops on
an out-of-whitelist model, and records unmapped models in diagnostics.
`proxyProjectDedicatedAttestedUntil` and related attestations remain in old
configs for compatibility only and are no longer admission gates.
The collector polls every 120s.
Upgrading from a pre-shared-accounting release changes the policy
fingerprint: run the audited in-place migration
(`npm run accounting:shared-migration`, history fully preserved) — see the
[runbook](docs/runbook.md).
