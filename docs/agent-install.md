# Install / update QuotaFuse with an AI coding agent

**For OpenCode, Codex, Claude Code and other coding agents.** The
[README](../README.md) is a quick-start. This document is the full set of
installation and safety instructions. Complete non-sensitive work without
asking a long questionnaire; do not stop at a plan.

## Agent task

1. Detect the OS, Node.js >=22.13, npm and current OpenCode. Find the existing
   checkout or clone the official repository if missing. Inspect the working
   tree and branch. Update with `git pull --ff-only` only if safe; never discard
   local changes, force-reset, or delete/replace an operational SQLite ledger.
2. From the repo root run:

   ```bash
   npm ci
   npm run onboard
   npm run doctor
   npm run check
   npm run test:agent
   ```

   These are offline by default. `onboard` creates missing Git-ignored
   configuration files and prints a concise checklist; `doctor` is read-only.
3. Do **not** ask users to compile or paste eligible model lists. The
   default has no model whitelist, with the important billing warning below.
4. Complete all offline checks without waiting for credentials. If a
   Project or API key is missing, tell the user to open their **own local
   Terminal** (outside the agent tool / session recording) and run
   `npm run configure:local`. This one terminal wizard collects an existing
   routing Project, optional confirmed tier, and any missing keys with
   **no terminal echo**. Do not request the key values in chat, run the wizard
   yourself through a PTY, or capture the user's terminal input.
   After the user returns, run `npm run doctor` and continue automatically.
5. Do not create an automatic startup service, enable live inference,
   approve billing attestations or execute even a small real OpenAI API
   request without specific user approval. Offline setup can continue without
   any of these steps.
6. After configuration, guide local Proxy, collector, and OpenCode adapter
   startup; verify actual process health and identify exact PAUSED reasons.
   Finish with a status report rather than another questionnaire.

## Data Sharing enrollment: support BOTH choices

**The Data Sharing scope is not the API routing project.** OpenAI may enroll:

- **All projects:** The user already shares enabled data across their
  organization. Select **any existing** API Project as QuotaFuse's routing
  Project. Do not require a dedicated new Project.
- **Selected projects / single project:** Select **one of the Projects already
  opted into Data Sharing**. Never assume another Project is eligible solely
  because it belongs to the same Organization.
- **Scope uncertain:** Finish the offline install; keep live requests PAUSED
  until the Project's eligibility is independently confirmed.

Never ask to re-verify a previously established enrollment. There is
no need to ask about All vs Selected if an eligible routing Project
has already been independently verified and configured.

QuotaFuse currently requires `dataSharing.projectId=proj_...` in
`config.json` even when the OpenAI setting is All projects. It uses ONE
Project per SQLite ledger and all token entitlements are still
**organization-wide**, shared across every opted-in project. The current
collector PAUSES if it observes other-project usage; do not disable this
safety condition just to support All projects enrollment.

Only if routing ID is missing, provide:
https://platform.openai.com/settings/organization/projects

Explain "Choose an existing Project (if Selected projects, one already
sharing data). Enter only the Project ID, not an API Key. You can add
it after offline setup."

Only if org tier is unknown, ask whether Build, Launch, or Grow. Start at
Build's conservative caps (250K Premium / 2.5M Economy); confirmed
Launch/Grow allows 1M / 10M before the `safetyPct=85` ceiling.

```bash
npm run onboard -- --project=proj_EXISTING_ID --tier=launch
```

Never guess the tier from the account's ChatGPT plan or model names.

## Models: unrestricted by default, allowlist OPTIONAL

The template intentionally has `models: []` in both Premium and Economy.

- **Both lists empty**: All syntactically valid exact model IDs pass the model
  filter; no model list questionnaire is needed.
- **Either list populated**: Together the lists become a **strict whitelist**;
  all other IDs are blocked.
- **Unrestricted is NOT guaranteed free**: models outside the Data Sharing
  incentive, or unsupported request shapes, can generate API charges even
  below the proxy's local token cap. The other `FREE_ONLY` gates do not
  certify that arbitrary models qualify for complimentary tokens.
- **Conservative accounting**: With no whitelist, every model's input and
  output tokens are charged to the smaller **Premium** local token
  bucket, both in the proxy reservation and the organization collector.
  This protects token *quantity*, not pricing.

Optional whitelist, only if requested by the user and the exact IDs and
Premium/Economy group are confirmed from the official model list:

```bash
npm run onboard -- --premium=gpt-6-sol --economy=gpt-5.6-terra
npm run onboard -- --allow-all  # no filter again before ledger creation
```

Official Data Sharing rules, model lists and exclusions:
https://help.openai.com/en/articles/10306912-sharing-feedback-evaluation-and-fine-tuning-data-and-api-inputs-and-outputs-with-openai

In unrestricted mode `GET /v1/models` returns an empty list instead of
inventing model names. OpenCode still needs a **specific model ID** in its
provider configuration. The installed client must confirm availability,
eligibility and protocol support for that model before live traffic.

## One-command private local configuration

```bash
# The USER runs this in a separate local Terminal, never through an agent tool:
npm run configure:local
```

If the Agent previously started Proxy/Collector while the Project ID was
still a placeholder, **stop both services first**. Onboarding can safely
rebind a **pristine, paused** SQLite ledger with zero reservations, zero
official observations and zero audit entries; it never deletes data or
rewrites a ledger with usage history. A running lock or nonempty ledger
continues to block policy changes. Never remove lock files by hand.

The wizard does **not** call OpenAI, print keys, or mark billing checks verified.
It skips already configured keys, preserves permissions, and only needs a
routing Project ID when missing. The Project ID is an ordinary configuration
value; the two API Keys are secrets. If a local TTY is unavailable, the
wizard refuses to accept redirected/piped credentials. An agent should
finish offline tests while the user provides these details, then recheck.

## Secrets, policy gate, and live startup

- `.env.proxy`: Project-scoped `OPENAI_API_KEY` must be permitted to make the required POST inference/preflight requests. **Do not recommend Read Only** for this key; use the minimum functional Restricted scopes where available. Keep the generated `QG_PROXY_TOKEN` unchanged.
- `.env.collector`: separate **API Platform Organization** `OPENAI_ADMIN_KEY` is for `GET /v1/organization/usage/completions` only. When available recommend **Read Only**, or `Restricted` with **Organization Usage: Read**; use the UI's actual permission labels rather than inventing them. No write, organization-user, project-management or API-key administration privileges are needed.
- Admin keys are created at https://platform.openai.com/settings/organization/admin-keys by an API Platform Organization Owner. **Do not confuse this with a ChatGPT Admin Console workspace key.** For permission details see https://help.openai.com/en/articles/9687866 .
- If those least-privilege controls are missing or the collector gets 401/403, explain the exact blocker. Do **not** suggest choosing `All` blindly or automatically broaden the key; have the owner inspect the supported scopes before proceeding.
- The Agent must only check that keys are **present**; it cannot infer their actual permissions from the key string. Never ask for secret values in
  chat, reveal them, embed them in logs, commit them or mix the two environments.
- `inputCounter=reject`, `preflightCostVerified=false` and null expiring
  attestations intentionally block requests on a fresh installation.
  Do not set them for convenience.
- Respect past verified enrollment without demanding a repeat, but only
  mark other gates after independently verified evidence: token counter
  billing behavior, unexpected Costs, model eligibility, organization traffic
  isolation and a complete, current collector baseline.
- A Project budget does not guarantee a real-time hard spending stop.

Review [billing validation](billing-validation.md) and
[deployment](deployment.md) before any live request.

After credentials/configuration and the remaining evidence-based gates
are complete, use distinct processes:

```bash
npm run start:local
npm run collector:local
node examples/opencode-adapter.mjs --listen 127.0.0.1:18878 --target http://127.0.0.1:8787
npm run status:local
```

Check `/health/live`, `/health/ready` and `/quota`. Distinguish process
liveness from admission READY. Run only one collector for a ledger. Don't
clear SQLite reservations/UNKNOWN to make the service READY.

For OpenCode, follow [opencode-agent.md](opencode-agent.md). Use a
**disposable public-data fixture** with an explicit public-data header.
Never globally attest that private/company code is public. Use
`npm run test:agent` for zero-upstream-cost mock testing. A real OpenAI
trial can incur charges, so obtain explicit user approval first. Ask permission before installing launchd/systemd automatic startup. Launchd
is a **post-setup option**: never treat approval as a prerequisite for Proxy
or Collector readiness.

## Final report (no vague remaining-work list)

Report version, checkout changes, local tests, existing Project/tier,
model filter **unrestricted** or **whitelist**, key-presence only, status of
Proxy/Collector/Adapter, READY/PAUSED with exact reason, OpenCode E2E result
and outstanding actions. Ask a single next question only when an answer
is required to continue.

## Upgrade safety: model accounting and dispatched UNKNOWN

Fresh configs classify the 33 explicitly documented incentive model IDs
into their respective groups, without a whitelist. Existing ledgers retain
Premium-only accounting; **do not rewrite the policy fingerprint or migrate
a running Ledger to the new `official_v1` mode**. Unknown models are not
certified free. Other production services may share the org pool without
passing QuotaFuse — record their load in `policy.externalSafetyReserve`,
never throttle them, and never treat their usage as a collector fault.
Read [the recovery runbook](runbook.md#reviewed-dispatched-unknown-at-utc-rollover)
for strict terminal-response evidence requirements, a full UTC-day billing
cooldown, and an audited dispatched-day UNKNOWN review. Do not automatically
execute reconciliation or alter any real ledger without explicit approval.

To migrate an existing Premium-only ledger, do **not** edit the new option
manually. Read [audited accounting upgrade](runbook.md#audited-legacy-to-official-group-accounting-upgrade)
and seek explicit operator approval. `npm run accounting:upgrade` is never
an installation task; it requires downtime, an unused new UTC day, durable
backups and externally verified Usage and Costs.
