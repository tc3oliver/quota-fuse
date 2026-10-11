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

- `dataSharing.projectId`: choose **any existing** API Project ID (`proj_...`). The Data Sharing opt-in can be **All projects**; no dedicated Project is needed to qualify.
- `dataSharing.tier`: confirmed organization tier: `build`, `launch`, or `grow`.
- `quotas.premium.dailyTokens` and `quotas.economy.dailyTokens`: no greater than your tier's daily token allowances. All eligible models in a group share the same cap.
- `quotas.*.models`: prefilled with **all officially listed eligible model IDs** (excluding an explicitly shut-down model). No manual model questionnaire. To opt into a custom allowlist, use `npm run onboard -- --only=gpt-6-sol,gpt-5.6-terra` before starting an operational ledger. Listed models may still be inaccessible on some projects or unsupported on a particular API.
- `policy.safetyPct`: defaults to 85. The project uses a UTC day boundary.

Use `npm run onboard -- --project=proj_YOUR_EXISTING_ID --tier=launch` to set non-secret values. Confirm your actual org tier. A changed persisted ledger policy requires operator reconciliation, not deleting the database. Do not enable `policy.preflightCostVerified` or set future attestation dates until you have followed [billing validation](billing-validation.md), including checking actual Costs and preflight operation. The template intentionally **rejects inference**.

**All projects caution:** complimentary tokens are shared organization-wide, but this release's collector currently rejects cross-project usage and pauses admissions. OpenAI All projects enrollment does not lift that QuotaFuse accounting restriction.

## 3. Configure separate API keys

In `.env.proxy`, fill in `OPENAI_API_KEY` with a **project-scoped** key. Keep the generated `QG_PROXY_TOKEN` unchanged unless rotating it. Do **not** add `OPENAI_ADMIN_KEY` here.

In `.env.collector`, fill in `OPENAI_ADMIN_KEY` with an organization **Admin API Key**. Do **not** add `OPENAI_API_KEY` here. The collector reads the Organization Usage API and cannot spend generation tokens on behalf of the proxy.

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

Review the [billing validation checklist](billing-validation.md), including dedicated-project enrollment, current tier, exact model eligibility, input counter behavior, unexpected Costs, exclusive organization traffic and expiring operator attestations.

**Do not enable live inference based on a successful install or collector poll alone.** OpenAI Usage API is delayed and does not confirm atomically remaining complimentary capacity.

## Common problems

| Symptom | Cause and next step |
| --- | --- |
| `PAUSED` on first launch | Expected: the model allowlist and billing attestations are not verified |
| `npm run status:local` cannot connect | Ensure `npm run start:local` is running on the same host |
| `COLLECTOR_UNVERIFIED` | Confirm Admin key, org permissions, network, full usage pagination and project mapping |
| `POLICY_CHANGED` | A project, tier or model policy changed; follow the [operator runbook](runbook.md), never delete the DB |
| `FREE_QUOTA_EXHAUSTED` (429) | Local admission capacity unavailable; wait for verified reset or use a separate provider at a safe task boundary |
| Unknown outcome retained | Do not repeat or release the request without reviewed evidence; see [recovery](runbook.md) |

### Supported deployment scope

The current implementation supports a **single local Proxy and one Collector per SQLite database**, with SQLite transactions coordinating local writes. Do not share the DB over a network filesystem, run multiple independent quota-fuse databases for the same organization's incentive, or expose this server to the internet. For full compatibility and security constraints see [technical notes](development.md).
