# Coding-agent access (OpenCode) via the local adapter

QuotaFuse speaks `POST /v1/responses` and a bounded `POST /v1/chat/completions`
adapter. A coding agent such as OpenCode can use it **only** through the local
adapter shim (`examples/opencode-adapter.mjs`), never directly.

## Why the adapter is mandatory

1. **Dynamic `Idempotency-Key`.** QuotaFuse requires a *unique* key per logical
   request; reuse is rejected with `409 DUPLICATE_REQUEST`, never replayed.
   OpenCode's static provider `headers` cannot mint a fresh key per request
   (verified against OpenCode v2.0.26). The adapter assigns a key to requests
   that lack a valid one, while reusing the same key for byte-identical HTTP
   retries within 10 minutes. This best-effort replay guard is **not durable**
   across adapter restarts: do not blindly retry uncertain outcomes.
2. **Explicit public-data attestation.** QuotaFuse only permits material the
   client deliberately classifies as `public`. The adapter **never adds**
   `X-Quota-Guard-Data-Classification` for you. The sample OpenCode provider
   below explicitly adds it; **only use that configuration with a public,
   disposable test workspace**. Do not use it to process proprietary source
   code, credentials, private documents, or other non-public data.
3. **Bounded output.** OpenCode's title/summary calls omit
   `max_completion_tokens`; the proxy fail-closed rejects unbounded requests.
   The adapter injects a small default (`QF_DEFAULT_MAX_TOKENS`, default 256).
   Main agent turns already carry `max_completion_tokens` from the model limit
   and pass through untouched.
4. **Wire-shape tolerance.** OpenCode (via `@ai-sdk/openai-compatible`) sends
   `store: false` and `stream_options: {include_usage: true}` on every Chat
   request. The proxy accepts exactly these billing-neutral values and never
   forwards them upstream; anything else (e.g. `store: true`) is still rejected.

## Setup (local only, no real traffic until billing is validated)

```bash
# 1. proxy (terminal 1) — paused until docs/billing-validation.md is complete
npm run start:local

# 2. adapter (terminal 2) — 127.0.0.1 only, forwards to the proxy
node examples/opencode-adapter.mjs --listen 127.0.0.1:18878 --target http://127.0.0.1:8787
```

Create a project-local `opencode.jsonc` **only inside the public test fixture**.
The real OpenCode provider fields are `provider`, `npm` and `options`
(not `providers`, `package`, `settings`). See the
[official OpenCode custom provider docs](https://docs.opencode.ai/docs/providers/).

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "quotafuse": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "QuotaFuse (public-only)",
      "options": {
        "baseURL": "http://127.0.0.1:18878/v1",
        "apiKey": "{env:QUOTAFUSE_PROXY_TOKEN}",
        "headers": {
          "X-Quota-Guard-Data-Classification": "public"
        }
      },
      "models": {
        "YOUR_VERIFIED_MODEL_ID": {
          "name": "Verified Data Sharing Model",
          "limit": { "context": 32000, "output": 2048 }
        }
      }
    }
  }
}
```

```bash
QUOTAFUSE_PROXY_TOKEN="$(node --env-file=.env.proxy -p 'process.env.QG_PROXY_TOKEN')" \
  opencode run --standalone -m quotafuse/YOUR_VERIFIED_MODEL_ID "Read the public fixture file"
```

The `models` key and `-m` model name must use an exact model ID from the automatically populated Data Sharing catalog in `config.json` (or the user's narrower allowlist). The user does not need to copy every eligible model ID into OpenCode; select just the model they want to run. The chosen model must also be available to their API project and support this adapter's request format. Do not set the `public` header
in an existing private work repository. Never put real API credentials in the
OpenCode config; `QUOTAFUSE_PROXY_TOKEN` is only the local proxy token.

## Verified behaviour

`npm run test:agent` runs the in-process Mock HTTP harness with real
local filesystem/subprocess tools; it **does not itself launch OpenCode**.
A separate manual test invoked the actual OpenCode v2.0.26 binary against
the adapter and a mocked upstream. The adapter and provider configuration
should be retested when OpenCode changes request shapes.

- Multi-turn history and local function schemas pass preflight and generation.
- `function_call` → agent executes the tool locally (fs read, subprocess) →
  `function_call_output` / `role: tool` → model continues to a final answer.
- Parallel tool calls, Chat JSON and SSE streaming (including tool-call deltas).
- Token reservation and settlement from provider `usage`; reused keys get 409
  with zero redispatch; hosted tools, remote MCP and image/audio are 403 with
  zero upstream calls; quota exhaustion, upstream errors and timeouts stay
  fail-closed (`UNKNOWN` reservations are never auto-retried).

The prior manual OpenCode binary run completed a genuine local `read` tool
execution through proxy + adapter + mock upstream. That result is distinct
from the automated mock loop suite; it does not establish live API or billing
safety. After changing the classification requirement, the OpenCode config
must explicitly supply the `public` header as shown above.

## Billing caveat

Local function declarations/arguments/results consume ordinary model tokens and
go through the same allowlist, preflight, reservation and collector gates, but
**whether these tokens qualify for the Data Sharing incentive is unconfirmed**
(the offer excludes "tool use" without clarifying client-side function calls).
Adapter admission is not proof of zero cost. Complete
[docs/billing-validation.md](billing-validation.md) before any live traffic.
