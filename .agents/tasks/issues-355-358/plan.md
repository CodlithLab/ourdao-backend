# Implementation Plan for Issues #355, #356, #357, #358

## Issue #355: Update README Test Count

**Problem:** README.md claims "145 tests across 18 files" but the repository actually has 72 test files and ~597 individual test cases.

**Decision:** Use the actual count of test files (72) and individual test cases (597 identified via grep of `it(` and `test(` declarations in all .test.ts files). This aligns the documentation with current reality.

### Implementation

- [ ] 1. Determine final test count by examining test files to decide between static count or runtime verification.
      Based on exploration, the grep count (597 individual test declarations) is reliable and not dependent on database state. Update README.md line 433 with these numbers.
      Files: README.md
      Verify: `grep -n "597 tests across 72 files" README.md` — confirms the new claim exists.

- [ ] 2. Commit the README change with a clear message about updating test counts.
      Files: README.md
      Verify: `git log --oneline -1` shows a commit about updating test counts; `git show HEAD:README.md | grep -c "597 tests"` confirms content.

---

## Issue #356: Remove Implementation Summary Files

**Problem:** Three PR narrative documents (`COMPLETION_STATUS.md`, `IMPLEMENTATION_SUMMARY.md`, `IMPLEMENTATION_SUMMARY_217-220.md`) were committed to the repo root; they should be in PR descriptions only, not committed files.

**Decision:** Remove all three files and update CONTRIBUTING.md to document this convention. These files contain only PR summary narrative with no technical content worth preserving elsewhere — they are temporary artifacts for PR reviewers, not permanent documentation.

### Implementation

- [ ] 1. Remove the three files from the repo root.
      Files: COMPLETION_STATUS.md, IMPLEMENTATION_SUMMARY.md, IMPLEMENTATION_SUMMARY_217-220.md
      Verify: `git status` shows the three files as deleted; `ls -la COMPLETION_STATUS.md 2>&1` produces "cannot access".

- [ ] 2. Update CONTRIBUTING.md to document where PR narrative belongs.
      Add a section under "What a good pull request looks like" clarifying that implementation summary and completion status belong in the PR description on GitHub, not in committed files. Reference this as a regression of issue #185.
      Files: CONTRIBUTING.md
      Verify: `grep -n "PR description" CONTRIBUTING.md` confirms the new guidance; `git diff HEAD CONTRIBUTING.md | head -20` shows the change.

- [ ] 3. Commit the deletions and documentation update.
      Files: COMPLETION_STATUS.md, IMPLEMENTATION_SUMMARY.md, IMPLEMENTATION_SUMMARY_217-220.md, CONTRIBUTING.md
      Verify: `git log --oneline -1` shows a commit about removing summary files; `git show HEAD --name-status | grep -E "^D"` lists the deletions.

---

## Issue #357: Add Missing Unique Index and Composite Index to schema.sql

**Problem:** `schema.sql` is missing two indices that were added in migrations:
- Migration 0031 adds `notifications_event_id_address_uniq` (unique index on `notifications(event_id, address)`)
- Migration 0015 adds `events_ledger_id_idx` (composite index on `events(ledger, id)`)

These are missing from `schema.sql`, so a fresh database created from `schema.sql` alone lacks these indices, causing ON CONFLICT failures and pagination performance issues. The migration dry-run test must pass after the fix.

**Decision:** Add both indices to `schema.sql` in the notifications and events sections respectively, matching the migration definitions exactly. This ensures fresh databases have all necessary indices from bootstrap.

### Implementation

- [ ] 1. Add the missing `events_ledger_id_idx` index to schema.sql in the events section.
      After the existing `events_data_gin_idx` line (around line 77), add:
      `CREATE INDEX IF NOT EXISTS events_ledger_id_idx ON events (ledger, id);`
      This matches the definition in migration 0015 exactly.
      Files: src/db/schema.sql
      Verify: `grep -n "events_ledger_id_idx" src/db/schema.sql` confirms the index exists.

- [ ] 2. The `notifications_event_id_address_uniq` index is already present in schema.sql (found at the notifications section).
      Verify it exists and matches migration 0031 definition.
      Files: src/db/schema.sql
      Verify: `grep -n "notifications_event_id_address_uniq" src/db/schema.sql` confirms it exists; `grep -A1 "notifications_event_id_address_uniq" src/db/schema.sql | grep -c "WHERE event_id IS NOT NULL"` confirms the WHERE clause.

- [ ] 3. Run the migration dry-run test to confirm schema.sql + all migrations are consistent.
      The test builds a fresh database from schema.sql then replays all migrations to ensure no conflicts and no schema drift between them.
      Files: test/migration-dry-run.test.ts (no changes; test should pass as-is)
      Verify: `npm test -- test/migration-dry-run.test.ts 2>&1 | grep -E "(PASS|FAIL|✓|✕)"` — test must pass; or if tests require DB: `TEST_DATABASE_URL=postgres://user:pass@localhost:5432/test npm test -- test/migration-dry-run.test.ts` — all suites pass.

- [ ] 4. Commit the schema.sql changes.
      Files: src/db/schema.sql
      Verify: `git log --oneline -1` shows a commit about adding missing indices; `git diff HEAD^ src/db/schema.sql | grep "events_ledger_id_idx"` shows the addition.

---

## Issue #358: Add Response Schemas to OpenAPI Specification

**Problem:** The generated `openapi.json` has no response schemas for the main GET endpoints (`/api/loans`, `/api/stats`, `/api/notifications`, `/api/events`), making the spec incomplete for downstream consumers.

**Decision:** Add response schema definitions for those four endpoints:
1. Define shared schemas under `components.schemas` for common types (LoanWithDerived, Notification, DAOStats, Event)
2. Add `response: { 200: { ... } }` objects to each of the four endpoints in the route definitions
3. Use `type: string` for NUMERIC(40,0) amount fields (matching the database schema and API behavior)
4. Regenerate openapi.json using the existing script
5. Add a validation test that fails if any public GET /api/* route lacks a 200 response schema

### Implementation

- [ ] 1. Add response schemas to the `GET /api/loans` endpoint in src/api/routes/index.ts.
      Search for `app.get('/loans'` (line 488). Add a `schema` object with:
      - `tags: ['Loans']`
      - `response: { 200: { description: 'Array of loans', type: 'array', items: { $ref: '#/components/schemas/LoanWithDerived' } } }`
      Files: src/api/routes/index.ts
      Verify: After regenerating openapi.json, `jq '.paths["/api/loans"].get.responses' openapi.json | grep -c "200"` returns 1 and response is not empty.

- [ ] 2. Add response schemas to the `GET /api/stats` endpoint in src/api/routes/index.ts.
      Search for `app.get('/stats'` (line 1328). The route handler returns `DAOStats | { error: string }`. Add a `schema` object with:
      - `tags: ['Stats']`
      - `response: { 200: { description: 'DAO statistics', $ref: '#/components/schemas/DAOStats' } }`
      Files: src/api/routes/index.ts
      Verify: After regenerating openapi.json, `jq '.paths["/api/stats"].get.responses' openapi.json | grep -c "200"` returns 1.

- [ ] 3. Add response schemas to the `GET /api/notifications` endpoint in src/api/routes/index.ts.
      Search for `app.get('/notifications'` (line 571). Add a `schema` object with:
      - `tags: ['Notifications']`
      - `response: { 200: { description: 'Array of notifications', type: 'array', items: { $ref: '#/components/schemas/NotificationRow' } } }`
      Files: src/api/routes/index.ts
      Verify: After regenerating openapi.json, the response schema for `/api/notifications` is populated.

- [ ] 4. Add response schemas to the `GET /api/events` endpoint in src/api/routes/index.ts.
      Search for `app.get('/events'` (line 597). Note this route already has a `schema` object for stricter rate limiting. Merge in a `response` key:
      - `tags: ['Events']`
      - `response: { 200: { description: 'Paginated event feed', type: 'array', items: { $ref: '#/components/schemas/EventRow' } } }`
      Files: src/api/routes/index.ts
      Verify: After regenerating openapi.json, the response schema for `/api/events` is populated.

- [ ] 5. Define component schemas in src/api/routes/index.ts or a new helper file for schema definitions.
      Create a `schemas` object (or file) exporting OpenAPI schema definitions for:
      - `LoanWithDerived` (extends LoanRow with `interest_charge`, `repaid_amount`, `repayment_progress_bps`)
      - `DAOStats` (see types.ts for shape)
      - `NotificationRow` (see types.ts for shape; amount fields as `type: string`)
      - `EventRow` (id, ledger, symbol, topics, data, etc.)
      All amount columns (NUMERIC(40,0)) must use `type: string`, not `type: number`.
      Files: src/api/routes/index.ts (or new src/api/schemas.ts)
      Verify: The definitions can be referenced via `$ref: '#/components/schemas/...'` and compile without TypeScript errors.

- [ ] 6. Update src/api/routes/index.ts to pass schema definitions to the Fastify Swagger plugin.
      In `registerRoutes`, pass a `schemas` option or export to the route definitions so Swagger generates the `components.schemas` section of openapi.json.
      Files: src/api/routes/index.ts
      Verify: After regenerating, `jq '.components.schemas | keys' openapi.json` lists the new schema names.

- [ ] 7. Regenerate openapi.json using the existing script.
      Run `npm run openapi:generate` to regenerate openapi.json from the updated routes.
      Files: openapi.json (regenerated)
      Verify: `npm run openapi:validate` passes (spec is in sync); `git diff openapi.json | head -50` shows new response schemas added.

- [ ] 8. Add a test that validates all public GET /api/* endpoints have a 200 response schema.
      Create a new test file (e.g., test/api-response-schemas.test.ts) that:
      - Parses openapi.json
      - Iterates all paths matching `^/api/` with GET operations
      - Asserts each has `responses['200']` defined
      - Allows for documented errors in error responses
      Files: test/api-response-schemas.test.ts
      Verify: `npm test -- test/api-response-schemas.test.ts` passes; test fails if any public GET endpoint lacks a response schema.

- [ ] 9. Verify the build and OpenAPI validation still pass.
      Run the full validation suite to ensure no regressions.
      Files: (no new files)
      Verify: `npm run lint && npm run typecheck && npm run openapi:validate && npm run build` all pass with no errors.

- [ ] 10. Commit all changes: route schema additions, component definitions, regenerated openapi.json, and the validation test.
       Files: src/api/routes/index.ts (or src/api/schemas.ts), openapi.json, test/api-response-schemas.test.ts
       Verify: `git log --oneline -1` shows a commit about adding response schemas; `git show HEAD --stat` shows the files changed.

---

## Summary

| Issue | Changes | Files | Verification |
|-------|---------|-------|--------------|
| #355  | Update test count in README.md | README.md | grep for new counts |
| #356  | Remove 3 files, update CONTRIBUTING.md | 3 files deleted, CONTRIBUTING.md modified | git status shows deletions; grep confirms new guidance |
| #357  | Add 2 missing indices to schema.sql | src/db/schema.sql | migration-dry-run test passes |
| #358  | Add response schemas to 4 GET endpoints | src/api/routes/index.ts, openapi.json, test/api-response-schemas.test.ts | openapi:validate passes; new test passes |
