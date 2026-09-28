import { describe, expect, it } from 'vitest'

import plugin, {
  configFileTestsRule,
  duplicatedKnowledgeRule,
  overlappingEntrypointsRule,
  redundantCatchRule,
  singleUseMaterializationRule,
  testOnlyProductionWrapperRule,
} from './index'

const RECOMMENDED_RULES = {
  'js/inline-miniature-normalizer': 'warn',
  'js/no-config-file-tests': 'warn',
  'js/no-mixed-layers-without-abstraction': 'warn',
  'js/no-private-schema-toolkit': 'warn',
  'js/no-redundant-binding': 'warn',
  'js/no-redundant-jsdoc': 'warn',
  'js/no-trivial-wrapper-stack': 'warn',
  'js/no-vacuous-function': 'warn',
} as const

const REPOSITORY_AWARE_RULE_IDS = [
  'no-duplicated-knowledge',
  'no-overlapping-entrypoints',
  'no-redundant-catch',
  'no-single-use-materialization',
  'no-test-only-production-wrapper',
] as const

describe('@alint-js/plugin-js registry', () => {
  it('registers repository-aware rules', () => {
    expect(plugin.rules?.['no-duplicated-knowledge']).toBe(duplicatedKnowledgeRule)
    expect(plugin.rules?.['no-overlapping-entrypoints']).toBe(overlappingEntrypointsRule)
    expect(plugin.rules?.['no-redundant-catch']).toBe(redundantCatchRule)
    expect(plugin.rules?.['no-single-use-materialization']).toBe(singleUseMaterializationRule)
    expect(plugin.rules?.['no-test-only-production-wrapper']).toBe(testOnlyProductionWrapperRule)
  })

  it('keeps repository-aware rules opt-in and includes local rules in recommended', () => {
    expect(plugin.configs?.recommended).toEqual([
      {
        rules: RECOMMENDED_RULES,
      },
    ])

    for (const ruleId of Object.keys(RECOMMENDED_RULES)) {
      expect(plugin.rules).toHaveProperty(ruleId.replace(/^js\//, ''))
    }

    for (const ruleId of REPOSITORY_AWARE_RULE_IDS) {
      expect(RECOMMENDED_RULES).not.toHaveProperty(`js/${ruleId}`)
    }

    expect(plugin.rules?.['no-config-file-tests']).toBe(configFileTestsRule)
  })
})
