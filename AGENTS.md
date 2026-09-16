# Project guidance

## Product and architecture

SoloSheet turns uploaded lecture PDFs and images into dense, printable exam cheat sheets.
The stack is Next.js App Router, React, strict TypeScript, Tailwind CSS, Supabase Auth/Postgres/Storage, and Google Gemini. Use npm and the existing package-lock.json.

- `src/app/dashboard/`: authenticated material list and browser uploads.
- `src/app/api/extract/route.ts`: authentication, validation, extraction orchestration, persistence, credits, and cleanup.
- `src/lib/gemini.ts`: extraction prompt, provider calls, retries, and extraction types.
- `src/lib/supabase/`: browser/server clients and storage helpers.
- `src/middleware.ts` and `src/app/auth/callback/route.ts`: session refresh and OAuth flow.
- `src/app/cheat-sheet/[id]/typesetter-client.tsx`: page fitting, preview, and print controls.
- `src/components/`: sheet layout, LaTeX rendering, and optional navigation guide.
- `supabase/`: SQL schema and migration scripts; their presence does not prove deployment.
- `PRDS/` and `MIGRATION_SUMMARY.md`: product intent and historical implementation notes. Compare them with code; do not assume planned features exist.
- `Test_Files/`: sample lecture documents, not an automated test suite.

## Working conventions

- Inspect git status and relevant code before editing. Preserve unrelated user changes.
- Keep changes focused on the requested task. Follow existing formatting and use `@/` imports for source modules.
- Keep server secrets and provider calls on the server. Use the matching browser or server Supabase client.
- Validate external input at runtime; TypeScript assertions do not validate request bodies, stored JSON, or model responses. Prefer `unknown` plus narrowing over `any`.
- Preserve the current visual language unless redesign is requested. Treat preview and printed output as separate paths that both need verification.
- When product requirements conflict with implementation, state the discrepancy and avoid silently choosing a new business policy.

## Local commands and configuration

- Install dependencies: `npm ci`.
- Development server: `npm run dev`.
- Lint: `npm run lint`.
- Type check: `./node_modules/.bin/tsc --noEmit --incremental false`.
- Production build: `npm run build`; serve the build with `npm start`.
- There is currently no automated test script. Do not report `npm test` as a working check.

Required configuration names are `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and server-only `GOOGLE_API_KEY`. The optional model setting is `GEMINI_MODEL`. Administrator identity is database-managed; do not add an environment-based administrator list. Do not print or commit actual environment values, signed URLs, or credentials. The build uses `next/font/google` and may need network access to fetch fonts.

`debug-extraction.ts` makes real Gemini calls and attempts a database insert; it is not an offline test. Use mocks or fixtures for routine verification. Use live services only when the task authorizes that integration work.

## Security and data changes

- Authenticate API operations and enforce user ownership through RLS and validated storage paths. Keep the `course-materials` bucket private.
- Treat supplied URLs, MIME types, sizes, and cleanup paths as untrusted. Validate the configured storage origin and authenticated user's object path; enforce actual download byte limits.
- Credit spending must be atomic and safe under retries/concurrent requests. Keep administrative credit operations inaccessible to ordinary clients.
- For SQL functions, review execution grants, caller authorization, and a fixed `search_path` for `SECURITY DEFINER` functions. Use schema-qualified relations.
- Add forward migrations for schema changes and document execution order. Inspect actual deployed state before assuming existing SQL has run.
- Delete stored files through the Storage API, not direct deletion of `storage.objects` metadata.

## Verification and completion

- For code changes, run lint and type checking; run the production build for changes affecting bundling, routes, dependencies, or configuration. Report pre-existing failures separately.
- For extraction/auth/credit changes, cover malformed input, unauthorized access, concurrent requests, provider failure, retry behavior, and cleanup with focused tests where feasible.
- For typesetting changes, inspect dense content, long formulas, shorthand, dropped items, overflow, multiple pages, and guide on/off in both preview and print output.
- Documentation-only edits need path/command accuracy and a diff check, not live extraction calls.
- Finish with what changed, verification results, and remaining limitations. Do not claim live database policies, deployed behavior, or print output were verified without checking them.
- use playwright when necessary to test changes end to end
