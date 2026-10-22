# Branch protection on `main`

`main` is the branch that deploys. This document describes the protection
policy for it, where that policy lives, and how to apply or verify it.

Issue: [#414](https://github.com/ourdao/ourdao-backend/issues/414).

## Why this exists

`main` had neither classic branch protection nor a repository ruleset, so
nothing required a pull request, a green CI run, or a code-owner review before
a change landed on the default branch. `main` did go red at least twice
([#342](https://github.com/ourdao/ourdao-backend/issues/342),
[#346](https://github.com/ourdao/ourdao-backend/issues/346)). The parts of the
service that handle authorization, money-relevant state folding, and schema
migrations can therefore change without review.

## What the policy requires

| Requirement | Where it comes from |
| --- | --- |
| A pull request before merging | `.github/rulesets/main.json` → `pull_request` |
| At least 1 approving review, with stale approvals dismissed on push | `required_approving_review_count`, `dismiss_stale_reviews_on_push` |
| A code-owner approval on `src/`, `src/auth.ts`, `src/indexer/`, `src/db/migrations/` | `require_code_owner_review` + `.github/CODEOWNERS` |
| `build-and-test (22)`, `build-and-test (24)` and `docker-build` green | `.github/workflows/ci.yml`, listed as required status checks |
| No force-push, no deletion of `main` | `non_fast_forward`, `deletion` |
| No bypass actors — admins included | `bypass_actors: []` |

The policy is stored as data in
[`.github/rulesets/main.json`](../.github/rulesets/main.json), so a change to it
is reviewable in a pull request instead of being an invisible edit in
repository settings.

## Applying it (maintainer, admin token)

GitHub's ruleset API needs repository **admin** permission. Contributors cannot
apply it — the endpoint answers `403`/`404` for anyone below admin, which is
also why the `GET /repos/.../branches/main/protection` 404 in the issue is
ambiguous until checked with an admin token.

```bash
# Preview the exact payload without sending it
GH_TOKEN=<admin token> npm run protection:apply -- --repo ourdao/ourdao-backend --dry-run

# Create or update the ruleset (idempotent: it updates by name)
GH_TOKEN=<admin token> npm run protection:apply -- --repo ourdao/ourdao-backend
```

`protection:apply` refuses to run while `.github/CODEOWNERS` still names
`@PLACEHOLDER_OWNER` (issue
[#413](https://github.com/ourdao/ourdao-backend/issues/413)). Requiring a
code-owner review that no one can satisfy would make every pull request
unmergeable. Land #413 first, then apply. `--force` overrides the check if a
maintainer deliberately wants the rest of the policy in place first.

If you would rather click, the same policy is: Settings → Rules → Rulesets →
New branch ruleset, target the default branch, then mirror the table above.

## Verifying it

Any of these, cheapest first:

```bash
# 1. Does the committed definition still satisfy the policy? Offline, no token.
npm run protection:check

# 2. Does the live repository match the file? Needs read access to settings.
GH_TOKEN=<token> npm run protection:verify -- --repo ourdao/ourdao-backend

# 3. The raw API calls from the issue
gh api repos/ourdao/ourdao-backend/rulesets
gh api repos/ourdao/ourdao-backend/branches/main/protection   # no longer 404 once protected
```

`protection:verify` exits non-zero and lists the differences when the ruleset
is missing, weakened, or when `main` is protected by a *different* set of checks
than the file lists. Either a repository ruleset or classic branch protection
satisfies it.

GitHub Actions can run the same comparison manually (Actions → **Branch
protection** → Run workflow). It is not scheduled on purpose: until a
maintainer applies the ruleset, a scheduled run would be red on `main` for a
settings change this repository cannot make from code. Once the ruleset is
applied, add a `schedule:` trigger to
[`.github/workflows/branch-protection.yml`](../.github/workflows/branch-protection.yml)
so a manually loosened setting surfaces within a day.

The `definition` job of that workflow runs on every pull request that touches
the ruleset file, the CODEOWNERS file, or the script, and fails if the policy is
weakened or if a required status check names a job/matrix value that
`.github/workflows/ci.yml` does not run — a required check that never reports
blocks every pull request forever.

## Rolling it back

```bash
gh api repos/ourdao/ourdao-backend/rulesets            # find the id of "main-protection"
gh api -X DELETE repos/ourdao/ourdao-backend/rulesets/<id>
```

Deleting the ruleset re-opens `main` to unreviewed pushes, so say why in the
issue or a new one.

## What this does not do

- **No linear-history or signed-commit requirement.** Squash, merge and rebase
  commits are all accepted; contributors are not asked to set up commit
  signing.
- **No branch-up-to-date requirement.** `strict_required_status_checks_policy`
  is `false`: a PR does not have to rebase onto the tip of `main` before merge.
  Flip it in the JSON if you want to trade that friction for a smaller window
  of semantic conflicts.
- **No direct-push ban on release branches.** The ruleset targets the default
  branch only; `~DEFAULT_BRANCH` is used rather than `refs/heads/main` so the
  rule follows the default branch if it is ever renamed.
