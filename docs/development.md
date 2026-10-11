# Development notes

This page is for contributors and reviewers. See the [README](../README.md) for installation and normal usage.

## Implementation

The first version uses Node.js native HTTP and `node:sqlite` with TypeScript's built-in type stripping; it does not use Fastify. The SQLite API on Node.js 22 is experimental. The project is designed for one local process and a distinct Admin Usage collector, not a distributed quota service.

The current contract handles text-only Responses API inputs. Chat Completions, tool calls, multimodal, persistent conversation state and live OMP provider compatibility are unverified. These interfaces are intentionally blocked instead of silently activating paid features.

## Development commands

```bash
npm ci
npm run check
npm run demo
```

`npm run check` runs TypeScript checks and offline unit/integration/fault tests. `npm run demo` exercises a local mock fallback path; it **does not prove real API billing behavior**. CI runs on Node.js 22 and 24.

## Review criteria

- Proxy must fail closed if any eligibility, cost, input counting, usage or storage condition is untrusted.
- No transparent replay of unknown upstream outcomes and no automatic paid fallback.
- Preserve idempotency keys and non-released UNKNOWN reservations.
- Keep project keys and Admin keys in separate runtime processes.
- Do not log prompt bodies, token secrets or private data.
- Any new model/feature shape requires a credible token counting upper bound and documented billing evidence.

For design details use [SPEC.md](../SPEC.md), [threat model](security.md), [test matrix](test-matrix.md) and [billing validation](billing-validation.md).
