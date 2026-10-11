# Development notes

This page is for contributors and reviewers. See the [README](../README.md) for installation and normal usage.

## Implementation

The first version uses Node.js native HTTP and `node:sqlite` with TypeScript's built-in type stripping; it does not use Fastify. The SQLite API on Node.js 22 is experimental. The project is designed for one local process and a distinct Admin Usage collector, not a distributed quota service.

The current contract supports stateless text-only Responses arrays and a bounded Chat JSON/SSE adapter. Local functions and structured JSON formats require separate, expiring billing eligibility checks before real upstream requests; hosted tools and multimodal are still blocked. End-to-end OMP/OpenCode compatibility is not yet verified.

## Development commands

```bash
npm ci
npm run check
npm run demo
```

`npm run check` runs TypeScript checks and offline unit/integration/fault tests. `npm run demo` exercises a local mock fallback path; it **does not prove real API billing behavior**. CI runs on Node.js 22 and 24. Keep `@types/node` and TypeScript on their reviewed major versions; Dependabot may update them within each major. Upgrade both majors deliberately after compatibility testing.

## Review criteria

- Proxy must fail closed if any eligibility, cost, input counting, usage or storage condition is untrusted.
- No transparent replay of unknown upstream outcomes and no automatic paid fallback.
- Preserve idempotency keys and non-released UNKNOWN reservations.
- Keep project keys and Admin keys in separate runtime processes.
- Do not log prompt bodies, token secrets or private data.
- Any new model/feature shape requires a credible token counting upper bound and documented billing evidence.

For design details use [SPEC.md](../SPEC.md), [threat model](security.md), [test matrix](test-matrix.md) and [billing validation](billing-validation.md).
