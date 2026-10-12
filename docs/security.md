# Security and privacy architecture

## Protected assets

- Dedicated OpenAI **project** key (only Proxy process). Admin Usage key (only Collector process).
- Data Sharing status, shared group quota capacity, privacy of prompts/outputs, durable reservation ledger.
- Persistent SQLite `UNKNOWN` reservations and reconciled watermarks.

## Threat model

| Threat | Control / residual risk |
| --- | --- |
| New or paid model / unknown tool | Exact manual allowlist; strict request-shape check; deny extras |
| Unbounded output / unseen reasoning tokens | Required `max_output_tokens`, server cap, account margin; validate actual usage |
| Two concurrent clients oversubscribe remaining quota | `BEGIN IMMEDIATE` serialized check + insert |
| Upstream ambiguous response / stream disconnect / restart | Keep reservation `UNKNOWN` forever until explicitly reviewed; never auto replay |
| Admin API stale or unavailable | Persist pause on collector error; checkpoint age gate, exclusive collector lock |
| Watermark goes backwards | Reject regression and pause collector |
| Bypass by other org projects | External scope recorded + `externalSafetyReserve` bound; collector never stops on bypass traffic; cannot prevent bypass at OpenAI |
| Prompt or output contains private data | All clients MUST attest `public`; **no reliable automated sensitive-data detection in v0.1** |
| Header spoofing / arbitrary URL SSRF | Fixed upstream origin, no redirects, server-generated auth headers, local host binding |
| Hostile local process | Bearer token; local network access alone is not authorization; operating-system file permissions and secret storage remain operator tasks |
| Lost host / disk corruption | Fail closed; external encrypted backup recommended, secrets not stored in SQLite |
| Unexpected price outside proxy | External account budget limits and cost alerting remain necessary; not guaranteed hard stops |
| Malicious config | Config admin is a trust boundary; changing allowlist or attestations intentionally grants privileges |

The collector summarizes **organization usage**, which is not a real-time incentive-reservation API. `effective_used = official_external + max(official_proxy, verified_proxy_baseline + proxy_local_committed) + external_safety_reserve` is conditional on a **complete independently validated baseline** for both scopes, a credible external-traffic bound, and ongoing monitoring. Admin Usage cannot prove these preconditions or report an atomic complimentary balance. Under unbounded external traffic it cannot guarantee zero fees. A request crossing the threshold may be billed as a whole. This proxy is a risk-reduction device, not a billing enforcement primitive supplied by the provider.

## Lifecycle

- PREFLIGHT/PENDING/UNKNOWN outcomes retain their original-day reservation and block rollover to the next UTC day.
- SQLite stores a fingerprint of project ID, quotas, model lists, counters and caps; policy drift requires manual reconciliation and prevents restart.
- Client idempotency keys do not make OpenAI requests idempotent; Quota Guard blocks repeat dispatch and returns 409.
- Logging excludes prompt content/response content/credentials. Readonly status contains aggregate counts only.
- Server binds `127.0.0.1`; adding TLS/remote access requires a separate reviewed design (not supported by default).
- Sqlite files are created as `0600`. Secure host, backups, logs and project keys separately.

## Security limits / unimplemented

- No independent proof that Admin Usage is complete at the first observation (possible reporting lag), no independently guaranteed zero billing, no independent system-clock skew oracle, tamper-resistant audit logs, out-of-band enrollment verification, or production billing attestation automation.
- No guaranteed cross-platform SDK compatibility, no production-validated Chat Completions trusted counter, no audited proxy-wide query concurrency against real OpenAI limits.
- The provisional raw-byte reservation is intentionally pessimistic and **not** a substitute for verified OpenAI input token counts; every sent Responses request must first receive a validated official counter response. The counter request itself must be audited for billing eligibility.
- Node `node:sqlite` is experimental in Node 22; pin the runtime and re-test upgrades.

## Reporting vulnerabilities

Report issues privately using GitHub's **Report a vulnerability** / Private vulnerability reporting if enabled. Do not include credentials, confidential prompts, or live project identifiers in a public issue.
