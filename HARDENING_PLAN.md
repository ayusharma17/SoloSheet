# Security, upload, and print implementation plan

Each scope has its own branch and worktree. The session supports three concurrent
subagents, so scopes four and five start as slots become available. Each agent
implements, tests, and reviews its scope, repeating up to three times when findings
require changes. Integration receives a separate review and verification pass.

| Scope | Branch | Worktree | Acceptance checks |
| --- | --- | --- | --- |
| Credit and admin security | `fix/credit-security` | `/private/tmp/solosheet-security` | Ordinary clients cannot grant credits, modify balances, or edit administrator membership; privileged functions have explicit grants and fixed search paths. |
| Atomic extraction | `fix/atomic-credits` | `/private/tmp/solosheet-atomic` | One credit admits one concurrent generation; retries cannot double charge or create duplicate materials; provider/save failure safely releases reservations. |
| File validation | `fix/file-validation` | `/private/tmp/solosheet-validation` | Malformed bodies, foreign storage origins/paths, MIME/signature mismatches, redirects, and excessive actual download bytes are rejected. |
| Upload retry and cleanup | `fix/upload-retries` | `/private/tmp/solosheet-uploads` | Partial upload and extraction failures can retry; ambiguous responses reuse request identity; removals/close clean owned uploads without racing active extraction. |
| Page fitting and printing | `fix/print-fit` | `/private/tmp/solosheet-print` | Preview and print share page geometry; guide consumes measured space when included; oversized content is reported; page counts and dropped items are accurate. |

## Integration contracts

- Security changes precede atomic-extraction migrations. SQL files describe an
  intended deployment, not evidence of applied database state.
- The extraction route owns orchestration. Request/storage validation lives in
  shared modules so validation and route work can proceed independently.
- The browser and server share a durable request UUID contract. A transport error
  must not automatically start a new generation; a confirmed failed attempt may
  start a new attempt after its credit is released.
- Administrative credentials stay server-only. Missing privileged configuration
  must fail closed instead of falling back to ordinary profile updates.
- Storage cleanup uses validated owned paths and the Storage API.
- Preserve the existing guide modes: separate appended guide outside the sheet
  allowance by default, or guide inside the requested allowance when selected.

## Baseline and final checks

Before edits, TypeScript passes. ESLint reports an existing explicit `any` in the
extraction route and an unused variable in storage helpers; both are in scope.
Run offline focused tests, lint, TypeScript, and a production build after
integration. Exercise dense content, long formulas, shorthand, dropped items,
multiple pages, and guide modes in a browser and printed PDF where tooling allows.
Record unavailable checks explicitly. Do not call live Gemini or mutate a deployed
database as a routine test.

The PRDs describe planned admin roles/unlimited flags and a device-review flow
that are absent from current code. This task secures existing access and credit
behavior; those broader business-policy changes are not silently introduced.
