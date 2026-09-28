import type { BuiltInAgentName, DeclarativeRuleDefinition } from './types'

/**
 * Behavior version of each built-in agent.
 *
 * A declarative rule is built from a shared factory, so the rule source that the run engine
 * hashes is identical for every declarative rule. Nothing in that source tells the engine what
 * the preset actually sends to the model: the instruction, the supplemental files, and the
 * message layout all sit in the rule definition or in this package.
 *
 * Bump the version of an agent when its prompt assembly, message layout, or finding reporting
 * changes, so cached findings never outlive the behavior that produced them.
 */
export const builtInAgentVersions = {
  'basic-coding-agent': 1,
  'basic-structured': 1,
} as const satisfies Record<BuiltInAgentName, number>

/**
 * Cache key for one declarative rule: every declared input that changes its findings.
 *
 * Without it, editing `instruction` in `rule.alint.toml` leaves the rule source untouched, the
 * cache fingerprint stays equal, and the next run replays findings the new rule text would never
 * produce. The run only reports that the entry was a cache hit, so the stale result is silent.
 *
 * @see {@link builtInAgentVersions}
 */
export function createDeclarativeCacheKey(rule: DeclarativeRuleDefinition): Record<string, unknown> {
  return {
    agent: rule.builtInAgent,
    agentVersion: builtInAgentVersions[rule.builtInAgent],
    excludeFiles: rule.excludeFiles,
    includeFiles: rule.includeFiles,
    instruction: rule.instruction,
  }
}
