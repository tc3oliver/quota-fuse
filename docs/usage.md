# Connect to QuotaFuse

The local proxy listens on `http://127.0.0.1:8787` by default. It is not a transparent replacement for the entire OpenAI API.

## Supported endpoints

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/responses` | Stateless multi-turn text; optional separately audited local functions/JSON output; JSON/SSE |
| `POST /v1/chat/completions` | Bounded text-only Chat adapter to Responses; JSON/SSE |
| `GET /v1/models` | Manually verified, currently allowed model IDs |
| `GET /quota` | Guarded local capacity estimate (not official free balance) |
| `GET /health/live` | Process liveness |
| `GET /health/ready` | Whether the safety gates currently allow admission |

Only `/health/live` is unauthenticated. All other endpoints require `Authorization: Bearer <QG_PROXY_TOKEN>`.

## Example: standalone text request

Only send requests after completing [billing validation](billing-validation.md). The request below uses the local token generated in `.env.proxy` without loading the separate Admin key. Run these commands from the repository root in a Bash or Zsh terminal. Replace the example model with an exact, verified model ID configured in your allowlist.

```bash
# Load only the locally generated proxy token into this shell variable.
QG_PROXY_TOKEN="$(node --env-file=.env.proxy -p 'process.env.QG_PROXY_TOKEN')"

curl http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer ${QG_PROXY_TOKEN}" \
  -H 'X-Quota-Guard-Data-Classification: public' \
  -H 'Idempotency-Key: example-request-0001' \
  -H 'Content-Type: application/json' \
  -d '{"model":"YOUR_VERIFIED_MODEL_ID","input":"Explain binary search.","max_output_tokens":256,"stream":false}'
```

The `Idempotency-Key` must uniquely identify one logical request. Reusing it is **rejected**, not transparently replayed. Never automatically retry an uncertain request.

For streaming, set `"stream":true`. QuotaFuse forwards SSE messages and settles usage only after a complete final response event.

## Unsupported input

Stateless Responses requests may include text message arrays with roles `system`, `developer`, `user` and `assistant`. Provide the full history each turn. The restricted Chat endpoint accepts `messages`, `max_completion_tokens` and `n=1`, translating into Responses and its input-token counter.

Local Agent functions use Responses `tools` with `type:"function"`, plus `function_call` and `function_call_output` items across turns. The Agent executes its own Bash, files, git and MCP tools; QuotaFuse never executes tools. OpenAI-hosted tools and remote MCP are always rejected.

**Function Calling eligibility is not established:** OpenAI's complimentary Data Sharing terms exclude tool use. To prevent unexpected charges, `policy.localFunctionsVerified` and `policy.localFunctionsAttestedUntil` are **false/null by default**. Operators must privately establish account-specific eligibility and costs before enabling. No automatic enablement is permitted.

JSON object/schema output formats have separate default-off `structuredTextVerified` / `structuredTextAttestedUntil` gates pending format-specific billing audit. These safety gates require explicit policy review and a compatible SQLite policy fingerprint.

Multimodal input, hosted tools, stored conversations, unsupported Chat options, unbounded outputs and unverified model IDs remain blocked. A full arbitrary OpenAI SDK or Coding Agent workflow is not guaranteed.

## Common errors

| HTTP | Code | Meaning |
| --- | --- | --- |
| 429 | `FREE_QUOTA_EXHAUSTED` | No safe local allowance for the requested reservation |
| 503 | `FREE_QUOTA_UNVERIFIED` | Enrollment, official reconciliation, input count, or outcome uncertain |
| 403 | `MODEL_NOT_ELIGIBLE` | Model not in your verified allowlist |
| 403 | `PAID_FEATURE_BLOCKED` | Unsupported or unverified API feature |
| 403 | `DATA_POLICY_DENIED` | Public data classification header missing |
| 409 | `DUPLICATE_REQUEST` | Idempotency key already used |

An external router can interpret quota errors as a signal to use an **independent provider**, but only at a safe task boundary with no unconfirmed side effects. A 503 is **not** permission to retry paid OpenAI requests. See [troubleshooting](runbook.md).
