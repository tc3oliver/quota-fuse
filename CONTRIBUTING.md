# Contributing

Welcome security-minded patches, protocol conformance fixes, more fault-injection coverage, and minimal reproducible tests.

1. Open a focused issue describing the potential billing/privacy effect before extending the allowlist or request surface.
2. Branch from `main`, keep changes small, run `npm run check` (Node 22+), and include offline tests demonstrating that uncertain cases **deny rather than dispatch**.
3. Submit a PR with risk, compatibility, security impact, and migration/rollback notes.
4. Never include live organization IDs, prompts, API keys, or private business data in tests or issues. Keep real OpenAI API tests opt-in, credential-isolated, and outside CI.
5. No silently enabled paid fallback, unknown tool fields, implicit model aliases, repeated ambiguous upstream requests, or unverified free-token assumptions.

By contributing, you agree to license contributions under Apache-2.0.
