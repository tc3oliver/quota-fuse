# OSS release checklist (maintainer)

Project policy: Apache-2.0; no proprietary input, secrets, real organization identifiers, or real billing-account access in public CI.

## Before publishing

- [ ] Confirm `README.md`, `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `.github` templates, `CHANGELOG.md` and an honest feature/status table.
- [ ] Run `npm ci`, `npm run check`, `npm run demo`, `git diff --check`. CI must run Node 22 and 24 using mocks only.
- [ ] Scan tracked files and Git history for secrets/credentials and remove any accidental exposure **before** making the repo public.
- [ ] Confirm unsupported Chat endpoint, eligible-model validation, paid-tool paths, and unverified usage all fail closed.
- [ ] Publish from a reviewed commit and immutable version tag; do not move published tags.

## GitHub repository settings

- Public repository named `tc3oliver/quota-fuse`, default branch `main`, description: “Fail-closed, local-first OpenAI Data Sharing quota guard (experimental OSS)”.
- Topics: `openai`, `quota`, `reverse-proxy`, `sqlite`, `typescript`, `security`, `llm`.
- Protect `main`: require CI checks, reject force-pushes, enable PR review and signed commits if maintainers can support them.
- Enable dependency/security alerts, code scanning (where available), private vulnerability reporting, and Dependabot.
- Enable discussions optionally only after a maintainer can moderate them. No automated publishing of npm packages or release binaries in v0.1.

## v0.1.1 release classification

**Technical preview / NO-GO for production billing traffic.** Local mock tests prove internal behavior, not that upstream incentive accounting is atomically enforceable. Do **not** advertise “guaranteed no charges.”

## Mandatory operator production checks (not done by OSS CI)

- Manually audit the current Data Sharing terms, exact model eligibility, project enrollment and Dashboard/Costs.
- Independently verify the cost/eligibility of the preflight `/responses/input_tokens` operation.
- Verify the exclusive organization consumption boundary; unaccounted traffic requires disabling admission.
- Execute the [acceptance matrix](test-matrix.md) and resolve every PARTIAL/NOT RUN gate before production approval.
