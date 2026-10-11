# Coding-agent access (OpenCode) via the local adapter

QuotaFuse speaks `POST /v1/responses` and a bounded `POST /v1/chat/completions`
adapter. A coding agent such as OpenCode can use it **only** through the local
adapter shim (`examples/opencode-adapter.mjs`), never directly.

## Why the adapter is mandatory

1. **Dynamic `Idempotency-Key`.** QuotaFuse requires a *unique* key per logical
   request; reuse is rejected with `409 DUPLICATE_REQUEST`, never replayed.
   OpenCode's static provider `headers` cannot mint a fresh key per request
   (verified against OpenCode v2.0.26: `headers` are string constants, and the
   agent loop issues one LLM request per step plus title/summary calls). The
   adapter stamps `Idempotency-Key: <uuid>` on every POST that lacks a valid one.
2. **Classification attestation.** The adapter defaults
   `X-Quota-Guard-Data-Classification: public` when the client sends none. It
   never overrides an explicit client value.
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

```jsonc // opencode.jsonc (project-local; credential is the PROXY token, not OpenAI)
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "quotafuse": {
      "name": "QuotaFuse",
      "env": ["QUOTAFUSE_PROXY_TOKEN"],
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:18878/v1" },
      "models": {
        "agent-model": {
          "modelID": "YOUR_VERIFIED_MODEL_ID",
          "limit": { "context": 32000, "output": 2048 },
        },
      },
    },
  },
}
```

```bash
QUOTAFUSE_PROXY_TOKEN="$(node --env-file=.env.proxy -p 'process.env.QG_PROXY_TOKEN')" \
  opencode run --standalone -m quotafuse/agent-model "your task"
```

`modelID` must be an exact model ID from your verified `config.json` allowlist.

## Verified behaviour (mock upstream, `npm run test:agent`)

- Multi-turn history and local function schemas pass preflight and generation.
- `function_call` → agent executes the tool locally (fs read, subprocess) →
  `function_call_output` / `role: tool` → model continues to a final answer.
- Parallel tool calls, Chat JSON and SSE streaming (including tool-call deltas).
- Token reservation and settlement from provider `usage`; reused keys get 409
  with zero redispatch; hosted tools, remote MCP and image/audio are 403 with
  zero upstream calls; quota exhaustion, upstream errors and timeouts stay
  fail-closed (`UNKNOWN` reservations are never auto-retried).

A live end-to-end run with the real OpenCode binary (mock upstream) completed a
genuine local `read` tool execution through proxy + adapter. HTTP-mock loop
tests and the real-binary run are reported separately; mock results are never
presented as real-binary success.

## Billing caveat

Local function declarations/arguments/results consume ordinary model tokens and
go through the same allowlist, preflight, reservation and collector gates, but
**whether these tokens qualify for the Data Sharing incentive is unconfirmed**
(the offer excludes "tool use" without clarifying client-side function calls).
Adapter admission is not proof of zero cost. Complete
[docs/billing-validation.md](billing-validation.md) before any live traffic.
