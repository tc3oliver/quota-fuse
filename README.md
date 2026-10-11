# QuotaFuse

**A fail-closed quota firewall for LLM APIs.**

[![CI](https://github.com/tc3oliver/quota-fuse/actions/workflows/ci.yml/badge.svg)](https://github.com/tc3oliver/quota-fuse/actions/workflows/ci.yml)
![License](https://img.shields.io/badge/license-Apache--2.0-blue)
![Status](https://img.shields.io/badge/status-v0.1%20experimental-orange)

QuotaFuse is an OpenAI-compatible reverse proxy that **refuses uncertain or potentially chargeable requests rather than silently using paid API tokens**. It tracks guarded capacity with atomic SQLite reservations, a separate Admin Usage API collector, and persistent unknown-outcome accounting. Intended as a bounded provider beneath a *separate* routing layer such as OMP or Pi.

> **Not a zero-charge guarantee.** OpenAI does not provide a real-time atomic reservation endpoint for complimentary Data Sharing tokens. Usage API data may lag, incentive eligibility can change, and direct organization traffic can bypass the proxy. v0.1 is **mock-verified, not cleared for production billing traffic**. Never send credentials, private/company code, or other sensitive data to a Data Sharing-enabled project.

## Status (v0.1.1)

| Capability | State |
| --- | --- |
| Standalone text-only `POST /v1/responses` JSON / SSE | Implemented, mock-tested |
| Exact model allowlist, reject unknown feature/endpoint | Implemented |
| SQLite WAL + `BEGIN IMMEDIATE` atomic admission | Implemented |
| Proxy-controlled output cap, pessimistic provisional reserve | Implemented |
| Exact Responses preflight `/responses/input_tokens` | Gated by explicit cost verification; not live-audited |
| Usage-aware settlement, UNKNOWN retention, idempotency | Implemented |
| Separate Admin Usage API collector + paginated model/project totals | Implemented, mock-tested; single collector lock |
| Local-only auth, public-data attestation, no request body logs | Implemented |
| `/quota`, `/health/live`, `/health/ready`, `/v1/models` | Implemented |
| `POST /v1/chat/completions` | **Explicit 503** until independently validated conservative counter exists |
| OMP fallback provider integration | Contract/demo only; OMP compatibility not verified |
| Real Data Sharing account + Costs audit | **Not performed; NO-GO** |

### Deliberate implementation difference

The supplied initial spec suggested Fastify; this first implementation uses the **Node.js 22 native HTTP API** instead, with TypeScript's built-in type stripping and `node:sqlite`. No production runtime npm dependencies are required, and unit/integration tests run without network access. A subsequent release may adopt Fastify after the same security checks are reproduced. The `node:sqlite` API is still experimental on Node 22; pin/test your runtime. The runtime config is strict **JSON** (`config.example.json`); `config.example.yml` is for spec reference only.

## Quick start (safe default)

```bash
cp config.example.json config.json
# Edit config.json: dedicated project ID, manually verified exact model list,
# and, *only after audit*, explicit safety attestations.
export QG_PROXY_TOKEN="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
# A project key is only needed for an operator-approved live integration:
# export OPENAI_API_KEY=...
npm ci
npm run check
npm run demo  # mock 429 → safe Codex fallback decision, 0 live requests
npm start
```

With the sample config, `/health/ready` returns 503 and all inference requests are **blocked by design**. No actual API calls are made. Tests inject a mock upstream and mock usage collector.

```bash
curl -s http://127.0.0.1:8787/health/live
curl -s -H "Authorization: Bearer $QG_PROXY_TOKEN" http://127.0.0.1:8787/quota
```

A live client **after** all verification gates are satisfied:

```bash
curl http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer $QG_PROXY_TOKEN" \
  -H "X-Quota-Guard-Data-Classification: public" \
  -H "Idempotency-Key: example-00000001" \
  -H "Content-Type: application/json" \
  -d '{"model":"REPLACE_WITH_A_MANUALLY_VERIFIED_MODEL_ID","input":"Explain binary search.","max_output_tokens":256,"stream":false}'
```

All endpoints other than those listed above, multimodal inputs, remote state, tools, function calls, background tasks, `n>1`, unlimited output, aliases, and other advanced request fields are rejected or unsupported. Clients **must supply a stable idempotency key** and public-only classification. This intentionally sacrifices some transparent SDK compatibility for fail-closed semantics.

## Deploying with a real OpenAI account (operator-audited only)

1. Confirm eligibility, enrollment, correct group sizes, positive account balance, the exact eligible model IDs, and that the dedicated project is configured for Data Sharing. Eligibility is **not** inferred from model names. Models are empty by default.
2. Audit whether the separate `/v1/responses/input_tokens` call itself is eligible and nonchargeable for your setup, and whether its counts match the exact allowed request shape. Set `policy.inputCounter` to `responses_preflight` and `policy.preflightCostVerified` to `true` **only after checking actual Costs**.
3. Establish exclusive control of all org traffic eligible for these shared group caps, or treat other project traffic as untrusted and keep the proxy paused. The collector rejects unexpected project/model usage.
4. Set three **expiring** operator attestation timestamps to UTC times after the current time: `eligibilityAttestedUntil`, `exclusiveOrgTrafficAttestedUntil`, `manualCostsAuditedUntil`. These are human operational controls, not proof of eligibility obtained by an API.
5. Use a separate shell/process holding only `OPENAI_ADMIN_KEY` to run `npm run collector -- --once` or the recurring collector. **Never provide the Admin key to the proxy**. Run the proxy with only `OPENAI_API_KEY` (project scoped) and `QG_PROXY_TOKEN`.
6. Check `/health/ready` and `/quota` and manually compare official Dashboard Data Sharing incentive tier and Costs. Small audited traffic only, with an external budget and alerts.

`/quota.estimated_remaining` is **guarded local admission capacity** and **never an official free-balance statement**. Stale collector checkpoints or expired attestations report zero admissible capacity.

## Layout

```text
src/                     Policy, ledger, HTTP transport, collector and CLI
migrations/              SQLite schema
package-lock.json        Pinned dev dependencies for repeatable CI installs
config.example.json      Runtime configuration (deny-by-default)
SPEC.md                  Supplied technical specification
examples/                OMP fallback *contract* demonstration
tests/                   No-live-API unit, integration, failure-injection tests
docs/security.md         Threat model and disclosure
docs/runbook.md         Setup, incidents and operational restrictions
docs/test-matrix.md     Acceptance matrix and explicit gaps
docs/release-checklist.md OSS publish and security-settings checklist
```

## Security and release expectations

This is an **experimental security boundary**, not a paid-API cost guarantee. The
SQLite quota estimator requires an operator-audited, exclusive usage domain and
independent billing checks. Unverified traffic is rejected. An HTTP client
claiming its payload is `public` is an *attestation*, not a DLP scanner. See
[the threat model](docs/security.md) and the
[release checklist](docs/release-checklist.md).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [docs/security.md](docs/security.md). Contributions must preserve fail-closed admission, no automatic paid fallback, and tests without real paid API requests.

## References

- [Official data-sharing incentive and eligibility terms](https://help.openai.com/en/articles/10306912-sharing-feedback-evaluation-and-fine-tuning-data-and-api-inputs-and-outputs-with-openai)
- [Count Responses input tokens](https://developers.openai.com/api/reference/resources/responses/subresources/input_tokens/methods/count)
- [Organization Usage API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/completions)

**Apache-2.0**. This is an independent project, not affiliated with or endorsed by OpenAI.
