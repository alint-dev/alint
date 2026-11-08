import { definePlugin } from '@alint-js/plugin'

import { duplicatedHelperRule } from './rules/no-duplicated-helper'
import { needlessHelperRule } from './rules/no-needless-helper'
import { reinventedHelperRule } from './rules/no-reinvented-helper'

export { alphaFingerprint, exactFingerprint, normalizedBody, tokenize, tokenOverlap } from './fingerprint'
export type { IndexedHelper, RepoIndex, RepoIndexOptions, ReviewCache } from './repo'
export { helpersIn, repoIndexFor, reviewCacheFor, twinsOf } from './repo'
export type { AgentFinding, DuplicateToolsOptions } from './rules/no-duplicated-helper'
export {
  buildDuplicatedHelperPrompt,
  createDuplicateTools,
  duplicatedHelperInstructions,
  duplicatedHelperRule,
} from './rules/no-duplicated-helper'
export {
  buildNeedlessHelperPrompt,
  needlessHelperPrompt,
  needlessHelperResponseSchema,
  needlessHelperRule,
} from './rules/no-needless-helper'
export type { ReinventedHelperOptions } from './rules/no-reinvented-helper'
export {
  buildReinventedHelperPrompt,
  reinventedHelperPrompt,
  reinventedHelperResponseSchema,
  reinventedHelperRule,
} from './rules/no-reinvented-helper'
export type { SimplicitySettings } from './rules/shared/settings'

export const simplicityPlugin = definePlugin({
  configs: {
    /*
     * The rule ids carry the `simplicity/` prefix, so the preset only resolves when the plugin
     * is registered under that alias. Both rules need a model, except `no-duplicated-helper`'s
     * AST approach; set `settings.simplicity.judge` to false to keep only that.
     *
     * The glob covers Go, Python and Rust, which core does not parse. Register
     * `@alint-js/languages` alongside this preset, or those files reach no rule and the run reports
     * `alint/unregistered-language`.
     */
    recommended: [
      {
        files: ['**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,rs,go,py}'],
        rules: {
          'simplicity/no-duplicated-helper': 'warn',
          'simplicity/no-needless-helper': 'warn',
        },
      },
    ],
  },
  rules: {
    'no-duplicated-helper': duplicatedHelperRule,
    'no-needless-helper': needlessHelperRule,
    // Not in `recommended`: it has no default, because only the repository knows its libraries.
    'no-reinvented-helper': reinventedHelperRule,
  },
})

export default simplicityPlugin
