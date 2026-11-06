import { defineConfig } from '@moeru/eslint-config'

export default defineConfig({
  masknet: false,
  perfectionist: true,
  preferArrow: false,
  sonarjs: false,
  sortPackageJsonScripts: false,
  typescript: true,
  unocss: false,
  vue: true,
}, {
  ignores: [
    'cspell.config.yaml',
    'cspell.config.yml',
    '**/drizzle/**',
    '**/.astro/**',
    '.agents/**',
    '.worktrees/**',
    '.github/**',
    'docs/superpowers/**',
    'plugins/codex-plugin-alint/scripts/stop-gate.mjs',
    'CLAUDE.md', // Skip the symbolic link
  ],
}, {
  rules: {
    'antfu/import-dedupe': 'error',
    // TODO: remove this
    'depend/ban-dependencies': 'warn',
    'import/order': 'off',
    'markdown/require-alt-text': 'off',

    'no-console': [
      'error',
      {
        allow: ['warn', 'error', 'info'],
      },
    ],
    'no-restricted-syntax': [
      'warn',
      // Catches the manual `error instanceof Error ? error.message : ...`
      // pattern AGENTS.md forbids. The selector matches a ConditionalExpression
      // whose test is `<x> instanceof Error` and whose consequent is `<x>.message`,
      // so it does NOT false-positive on `error instanceof Error ? error : new Error(...)`
      // (where the consequent is the error itself, not its `.message`). Antfu's
      // default no-restricted-syntax patterns are preserved alongside.
      {
        message: 'Avoid `error instanceof Error ? error.message : ...`. Use `errorMessageFrom(error)` from \'@moeru/std\'. Pair with `?? \'fallback\'` when a default is needed.',
        selector: 'ConditionalExpression[test.type=\'BinaryExpression\'][test.operator=\'instanceof\'][test.right.name=\'Error\'][consequent.type=\'MemberExpression\'][consequent.property.name=\'message\']',
      },
      {
        message: 'Avoid hand-written clamp logic. Use `clamp(value, lower, upper)` from `es-toolkit` instead.',
        selector: 'FunctionDeclaration[id.name=/clamp/i] ReturnStatement CallExpression[callee.object.name=\'Math\'][callee.property.name=\'min\'] > CallExpression[callee.object.name=\'Math\'][callee.property.name=\'max\']:first-child',
      },
      {
        message: 'Avoid hand-written clamp logic. Use `clamp(value, lower, upper)` from `es-toolkit` instead.',
        selector: 'FunctionDeclaration[id.name=/clamp/i] ReturnStatement CallExpression[callee.object.name=\'Math\'][callee.property.name=\'max\'] > CallExpression[callee.object.name=\'Math\'][callee.property.name=\'min\']:first-child',
      },
      {
        message: 'Do not use namespace imports from `valibot`. Import the used Valibot APIs by name instead.',
        selector: 'ImportDeclaration[source.value=\'valibot\'] ImportNamespaceSpecifier',
      },
      'TSEnumDeclaration[const=true]',
      'TSExportAssignment',
    ],
    'style/padding-line-between-statements': 'error',
    'vue/prefer-separate-static-class': 'off',
    'yaml/plain-scalar': 'off',
  },
}, {
  files: ['apps/server/**/*.ts'],
  rules: {
    'no-restricted-syntax': [
      'error',
      {
        message: 'Do not mock internal project modules with vi.mock or vi.doMock. Inject the collaborator through the route, service, or factory boundary and pass a fake or spy in tests.',
        selector: 'CallExpression[callee.type=\'MemberExpression\'][callee.object.name=\'vi\'][callee.property.name=/^(mock|doMock)$/][arguments.0.type=\'Literal\'][arguments.0.value=/^(\\.|@proj-airi\\/|~)/]',
      },
      {
        message: 'Do not use vi.hoisted. If a test needs a collaborator spy, expose an explicit dependency injection point instead of hoisting module mocks.',
        selector: 'CallExpression[callee.type=\'MemberExpression\'][callee.object.name=\'vi\'][callee.property.name=\'hoisted\']',
      },
    ],
  },
}, {
  ignores: [
    '**/*.md',
  ],
  rules: {
    'perfectionist/sort-imports': [
      'error',
      {
        groups: [
          'type-builtin',
          'type-import',
          'type-internal',
          ['type-parent', 'type-sibling', 'type-index'],
          'default-value-builtin',
          'named-value-builtin',
          'value-builtin',
          'default-value-external',
          'named-value-external',
          'value-external',
          'default-value-internal',
          'named-value-internal',
          'value-internal',
          ['default-value-parent', 'default-value-sibling', 'default-value-index'],
          ['named-value-parent', 'named-value-sibling', 'named-value-index'],
          ['wildcard-value-parent', 'wildcard-value-sibling', 'wildcard-value-index'],
          ['value-parent', 'value-sibling', 'value-index'],
          'side-effect',
          'style',
        ],
        newlinesBetween: 1,
      },
    ],
  },
})
