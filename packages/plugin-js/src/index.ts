import { definePlugin } from '@alint-js/plugin'

import { inlineMiniatureNormalizerRule } from './rules/inline-miniature-normalizer'
import { configFileTestsRule } from './rules/no-config-file-tests'
import { duplicatedKnowledgeRule } from './rules/no-duplicated-knowledge'
import { mixedLayersWithoutAbstractionRule } from './rules/no-mixed-layers-without-abstraction'
import { overlappingEntrypointsRule } from './rules/no-overlapping-entrypoints'
import { privateSchemaToolkitRule } from './rules/no-private-schema-toolkit'
import { redundantBindingRule } from './rules/no-redundant-binding'
import { redundantCatchRule } from './rules/no-redundant-catch'
import { redundantJsdocRule } from './rules/no-redundant-jsdoc'
import { singleUseMaterializationRule } from './rules/no-single-use-materialization'
import { testOnlyProductionWrapperRule } from './rules/no-test-only-production-wrapper'
import { trivialWrapperStackRule } from './rules/no-trivial-wrapper-stack'
import { vacuousFunctionRule } from './rules/no-vacuous-function'

export { createJudgeMessages, createReportFindingsToolParameters, judgeFindingSchema, judgeResponseSchema } from './agents/judge'
export { inlineMiniatureNormalizerRule } from './rules/inline-miniature-normalizer'
export { configFileTestsRule } from './rules/no-config-file-tests'
export { duplicatedKnowledgeRule } from './rules/no-duplicated-knowledge'
export { mixedLayersWithoutAbstractionRule } from './rules/no-mixed-layers-without-abstraction'
export { overlappingEntrypointsRule } from './rules/no-overlapping-entrypoints'
export { privateSchemaToolkitRule } from './rules/no-private-schema-toolkit'
export { redundantBindingRule } from './rules/no-redundant-binding'
export { redundantCatchRule } from './rules/no-redundant-catch'
export { redundantJsdocRule } from './rules/no-redundant-jsdoc'
export { singleUseMaterializationRule } from './rules/no-single-use-materialization'
export { testOnlyProductionWrapperRule } from './rules/no-test-only-production-wrapper'
export { trivialWrapperStackRule } from './rules/no-trivial-wrapper-stack'
export { vacuousFunctionRule } from './rules/no-vacuous-function'

export default definePlugin({
  configs: {
    recommended: [
      {
        rules: {
          'js/inline-miniature-normalizer': 'warn',
          'js/no-mixed-layers-without-abstraction': 'warn',
          'js/no-private-schema-toolkit': 'warn',
          'js/no-redundant-binding': 'warn',
          'js/no-redundant-jsdoc': 'warn',
          'js/no-trivial-wrapper-stack': 'warn',
          'js/no-vacuous-function': 'warn',
        },
      },
    ],
  },
  rules: {
    'inline-miniature-normalizer': inlineMiniatureNormalizerRule,
    'no-config-file-tests': configFileTestsRule,
    'no-duplicated-knowledge': duplicatedKnowledgeRule,
    'no-mixed-layers-without-abstraction': mixedLayersWithoutAbstractionRule,
    'no-overlapping-entrypoints': overlappingEntrypointsRule,
    'no-private-schema-toolkit': privateSchemaToolkitRule,
    'no-redundant-binding': redundantBindingRule,
    'no-redundant-catch': redundantCatchRule,
    'no-redundant-jsdoc': redundantJsdocRule,
    'no-single-use-materialization': singleUseMaterializationRule,
    'no-test-only-production-wrapper': testOnlyProductionWrapperRule,
    'no-trivial-wrapper-stack': trivialWrapperStackRule,
    'no-vacuous-function': vacuousFunctionRule,
  },
})
