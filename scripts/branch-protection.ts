#!/usr/bin/env tsx
/**
 * Branch-protection policy for `main` (issue #414).
 *
 * `main` had neither classic branch protection nor a repository ruleset, so
 * nothing required a pull request, a green CI run, or a code-owner review
 * before a change landed on the default branch — and `main` did go red
 * (#342, #346). GitHub keeps that state in repository settings that only a
 * repository admin can change, so the policy is committed as data
 * (`.github/rulesets/main.json`) and applied/verified through the API:
 *
 *   npm run protection:check    # offline: is the committed definition complete?
 *   npm run protection:verify   # live: does the repository match the definition?
 *   npm run protection:apply    # live: create/update the ruleset (admin token)
 *
 * See docs/BRANCH_PROTECTION.md for the one-time maintainer step and the
 * ordering dependency on the CODEOWNERS fix (issue #413): requiring a
 * code-owner review while CODEOWNERS still says `@PLACEHOLDER_OWNER` would
 * make every pull request unmergeable.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const DEFAULT_DEFINITION_PATH = path.join(REPO_ROOT, '.github/rulesets/main.json')
export const DEFAULT_CODEOWNERS_PATH = path.join(REPO_ROOT, '.github/CODEOWNERS')
export const DEFAULT_CI_WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/ci.yml')

/** Ruleset name this repository owns. Must match `.github/rulesets/main.json`. */
export const RULESET_NAME = 'main-protection'

/** Checks from `.github/workflows/ci.yml` that must pass before a merge. */
export const REQUIRED_CHECK_CONTEXTS = ['build-and-test (22)', 'build-and-test (24)', 'docker-build'] as const

/** The issue asks for "at least one approving review, including code owners". */
export const MIN_APPROVALS = 1

export interface RulesetRule {
  type: string
  parameters?: Record<string, unknown>
}

export interface RulesetDefinition {
  name: string
  target: string
  enforcement: string
  conditions?: { ref_name?: { include?: string[]; exclude?: string[] } }
  bypass_actors?: unknown[]
  rules?: RulesetRule[]
}

/**
 * The parts of protection that matter, normalized so a repository ruleset and
 * classic branch protection can be compared against the same expectations.
 */
export interface ProtectionFacts {
  enforcement: string
  requiresPullRequest: boolean
  requiredApprovals: number
  requiresCodeOwnerReview: boolean
  dismissesStaleReviews: boolean
  requiredChecks: string[]
  blocksDeletion: boolean
  blocksForcePush: boolean
  bypassActors: number
}

export interface CliOptions {
  command: 'check' | 'verify' | 'apply'
  repo?: string
  definitionPath: string
  token?: string
  dryRun: boolean
  force: boolean
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function asStringArray(value: unknown): string[] {
  return asArray(value).filter((entry): entry is string => typeof entry === 'string')
}


/** Normalize a ruleset definition or a live `GET /rulesets/{id}` body. */
export function factsFromRuleset(definition: RulesetDefinition): ProtectionFacts {
  const rules = asArray(definition.rules) as RulesetRule[]
  const ruleOf = (type: string): RulesetRule | undefined => rules.find((rule) => rule?.type === type)

  const pullRequest = asRecord(ruleOf('pull_request')?.parameters)
  const statusChecks = asRecord(ruleOf('required_status_checks')?.parameters)

  const contexts = asArray(statusChecks.required_status_checks)
    .map((entry) => (typeof entry === 'string' ? entry : asRecord(entry).context))
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)

  return {
    enforcement: typeof definition.enforcement === 'string' ? definition.enforcement : 'missing',
    requiresPullRequest: ruleOf('pull_request') !== undefined,
    requiredApprovals: asNumber(pullRequest.required_approving_review_count),
    requiresCodeOwnerReview: pullRequest.require_code_owner_review === true,
    dismissesStaleReviews: pullRequest.dismiss_stale_reviews_on_push === true,
    requiredChecks: contexts,
    blocksDeletion: ruleOf('deletion') !== undefined,
    blocksForcePush: ruleOf('non_fast_forward') !== undefined,
    bypassActors: asArray(definition.bypass_actors).length,
  }
}

/**
 * Normalize classic branch protection (`GET /branches/{branch}/protection`)
 * the same way, so a repository that uses classic protection instead of a
 * ruleset is still measurable against the policy.
 *
 * Callers pass the body only when the request succeeded: the endpoint answers
 * 404 ("Branch not protected") when protection is off.
 */
export function factsFromClassicProtection(protection: unknown): ProtectionFacts {
  const body = asRecord(protection)
  const reviews = asRecord(body.required_pull_request_reviews)
  const statusChecks = asRecord(body.required_status_checks)

  const contexts = [
    ...asStringArray(statusChecks.contexts),
    ...asArray(statusChecks.checks).map((entry) => asRecord(entry).context),
  ].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)

  return {
    enforcement: typeof body.enforce_admins === 'object' ? 'active' : 'missing',
    requiresPullRequest: Object.keys(reviews).length > 0,
    requiredApprovals: asNumber(reviews.required_approving_review_count),
    requiresCodeOwnerReview: reviews.require_code_owner_reviews === true,
    dismissesStaleReviews: reviews.dismiss_stale_reviews === true,
    requiredChecks: contexts,
    // `allow_deletions.enabled === false` and `allow_force_pushes.enabled === false`
    // mean the branch is protected against them; `null` means "inherit the
    // repository default", which does not protect `main`.
    blocksDeletion: asRecord(body.allow_deletions).enabled === false,
    blocksForcePush: asRecord(body.allow_force_pushes).enabled === false,
    bypassActors: asRecord(body.enforce_admins).enabled === true ? 0 : 1,
  }
}

/**
 * Policy floor for the committed definition. This is what `npm run
 * protection:check` enforces offline, so a weakened ruleset cannot be merged
 * and only afterwards be discovered.
 */
export function validateDefinition(definition: RulesetDefinition): string[] {
  const problems: string[] = []
  const facts = factsFromRuleset(definition)

  if (definition.name !== RULESET_NAME) {
    problems.push(`ruleset name must be "${RULESET_NAME}" (got "${String(definition.name)}")`)
  }
  if (definition.target !== 'branch') {
    problems.push(`ruleset target must be "branch" (got "${String(definition.target)}")`)
  }
  if (facts.enforcement !== 'active') {
    problems.push(`ruleset must be enforced (enforcement: "active", got "${facts.enforcement}")`)
  }

  const includes = asStringArray(asRecord(asRecord(definition.conditions).ref_name).include)
  if (!includes.some((ref) => ref === '~DEFAULT_BRANCH' || ref === 'refs/heads/main')) {
    problems.push('ruleset must target the default branch (~DEFAULT_BRANCH or refs/heads/main)')
  }

  if (facts.bypassActors > 0) {
    problems.push(
      `ruleset must not grant bypass (${facts.bypassActors} bypass actor(s)); a bypass lets a red CI run or a missing review land on main`
    )
  }
  if (!facts.blocksDeletion) {
    problems.push('ruleset must block branch deletion (rule type "deletion")')
  }
  if (!facts.blocksForcePush) {
    problems.push('ruleset must block force-pushes (rule type "non_fast_forward")')
  }
  if (!facts.requiresPullRequest) {
    problems.push('ruleset must require a pull request before merging (rule type "pull_request")')
  }
  if (facts.requiredApprovals < MIN_APPROVALS) {
    problems.push(
      `pull requests must require at least ${MIN_APPROVALS} approving review(s) (required_approving_review_count: ${facts.requiredApprovals})`
    )
  }
  if (!facts.requiresCodeOwnerReview) {
    problems.push(
      'pull requests must require a code-owner review (require_code_owner_review: true) — the src/auth.ts acceptance criterion'
    )
  }
  for (const context of REQUIRED_CHECK_CONTEXTS) {
    if (!facts.requiredChecks.includes(context)) {
      problems.push(`required status checks must include "${context}"`)
    }
  }

  return problems
}

/** Compare what the policy requires with what the repository actually enforces. */
export function describeDrift(expected: ProtectionFacts, actual: ProtectionFacts): string[] {
  const drift: string[] = []

  if (actual.requiresPullRequest !== expected.requiresPullRequest) {
    drift.push(`pull request requirement: expected ${expected.requiresPullRequest}, found ${actual.requiresPullRequest}`)
  }
  if (actual.requiredApprovals < expected.requiredApprovals) {
    drift.push(
      `required approvals: expected at least ${expected.requiredApprovals}, found ${actual.requiredApprovals}`
    )
  }
  if (actual.requiresCodeOwnerReview !== expected.requiresCodeOwnerReview) {
    drift.push(`code-owner review: expected ${expected.requiresCodeOwnerReview}, found ${actual.requiresCodeOwnerReview}`)
  }
  if (actual.dismissesStaleReviews !== expected.dismissesStaleReviews) {
    drift.push(
      `dismiss stale reviews on push: expected ${expected.dismissesStaleReviews}, found ${actual.dismissesStaleReviews}`
    )
  }
  if (actual.blocksDeletion !== expected.blocksDeletion) {
    drift.push(`deletion blocked: expected ${expected.blocksDeletion}, found ${actual.blocksDeletion}`)
  }
  if (actual.blocksForcePush !== expected.blocksForcePush) {
    drift.push(`force-push blocked: expected ${expected.blocksForcePush}, found ${actual.blocksForcePush}`)
  }
  if (actual.bypassActors !== expected.bypassActors) {
    drift.push(`bypass actors: expected ${expected.bypassActors}, found ${actual.bypassActors}`)
  }

  for (const context of expected.requiredChecks) {
    if (!actual.requiredChecks.includes(context)) {
      drift.push(`required status check missing: "${context}"`)
    }
  }
  for (const context of actual.requiredChecks) {
    if (!expected.requiredChecks.includes(context)) {
      drift.push(`unexpected required status check: "${context}" (not in the committed definition)`)
    }
  }

  return drift
}

/**
 * Owners still named `@PLACEHOLDER_OWNER` mean no reviewer is ever requested
 * (issue #413), so `require_code_owner_review` would block `main` outright.
 */
export function findCodeOwnersPlaceholders(text: string): string[] {
  const findings: string[] = []

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/#.*$/, '').trim()
    if (line.length === 0) return

    const [pattern, ...owners] = line.split(/\s+/)
    if (pattern === undefined || owners.length === 0) return

    const placeholders = owners.filter((owner) => /placeholder/i.test(owner))
    if (placeholders.length > 0) {
      findings.push(`${pattern} -> ${placeholders.join(', ')} (CODEOWNERS:${index + 1})`)
    }
  })

  return findings
}

/** Preflight for enabling a required code-owner review (issue #413 dependency). */
export function validateCodeOwners(text: string): string[] {
  const problems: string[] = []
  const rules = text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line.length > 0)

  if (rules.length === 0) {
    problems.push('CODEOWNERS is empty: enabling require_code_owner_review would make every pull request unmergeable')
  }
  for (const placeholder of findCodeOwnersPlaceholders(text)) {
    problems.push(`CODEOWNERS still names a placeholder owner: ${placeholder} — fix issue #413 first`)
  }

  return problems
}

/** Job ids declared in a workflow file (two-space indented keys under `jobs:`). */
export function workflowJobIds(ciYaml: string): string[] {
  const ids: string[] = []
  for (const line of ciYaml.split(/\r?\n/)) {
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (match?.[1] !== undefined) ids.push(match[1])
  }
  return ids
}

/** Matrix values a job runs with, e.g. `["22", "24"]` for `build-and-test`. */
export function matrixValuesForJob(ciYaml: string, job: string): string[] {
  const lines = ciYaml.split(/\r?\n/)
  const escaped = job.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const start = lines.findIndex((line) => new RegExp(`^ {2}${escaped}:\\s*$`).test(line))
  if (start === -1) return []

  const values: string[] = []
  let insideMatrix = false

  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    // A new top-level job starts a new block.
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)) break
    if (/^\s*matrix:\s*$/.test(line)) {
      insideMatrix = true
      continue
    }
    if (!insideMatrix) continue

    const inline = /node-version:\s*\[([^\]]*)\]/.exec(line)
    if (inline?.[1] !== undefined) {
      values.push(
        ...inline[1]
          .split(',')
          .map((value) => value.trim().replace(/^["']|["']$/g, ''))
          .filter((value) => value.length > 0)
      )
      continue
    }

    const single = /node-version:\s*["']?([\w.]+)["']?\s*$/.exec(line)
    if (single?.[1] !== undefined) values.push(single[1])
  }

  return values
}

/**
 * A required status check whose name does not correspond to a job in
 * `.github/workflows/ci.yml` never reports, which blocks every pull request
 * forever. Matrix jobs report as `<job> (<matrix value>)`.
 */
export function checkWorkflowCheckContexts(contexts: readonly string[], ciYaml: string): string[] {
  const problems: string[] = []
  const jobIds = new Set(workflowJobIds(ciYaml))

  if (jobIds.size === 0) {
    return ['could not read any job ids from .github/workflows/ci.yml']
  }

  for (const context of contexts) {
    const parsed = /^([A-Za-z0-9_-]+)\s*(?:\(([^)]+)\))?$/.exec(context)
    const job = parsed?.[1]
    const matrixValue = parsed?.[2]

    if (job === undefined) {
      problems.push(`"${context}" is not a valid status-check name`)
      continue
    }
    if (!jobIds.has(job)) {
      problems.push(`"${context}" does not match a job in .github/workflows/ci.yml (no job named "${job}")`)
      continue
    }
    if (matrixValue !== undefined) {
      const values = matrixValuesForJob(ciYaml, job)
      if (values.length > 0 && !values.includes(matrixValue)) {
        problems.push(
          `"${context}": ci.yml runs "${job}" with matrix values [${values.join(', ')}]; "${matrixValue}" would never report`
        )
      }
    }
  }

  return problems
}

export const USAGE = `Usage: tsx scripts/branch-protection.ts <command> [options]

Commands:
  check    Validate the committed ruleset definition offline (no network).
  verify   Compare the live repository against the definition (needs a token
           that can read repository settings).
  apply    Create or update the ruleset on the repository. Needs an admin
           token, i.e. a maintainer — see docs/BRANCH_PROTECTION.md.

Options:
  --repo <owner/name>   Target repository (default: $GITHUB_REPOSITORY).
  --definition <path>   Ruleset definition (default: .github/rulesets/main.json).
  --dry-run             Print the payload instead of sending it.
  --force               Apply even when CODEOWNERS still has placeholders (#413).
  -h, --help            Show this help.
`

function takeValue(args: string[], flag: string): string {
  const value = args.shift()
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} needs a value`)
  }
  return value
}

export function parseArgs(argv: string[]): CliOptions {
  const args = [...argv]
  const command = args.shift()

  if (command !== 'check' && command !== 'verify' && command !== 'apply') {
    throw new Error(`unknown command "${command ?? ''}" — expected check, verify or apply`)
  }

  const options: CliOptions = {
    command,
    definitionPath: DEFAULT_DEFINITION_PATH,
    dryRun: false,
    force: false,
  }

  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  if (token !== undefined && token.length > 0) options.token = token

  const repository = process.env.GITHUB_REPOSITORY
  if (repository !== undefined && repository.length > 0) options.repo = repository

  while (args.length > 0) {
    const arg = args.shift()
    switch (arg) {
      case '--repo':
        options.repo = takeValue(args, '--repo')
        break
      case '--definition':
        options.definitionPath = path.resolve(takeValue(args, '--definition'))
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--force':
        options.force = true
        break
      default:
        throw new Error(`unknown option "${String(arg)}"`)
    }
  }

  return options
}

async function readText(filePath: string, label: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    throw new Error(`could not read ${label} at ${filePath}`, { cause: error })
  }
}

export async function readDefinition(filePath: string): Promise<RulesetDefinition> {
  const text = await readText(filePath, 'the ruleset definition')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`${filePath} is not valid JSON: ${(error as Error).message}`, { cause: error })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain a JSON object`)
  }
  return parsed as RulesetDefinition
}


export interface GitHubResponse {
  status: number
  body: unknown
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export interface GitHubRequestOptions {
  token: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  body?: unknown
}

export async function githubRequest(options: GitHubRequestOptions): Promise<GitHubResponse> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${options.token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'ourdao-backend-branch-protection',
  }
  if (options.body !== undefined) headers['content-type'] = 'application/json'

  const response = await fetch(`https://api.github.com${options.path}`, {
    method: options.method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })

  const text = await response.text()
  return { status: response.status, body: text.length > 0 ? safeJson(text) : undefined }
}

function requireRepo(options: CliOptions): string {
  const repo = options.repo
  if (repo === undefined) {
    throw new Error('no repository: pass --repo owner/name or set GITHUB_REPOSITORY')
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new Error(`"--repo" must look like owner/name (got "${repo}")`)
  }
  return repo
}

function requireToken(options: CliOptions): string {
  if (options.token === undefined) {
    throw new Error('no token: set GH_TOKEN or GITHUB_TOKEN (read access to verify, admin to apply)')
  }
  return options.token
}

/** Id of the ruleset this repo owns, if it has been applied yet. */
export async function findRulesetId(options: CliOptions, repo: string): Promise<number | undefined> {
  const response = await githubRequest({
    token: requireToken(options),
    method: 'GET',
    path: `/repos/${repo}/rulesets?per_page=100`,
  })

  if (response.status !== 200) {
    throw new Error(`GET /repos/${repo}/rulesets failed with ${response.status}: ${JSON.stringify(response.body)}`)
  }

  const match = asArray(response.body)
    .map((entry) => asRecord(entry))
    .find((entry) => entry.name === RULESET_NAME)

  return typeof match?.id === 'number' ? match.id : undefined
}

export async function runCheck(options: CliOptions): Promise<number> {
  const definition = await readDefinition(options.definitionPath)
  const problems = validateDefinition(definition)

  const ciYaml = await readText(DEFAULT_CI_WORKFLOW_PATH, '.github/workflows/ci.yml')
  problems.push(...checkWorkflowCheckContexts(REQUIRED_CHECK_CONTEXTS, ciYaml))

  // Warnings, not failures: requiring a code-owner review only becomes safe
  // once issue #413 replaces @PLACEHOLDER_OWNER, and that is a separate change.
  const codeOwners = await readText(DEFAULT_CODEOWNERS_PATH, '.github/CODEOWNERS')
  const warnings = validateCodeOwners(codeOwners)

  if (problems.length > 0) {
    console.error('[branch-protection] the committed definition does not meet the policy:')
    for (const problem of problems) console.error(`  - ${problem}`)
    return 1
  }

  const relative = path.relative(REPO_ROOT, options.definitionPath).replace(/\\/g, '/')
  console.log(
    `[branch-protection] ${relative} meets the policy: pull request + ${MIN_APPROVALS} approval(s) + code-owner review, ` +
      `required checks (${REQUIRED_CHECK_CONTEXTS.join(', ')}), no force-push, no deletion.`
  )
  for (const warning of warnings) {
    console.warn(`[branch-protection] warning (issue #413): ${warning}`)
  }
  return 0
}


export async function runVerify(options: CliOptions): Promise<number> {
  const repo = requireRepo(options)
  const token = requireToken(options)
  const definition = await readDefinition(options.definitionPath)
  const expected = factsFromRuleset(definition)

  const rulesetId = await findRulesetId(options, repo)
  let live: ProtectionFacts | undefined

  if (rulesetId === undefined) {
    console.log(`[branch-protection] no ruleset named "${RULESET_NAME}"`)
  } else {
    const detail = await githubRequest({
      token,
      method: 'GET',
      path: `/repos/${repo}/rulesets/${rulesetId}`,
    })
    if (detail.status !== 200) {
      throw new Error(`GET /repos/${repo}/rulesets/${rulesetId} failed with ${detail.status}: ${JSON.stringify(detail.body)}`)
    }
    live = factsFromRuleset(detail.body as RulesetDefinition)
    console.log(`[branch-protection] ruleset "${RULESET_NAME}" (id ${rulesetId}) is applied to ${repo}`)
  }

  // Classic branch protection is an acceptable alternative to a ruleset; the
  // 404 the issue reports ("Branch not protected") is not an error here.
  let classic: ProtectionFacts | undefined
  const protection = await githubRequest({
    token,
    method: 'GET',
    path: `/repos/${repo}/branches/main/protection`,
  })
  if (protection.status === 200) {
    classic = factsFromClassicProtection(protection.body)
    console.log('[branch-protection] classic protection on "main" is also configured')
  } else if (protection.status !== 404) {
    throw new Error(
      `GET /repos/${repo}/branches/main/protection failed with ${protection.status}: ${JSON.stringify(protection.body)}`
    )
  }

  const drift =
    live !== undefined
      ? describeDrift(expected, live)
      : classic !== undefined
        ? describeDrift(expected, classic)
        : ['"main" has neither a repository ruleset nor classic branch protection']

  if (drift.length > 0) {
    console.error(`[branch-protection] ${repo} does not enforce the committed policy:`)
    for (const item of drift) console.error(`  - ${item}`)
    console.error('[branch-protection] a maintainer applies it with: npm run protection:apply -- --repo ' + repo)
    return 1
  }

  console.log(`[branch-protection] ${repo} enforces the policy in ${path.basename(options.definitionPath)}`)
  return 0
}

export async function runApply(options: CliOptions): Promise<number> {
  const repo = requireRepo(options)
  const token = requireToken(options)
  const definition = await readDefinition(options.definitionPath)

  const problems = validateDefinition(definition)
  if (problems.length > 0) {
    console.error('[branch-protection] refusing to apply a definition that does not meet the policy:')
    for (const problem of problems) console.error(`  - ${problem}`)
    return 1
  }

  // Enabling a required code-owner review while CODEOWNERS still names
  // @PLACEHOLDER_OWNER would make every pull request unmergeable (#413).
  if (!options.force) {
    const codeOwners = await readText(DEFAULT_CODEOWNERS_PATH, '.github/CODEOWNERS')
    const codeOwnersProblems = validateCodeOwners(codeOwners)
    if (codeOwnersProblems.length > 0) {
      console.error('[branch-protection] refusing to apply require_code_owner_review:')
      for (const problem of codeOwnersProblems) console.error(`  - ${problem}`)
      console.error('[branch-protection] land issue #413 first, or re-run with --force if you accept the risk.')
      return 1
    }
  }

  const payload = { ...definition, bypass_actors: definition.bypass_actors ?? [] }

  if (options.dryRun) {
    console.log(`[branch-protection] dry run: would send the following to ${repo}`)
    console.log(JSON.stringify(payload, null, 2))
    return 0
  }

  const existingId = await findRulesetId(options, repo)
  const response =
    existingId === undefined
      ? await githubRequest({ token, method: 'POST', path: `/repos/${repo}/rulesets`, body: payload })
      : await githubRequest({ token, method: 'PUT', path: `/repos/${repo}/rulesets/${existingId}`, body: payload })

  if (response.status !== 200 && response.status !== 201) {
    const hint =
      response.status === 403 || response.status === 404
        ? ' (the rulesets API needs a repository admin token)'
        : ''
    throw new Error(
      `${existingId === undefined ? 'POST' : 'PUT'} /repos/${repo}/rulesets failed with ${response.status}${hint}: ${JSON.stringify(response.body)}`
    )
  }

  const id = asRecord(response.body).id
  console.log(
    `[branch-protection] ${existingId === undefined ? 'created' : 'updated'} ruleset "${RULESET_NAME}"` +
      `${typeof id === 'number' ? ` (id ${id})` : ''} on ${repo}`
  )
  return 0
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return 0
  }

  const options = parseArgs(argv)
  switch (options.command) {
    case 'apply':
      return runApply(options)
    case 'verify':
      return runVerify(options)
    default:
      return runCheck(options)
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      console.error(`[branch-protection] ${(error as Error).message}`)
      process.exitCode = 1
    })
}

