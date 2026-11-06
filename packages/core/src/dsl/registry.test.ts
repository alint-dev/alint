import { number, object, optional } from 'valibot'
import { describe, expect, it } from 'vitest'

import { definePlugin, defineRule } from './define'
import { buildRuleRegistry } from './registry'

describe('rule registry', () => {
  it('registers plugin rules without implicitly enabling them', () => {
    const rule = defineRule({
      create: () => ({}),
    })
    const registry = buildRuleRegistry({
      plugins: {
        company: definePlugin({
          rules: {
            review: rule,
          },
        }),
      },
      rules: {},
    })

    expect(registry.rules.get('company/review')).toBe(rule)
    expect(registry.enabledRules).toEqual([])
  })

  it('enables only configured rules by flat plugin alias', () => {
    const reviewRule = defineRule({
      create: () => ({}),
    })
    const namingRule = defineRule({
      create: () => ({}),
    })
    const registry = buildRuleRegistry({
      plugins: {
        company: definePlugin({
          rules: {
            naming: namingRule,
            review: reviewRule,
          },
        }),
      },
      rules: {
        'company/review': 'error',
      },
    })

    expect(registry.enabledRules).toEqual([
      {
        id: 'company/review',
        localId: 'review',
        options: [],
        rule: reviewRule,
        severity: 'error',
      },
    ])
  })

  it('rejects configured rules that are not registered by plugins', () => {
    expect(() => buildRuleRegistry({
      plugins: {
        company: definePlugin({
          rules: {
            review: defineRule({
              create: () => ({}),
            }),
          },
        }),
      },
      rules: {
        'company/missing': 'warn',
      },
    })).toThrow('Unknown rule "company/missing".')
  })

  it('does not enable rules configured with off severity', () => {
    const rule = defineRule({
      create: () => ({}),
    })
    const registry = buildRuleRegistry({
      plugins: {
        company: definePlugin({
          rules: {
            review: rule,
          },
        }),
      },
      rules: {
        'company/review': 'off',
      },
    })

    expect(registry.rules.get('company/review')).toBe(rule)
    expect(registry.enabledRules).toEqual([])
  })

  it('uses tuple severity entries when enabling configured rules', () => {
    const rule = defineRule({
      create: () => ({}),
    })
    const registry = buildRuleRegistry({
      plugins: {
        company: definePlugin({
          rules: {
            review: rule,
          },
        }),
      },
      rules: {
        'company/review': ['warn'],
      },
    })

    expect(registry.enabledRules).toEqual([
      {
        id: 'company/review',
        localId: 'review',
        options: [],
        rule,
        severity: 'warn',
      },
    ])
  })

  it('rejects duplicate rule ids across flat plugin aliases', () => {
    const rule = defineRule({
      create: () => ({}),
    })

    expect(() => buildRuleRegistry({
      plugins: {
        'company': definePlugin({
          rules: {
            'review/task': rule,
          },
        }),
        'company/review': definePlugin({
          rules: {
            task: rule,
          },
        }),
      },
      rules: {},
    })).toThrow('Duplicate rule id "company/review/task".')
  })

  it('stores parsed rule options for enabled rules', () => {
    const rule = defineRule({
      create: () => ({}),
      options: [
        object({
          maxLines: optional(number(), 10),
        }),
      ],
    })

    const registry = buildRuleRegistry({
      plugins: {
        company: definePlugin({
          rules: {
            review: rule,
          },
        }),
      },
      rules: {
        'company/review': ['warn', {}],
      },
    })

    expect(registry.enabledRules).toEqual([
      {
        id: 'company/review',
        localId: 'review',
        options: [
          { maxLines: 10 },
        ],
        rule,
        severity: 'warn',
      },
    ])
  })

  it('normalizes omitted rule options with schema defaults', () => {
    const rule = defineRule({
      create: () => ({}),
      options: [
        object({
          maxLines: optional(number(), 10),
        }),
      ],
    })

    const registry = buildRuleRegistry({
      plugins: {
        company: definePlugin({
          rules: {
            review: rule,
          },
        }),
      },
      rules: {
        'company/review': ['warn'],
      },
    })

    expect(registry.enabledRules).toEqual([
      {
        id: 'company/review',
        localId: 'review',
        options: [
          { maxLines: 10 },
        ],
        rule,
        severity: 'warn',
      },
    ])
  })

  it('rejects invalid rule options before enabling a rule', () => {
    const rule = defineRule({
      create: () => ({}),
      options: [
        object({
          maxLines: optional(number(), 10),
        }),
      ],
    })

    expect(() => buildRuleRegistry({
      plugins: {
        company: definePlugin({
          rules: {
            review: rule,
          },
        }),
      },
      rules: {
        'company/review': [
          'warn',
          { maxLines: 'ten' },
        ],
      },
    })).toThrow('Invalid options for rule "company/review": "0.maxLines": Invalid type: Expected number but received "ten"')
  })

  it('rejects extra options for rules without an options schema', () => {
    const rule = defineRule({
      create: () => ({}),
    })

    expect(() => buildRuleRegistry({
      plugins: {
        company: definePlugin({
          rules: {
            review: rule,
          },
        }),
      },
      rules: {
        'company/review': [
          'warn',
          { maxLines: 10 },
        ],
      },
    })).toThrow('Rule "company/review" does not accept options.')
  })

  it('rejects extra rule options beyond the options schema', () => {
    const rule = defineRule({
      create: () => ({}),
      options: [
        object({
          maxLines: optional(number(), 10),
        }),
      ],
    })

    expect(() => buildRuleRegistry({
      plugins: {
        company: definePlugin({
          rules: {
            review: rule,
          },
        }),
      },
      rules: {
        'company/review': [
          'warn',
          {},
          { extra: true },
        ],
      },
    })).toThrow('Invalid options for rule "company/review": Unexpected option at index 1.')
  })
})
