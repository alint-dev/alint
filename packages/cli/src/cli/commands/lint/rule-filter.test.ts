import { describe, expect, it } from 'vitest'

import { resolveRuleFilter } from './rule-filter'

describe('resolveRuleFilter', () => {
  it('returns nothing without the flag', () => {
    expect(resolveRuleFilter(undefined)).toBeUndefined()
  })

  it('keeps a single pattern', () => {
    expect(resolveRuleFilter('company/review')).toEqual(['company/review'])
  })

  it('splits a comma-separated list', () => {
    expect(resolveRuleFilter('company/review,company/naming')).toEqual(['company/review', 'company/naming'])
  })

  it('keeps repeated flags', () => {
    expect(resolveRuleFilter(['company/review', 'company/naming'])).toEqual(['company/review', 'company/naming'])
  })

  it('trims entries and drops duplicates', () => {
    expect(resolveRuleFilter(' company/review , company/review ')).toEqual(['company/review'])
  })

  it('rejects an empty value instead of running every rule', () => {
    expect(() => resolveRuleFilter('')).toThrow('--rule requires a rule id, a rule name, or a glob pattern.')
  })
})
