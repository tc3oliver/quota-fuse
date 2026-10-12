# Install and run QuotaFuse

This is the recommended deployment on a **single local host or VM** (macOS/Linux). The proxy binds only to `127.0.0.1`; Docker port publishing and remote access are not supported.

## 1. Install

Install Node.js **22.13 or newer** and npm. From a terminal:

```bash
git clone https://github.com/tc3oliver/quota-fuse.git
cd quota-fuse
npm ci
npm run onboard
```

`onboard` creates `config.json`, `.env.proxy` and `.env.collector` with owner-only permissions where the OS supports them, then prints a no-question checklist. Run `npm run doctor` for a read-only local review. It never overwrites a pre-existing file and generates a new random local access token only when `.env.proxy` is first created. Keep these files private and out of source control. For a checkout migrated from an earlier version, review [the project/tier migration](data-sharing-configuration.md).

## 2. Select your Data Sharing settings

Edit `config.json`:

- `dataSharing.projectId`: choose **any existing** API Project ID (`proj_...`) and dedicate it to QuotaFuse — no other service, key, or workspace may use it. The Data Sharing opt-in can be **All projects**; no dedicated Project is needed to qualify, but the routing project itself must be exclusive. Attest with `policy.proxyProjectDedicatedAttestedUntil` after a Dashboard activity review.
- `dataSharing.tier`: confirmed organization tier: `build`, `launch`, or `grow`.
- `quotas.premium.dailyTokens` and `quotas.economy.dailyTokens`: no greater than your tier's daily token allowances. All eligible models in a group share the same cap.
- `quotas.*.models`: **both empty by default**, meaning no model-ID whitelist. Unknown IDs are conservatively charged against the smaller Premium token budget, but **may still incur actual charges** if ineligible for Data Sharing. A whitelist is optional: `npm run onboard -- --premium=gpt-6-sol --economy=gpt-5.6-terra` before ledger initialization.
- `policy.safetyPct`: defaults to 85. The project uses a UTC day boundary.
- `policy.externalSafetyReserve`: per-group conservative token bound for external-service consumption during official stats delay plus the 120s poll interval. Required; estimate from peak external rate × (delay + interval + margin). No credible bound means no admission.

Use `npm run onboard -- --project=proj_YOUR_EXISTING_ID --tier=launch` to set non-secret values. Confirm your actual org tier. Read [agent install](agent-install.md) for an agent-guided, minimal-question setup. A changed persisted ledger policy requires operator reconciliation, not deleting the database. Do not enable `policy.preflightCostVerified` or set future attestation dates until you have followed [billing validation](billing-validation.md), including checking actual Costs and preflight operation. The template intentionally **rejects inference**.

**Shared-pool note:** complimentary tokens are shared organization-wide. Other production services may call OpenAI directly without passing QuotaFuse and **must never be interrupted by it**; QuotaFuse only gates its own interruptible workload. Their usage is recorded as external scope and tightens admission via `effective_used` — the collector keeps polling every 120s regardless. Size `policy.externalSafetyReserve` to cover their peak consumption during stats delay.

## 3. Configure separate API keys

For a simpler setup, the **user** can open an independent local Terminal and
run `npm run configure:local`. This single wizard guides missing Project ID,
optional org tier and both API Keys; the keys are not echoed or copied into
an agent chat. Existing keys are preserved. It refuses redirected input. If Proxy or Collector was previously started with a placeholder Project, stop both before configuring: an empty PAUSED ledger can be rebound safely; any ledger with history requires operator review.
Agents must **never** invoke the wizard inside their captured PTY.


### Which permissions should the two API keys have?

| Local file | Key and permissions |
| --- | --- |
| `.env.proxy` | **Project API Key** (`OPENAI_API_KEY`): allow the necessary inference operations, including `POST /v1/responses` and the `POST /v1/responses/input_tokens` preflight counter (and Chat Completions if used). A **Read Only** Project key cannot perform inference. Prefer `Restricted` with only the required request permissions if available; otherwise review the smallest working scope. |
| `.env.collector` | **API Platform Organization Admin Key** (`OPENAI_ADMIN_KEY`): only needs to read `GET /v1/organization/usage/completions`. When offered, choose **Read Only**, or **Restricted / Organization Usage: Read** (use the closest actual permission label shown). Do **not** enable write, user-management, project-management or key-management permissions for the collector. |

Create the Project key from [API Platform → Projects](https://platform.openai.com/settings/organization/projects) → your chosen Project → API Keys. Create the separate organization Admin key in [API Platform → Organization Admin Keys](https://platform.openai.com/settings/organization/admin-keys); only an API Platform Organization Owner can create it. **A ChatGPT Admin Console / workspace Admin key is a different product and will not work here.**

The Admin-key permission choices can differ from ordinary Project-key dialogs. If the API Platform does not offer a clear read-only or Usage-read scope, **do not assume that `All` is required or select it automatically**: stop and ask the organization owner to verify the minimum supported scope. If the Collector receives 401/403, check its API Platform Organization and the required Usage-read permission before broadening access. Never auto-upgrade or re-create a key with All permissions to clear a `PAUSED` state.

In `.env.proxy`, fill in `OPENAI_API_KEY` and keep the generated `QG_PROXY_TOKEN` unchanged unless rotating it. Do **not** add `OPENAI_ADMIN_KEY` here.

In `.env.collector`, fill in the separate organization `OPENAI_ADMIN_KEY`. Do **not** add `OPENAI_API_KEY` here. The Collector only makes read-only Organization Usage requests.

OpenAI reference: [API Platform Admin key permissions](https://help.openai.com/en/articles/9687866) and [Project key permissions](https://help.openai.com/en/articles/8867743-assign-api-key-permissions).

These are separate processes with different environment variables, but local files under the same OS user are **not an isolation boundary against a compromised user account**. Protect shell history and backups accordingly. Restrict project key permissions and revoke compromised credentials at OpenAI.

## 4. Start both services

Open two terminals in the repository root:

```bash
# Terminal A
npm run start:local
```

```bash
# Terminal B
npm run collector:local
```

The collector attempts a first usage read immediately, then polls every 120 seconds. Keep one running collector for this database. The proxy persists its SQLite ledger in `data/` by default; protect and back up this directory, including WAL data, using a consistent SQLite backup strategy. **Never delete the ledger to reset a quota or UNKNOWN outcome.**

Check the local service from another terminal:

```bash
npm run status:local
curl -s http://127.0.0.1:8787/health/live
```

`/health/live` reports process liveness, not billing readiness. `npm run status:local` shows **READY** only when safety gates pass; on a new setup it reports **PAUSED**. The displayed numbers are *conservative local admission capacity*, not official remaining complimentary tokens.

To stop, use Ctrl+C in each service terminal and preserve `data/`.

## 5. Confirm before sending any real requests

Review the [billing validation checklist](billing-validation.md), including your existing All projects or selected-project enrollment, current tier, exact model eligibility, routing-project dedication evidence, input counter behavior, unexpected Costs, external-service consumption bounds and expiring operator attestations.

**Do not enable live inference based on a successful install or collector poll alone.** OpenAI Usage API is delayed and does not confirm atomically remaining complimentary capacity.

## Common problems

| Symptom | Cause and next step |
| --- | --- |
| `PAUSED` on first launch | Expected: the billing attestations and collector readiness are not verified |
| `npm run status:local` cannot connect | Ensure `npm run start:local` is running on the same host |
| `COLLECTOR_UNVERIFIED` | Confirm Admin key, org permissions, network, full usage pagination and model mapping. External bypass traffic is legitimate and never the cause — do not throttle other services |
| `POLICY_CHANGED` | A project, tier, model or reserve policy changed; follow the [operator runbook](runbook.md), never delete the DB |
| `FREE_QUOTA_EXHAUSTED` (429) | Local admission capacity unavailable; wait for verified reset or use a separate provider at a safe task boundary |
| Unknown outcome retained | Do not repeat or release the request without reviewed evidence; see [recovery](runbook.md) |

### Supported deployment scope

The current implementation supports a **single local Proxy and one Collector per SQLite database**, with SQLite transactions coordinating local writes. Do not share the DB over a network filesystem, run multiple independent quota-fuse databases for the same organization's incentive, or expose this server to the internet. For full compatibility and security constraints see [technical notes](development.md).
