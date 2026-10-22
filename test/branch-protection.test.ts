import { readFile } from 'node:fs/promises'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_CI_WORKFLOW_PATH,
  DEFAULT_DEFINITION_PATH,
  REQUIRED_CHECK_CONTEXTS,
  checkWorkflowCheckContexts,
  describeDrift,
  factsFromClassicProtection,
  factsFromRuleset,
  findCodeOwnersPlaceholders,
  matrixValuesForJob,
  parseArgs,
  readDefinition,
  validateCodeOwners,
  validateDefinition,
  workflowJobIds,
  type RulesetDefinition,
  type RulesetRule,
} from '../scripts/branch-protection.js'

// Issue #414: the committed ruleset is the only thing standing between `main`
// and an unreviewed or red-CI merge. These tests fail if it is weakened, points
// at a status check that never reports, or drifts from the live repository.

let committed: RulesetDefinition
let ciYaml: string

function mutated(mutate: (definition: RulesetDefinition) => void): RulesetDefinition {
  const clone = structuredClone(committed)
  mutate(clone)
  return clone
}

function ruleOf(definition: RulesetDefinition, type: string): RulesetRule {
  const rule = (definition.rules ?? []).find((entry) => entry.type === type)
  if (rule === undefined) throw new Error(`definition has no "${type}" rule`)
  return rule
}

beforeAll(async () => {
  committed = await readDefinition(DEFAULT_DEFINITION_PATH)
  ciYaml = await readFile(DEFAULT_CI_WORKFLOW_PATH, 'utf8')
})

describe('committed ruleset definition', () => {
  it('meets the policy the issue asks for', () => {
    expect(validateDefinition(committed)).toEqual([])
  })

  it('requires a pull request, one approval and a code-owner review', () => {
    const facts = factsFromRuleset(committed)

    expect(facts.requiresPullRequest).toBe(true)
    expect(facts.requiredApprovals).toBeGreaterThanOrEqual(1)
    expect(facts.requiresCodeOwnerReview).toBe(true)
    expect(facts.dismissesStaleReviews).toBe(true)
  })

  it('blocks force-pushes and deletion with no bypass actors', () => {
    const facts = factsFromRuleset(committed)

    expect(facts.blocksDeletion).toBe(true)
    expect(facts.blocksForcePush).toBe(true)
    expect(facts.bypassActors).toBe(0)
    expect(facts.enforcement).toBe('active')
  })

  it('requires exactly the checks the CI workflow reports', () => {
    expect(factsFromRuleset(committed).requiredChecks).toEqual([...REQUIRED_CHECK_CONTEXTS])
    expect(checkWorkflowCheckContexts(REQUIRED_CHECK_CONTEXTS, ciYaml)).toEqual([])
  })
})

describe('validateDefinition', () => {
  it('rejects a ruleset that is not enforced', () => {
    const problems = validateDefinition(mutated((definition) => {
      definition.enforcement = 'disabled'
    }))

    expect(problems.join('\n')).toMatch(/enforced/)
  })

  it('rejects a ruleset that targets something other than a branch', () => {
    const problems = validateDefinition(mutated((definition) => {
      definition.target = 'tag'
    }))

    expect(problems.join('\n')).toMatch(/target must be "branch"/)
  })

  it('rejects a ruleset that does not cover the default branch', () => {
    const problems = validateDefinition(mutated((definition) => {
      definition.conditions = { ref_name: { include: ['refs/heads/preview'], exclude: [] } }
    }))

    expect(problems.join('\n')).toMatch(/default branch/)
  })

  it('rejects bypass actors', () => {
    const problems = validateDefinition(mutated((definition) => {
      definition.bypass_actors = [{ actor_id: 1, actor_type: 'RepositoryRole', bypass_mode: 'always' }]
    }))

    expect(problems.join('\n')).toMatch(/must not grant bypass/)
  })

  it('rejects a ruleset without the pull_request rule', () => {
    const problems = validateDefinition(mutated((definition) => {
      definition.rules = (definition.rules ?? []).filter((entry) => entry.type !== 'pull_request')
    }))

    expect(problems.join('\n')).toMatch(/require a pull request/)
  })

  it('rejects zero required approvals', () => {
    const problems = validateDefinition(mutated((definition) => {
      const rule = ruleOf(definition, 'pull_request')
      rule.parameters = { ...rule.parameters, required_approving_review_count: 0 }
    }))

    expect(problems.join('\n')).toMatch(/at least 1 approving review/)
  })

  it('rejects a ruleset that stops requiring a code-owner review', () => {
    const problems = validateDefinition(mutated((definition) => {
      const rule = ruleOf(definition, 'pull_request')
      rule.parameters = { ...rule.parameters, require_code_owner_review: false }
    }))

    expect(problems.join('\n')).toMatch(/code-owner review/)
  })

  it('rejects a ruleset missing a required status check', () => {
    const problems = validateDefinition(mutated((definition) => {
      const rule = ruleOf(definition, 'required_status_checks')
      rule.parameters = {
        ...rule.parameters,
        required_status_checks: [{ context: 'build-and-test (22)' }, { context: 'build-and-test (24)' }],
      }
    }))

    expect(problems.join('\n')).toMatch(/must include "docker-build"/)
  })

  it('rejects a ruleset that allows deletion or force-pushes', () => {
    const problems = validateDefinition(mutated((definition) => {
      definition.rules = (definition.rules ?? []).filter(
        (entry) => entry.type !== 'deletion' && entry.type !== 'non_fast_forward'
      )
    }))

    expect(problems.join('\n')).toMatch(/must block branch deletion/)
    expect(problems.join('\n')).toMatch(/must block force-pushes/)
  })

  it('rejects a definition renamed away from the managed ruleset', () => {
    const problems = validateDefinition(mutated((definition) => {
      definition.name = 'something-else'
    }))

    expect(problems.join('\n')).toMatch(/ruleset name must be "main-protection"/)
  })
})


describe('describeDrift', () => {
  const expected = () => factsFromRuleset(committed)

  it('reports no drift when the live ruleset matches the definition', () => {
    expect(describeDrift(expected(), factsFromRuleset(structuredClone(committed)))).toEqual([])
  })

  it('reports a required check the live ruleset dropped', () => {
    const live = structuredClone(committed)
    const rule = ruleOf(live, 'required_status_checks')
    rule.parameters = {
      ...rule.parameters,
      required_status_checks: [{ context: 'build-and-test (22)' }, { context: 'build-and-test (24)' }],
    }

    const drift = describeDrift(expected(), factsFromRuleset(live))

    expect(drift.join('\n')).toMatch(/required status check missing: "docker-build"/)
  })

  it('reports a live ruleset that allows force-pushes and deletion', () => {
    const live = structuredClone(committed)
    live.rules = (live.rules ?? []).filter(
      (entry) => entry.type !== 'deletion' && entry.type !== 'non_fast_forward'
    )

    const drift = describeDrift(expected(), factsFromRuleset(live))

    expect(drift.join('\n')).toMatch(/force-push blocked: expected true, found false/)
    expect(drift.join('\n')).toMatch(/deletion blocked: expected true, found false/)
  })

  it('reports a lowered approval count and a removed code-owner requirement', () => {
    const live = structuredClone(committed)
    const rule = ruleOf(live, 'pull_request')
    rule.parameters = { ...rule.parameters, required_approving_review_count: 0, require_code_owner_review: false }

    const drift = describeDrift(expected(), factsFromRuleset(live))

    expect(drift.join('\n')).toMatch(/required approvals: expected at least 1, found 0/)
    expect(drift.join('\n')).toMatch(/code-owner review: expected true, found false/)
  })

  it('reports a check the definition does not list', () => {
    const live = structuredClone(committed)
    const rule = ruleOf(live, 'required_status_checks')
    rule.parameters = {
      ...rule.parameters,
      required_status_checks: [...REQUIRED_CHECK_CONTEXTS.map((context) => ({ context })), { context: 'mutation-test' }],
    }

    const drift = describeDrift(expected(), factsFromRuleset(live))

    expect(drift.join('\n')).toMatch(/unexpected required status check: "mutation-test"/)
  })
})

describe('factsFromClassicProtection', () => {
  const classicProtection = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    required_status_checks: {
      strict: false,
      contexts: [...REQUIRED_CHECK_CONTEXTS],
    },
    enforce_admins: { enabled: true },
    required_pull_request_reviews: {
      required_approving_review_count: 1,
      require_code_owner_reviews: true,
      dismiss_stale_reviews: true,
    },
    allow_deletions: { enabled: false },
    allow_force_pushes: { enabled: false },
    ...overrides,
  })

  it('accepts classic protection that matches the policy', () => {
    const facts = factsFromClassicProtection(classicProtection())

    expect(describeDrift(factsFromRuleset(committed), facts)).toEqual([])
  })

  it('reads the legacy `checks` array as well as `contexts`', () => {
    const facts = factsFromClassicProtection(
      classicProtection({
        required_status_checks: {
          strict: false,
          checks: REQUIRED_CHECK_CONTEXTS.map((context) => ({ context, app_id: null })),
        },
      })
    )

    expect(facts.requiredChecks).toEqual([...REQUIRED_CHECK_CONTEXTS])
  })

  it('treats "null" allow_deletions/allow_force_pushes as unprotected', () => {
    const facts = factsFromClassicProtection(
      classicProtection({ allow_deletions: { enabled: null }, allow_force_pushes: null })
    )

    expect(facts.blocksDeletion).toBe(false)
    expect(facts.blocksForcePush).toBe(false)
  })

  it('treats admins that are not enforced as a bypass', () => {
    const facts = factsFromClassicProtection(classicProtection({ enforce_admins: { enabled: false } }))

    expect(facts.bypassActors).toBe(1)
    expect(describeDrift(factsFromRuleset(committed), facts).join('\n')).toMatch(/bypass actors: expected 0, found 1/)
  })

  it('reports classic protection with no required reviews', () => {
    const facts = factsFromClassicProtection(classicProtection({ required_pull_request_reviews: undefined }))

    expect(facts.requiresPullRequest).toBe(false)
    expect(describeDrift(factsFromRuleset(committed), facts).join('\n')).toMatch(
      /pull request requirement: expected true, found false/
    )
  })
})

describe('CODEOWNERS preflight', () => {
  it('finds placeholder owners', () => {
    const findings = findCodeOwnersPlaceholders(
      ['# comment', '/src/auth.ts @PLACEHOLDER_OWNER', '/src/ @PLACEHOLDER_OWNER @realowner'].join('\n')
    )

    expect(findings).toHaveLength(2)
    expect(findings[0]).toMatch(/src\/auth\.ts/)
    expect(findings[1]).toMatch(/\/src\/ -> @PLACEHOLDER_OWNER/)
  })

  it('ignores comments and rules with no owners', () => {
    expect(findCodeOwnersPlaceholders('# /src/ @PLACEHOLDER_OWNER\n/src/ @maintainer')).toEqual([])
  })

  it('accepts a CODEOWNERS file with real owners', () => {
    expect(validateCodeOwners('/src/ @maintainer\n/src/auth.ts @maintainer')).toEqual([])
  })

  it('refuses to require code-owner review over placeholder owners', () => {
    const problems = validateCodeOwners('/src/auth.ts @PLACEHOLDER_OWNER\n')

    expect(problems.join('\n')).toMatch(/placeholder/)
    expect(problems.join('\n')).toMatch(/#413/)
  })

  it('refuses an empty CODEOWNERS file', () => {
    expect(validateCodeOwners('# nothing here\n')).toHaveLength(1)
    expect(validateCodeOwners('# nothing here\n')[0]).toMatch(/CODEOWNERS is empty/)
  })
})

describe('workflow check contexts', () => {
  it('reads the job ids from the real CI workflow', () => {
    const jobIds = workflowJobIds(ciYaml)

    expect(jobIds).toContain('build-and-test')
    expect(jobIds).toContain('docker-build')
  })

  it('reads the node-version matrix of the real CI workflow', () => {
    expect(matrixValuesForJob(ciYaml, 'build-and-test')).toEqual(['22', '24'])
    expect(matrixValuesForJob(ciYaml, 'docker-build')).toEqual([])
  })

  it('flags a required check that matches no job', () => {
    const problems = checkWorkflowCheckContexts(['build-and-test (22)', 'no-such-job'], ciYaml)

    expect(problems.join('\n')).toMatch(/no job named "no-such-job"/)
  })

  it('flags a matrix value the workflow does not run', () => {
    const problems = checkWorkflowCheckContexts(['build-and-test (20)'], ciYaml)

    expect(problems.join('\n')).toMatch(/would never report/)
  })

  it('flags an unreadable workflow instead of passing silently', () => {
    expect(checkWorkflowCheckContexts(REQUIRED_CHECK_CONTEXTS, '')).toHaveLength(1)
  })
})

describe('parseArgs', () => {
  it('defaults to the check command', () => {
    const options = parseArgs(['check'])

    expect(options.command).toBe('check')
    expect(options.definitionPath).toBe(DEFAULT_DEFINITION_PATH)
    expect(options.dryRun).toBe(false)
    expect(options.force).toBe(false)
  })

  it('accepts a repository and a dry run', () => {
    const options = parseArgs(['apply', '--repo', 'ourdao/ourdao-backend', '--dry-run'])

    expect(options.command).toBe('apply')
    expect(options.repo).toBe('ourdao/ourdao-backend')
    expect(options.dryRun).toBe(true)
  })

  it('accepts --force and a custom definition path', () => {
    const options = parseArgs(['apply', '--force', '--definition', '.github/rulesets/main.json'])

    expect(options.force).toBe(true)
    expect(options.definitionPath.endsWith('main.json')).toBe(true)
  })

  it('rejects an unknown command', () => {
    expect(() => parseArgs(['deploy'])).toThrow(/unknown command/)
  })

  it('rejects an unknown option', () => {
    expect(() => parseArgs(['check', '--nope'])).toThrow(/unknown option/)
  })

  it('rejects a flag with no value', () => {
    expect(() => parseArgs(['verify', '--repo'])).toThrow(/needs a value/)
  })
})

