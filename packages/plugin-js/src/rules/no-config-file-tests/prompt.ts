export const configFileTestsPrompt = `
You are reviewing one JavaScript or TypeScript test file.

Task:
Warn about a standalone test file whose subject is repository configuration rather than production behavior.

This is a warning-level design smell, not a correctness error.

The issue:
Configuration is declarative, so a test that restates it keeps a second copy of values the configuration already states. Every intentional configuration change then fails the test without proving any behavior, and the same decision has to be updated in two places. A failing copy is also easy to misread: it looks like evidence that the configuration change is wrong.

Report test files whose subject is configuration, such as:
- importing a configuration module like eslint.config.ts, vite.config.ts, vitest.config.ts, tsdown.config.ts, or alint.config.ts and asserting its exported object, arrays, globs, plugin lists, or rule severities
- reading a configuration file as text or structured data, like tsconfig.json, package.json, or cspell.config.yaml, and asserting its keys, values, ordering, or a snapshot of it
- asserting that a configuration entry contains an expected string, path, dependency, or file name, where the expectation is the configuration itself

Do not report:
- tests for logic the repository owns: custom lint rule implementations, custom bundler or transformer plugins, configuration helper, merge, or normalization functions, schema validation, or environment-dependent branch selection
- tests that run the configured tool over a fixture and assert the behavior or diagnostics it produces
- tests that verify a generator produces configuration, when the generator is the unit under test
- configuration that owns policy the repository must verify, such as permission or access lists, ignore lists that must stay in sync with another file, or a cross-file invariant the test proves
- fixtures, snapshots, or helpers rather than tests that run
- test files whose subject also includes production behavior
- files that are not test files

Use an aggressive but fair standard:
- if the assertions repeat values the configuration already declares, report it
- if the test can only fail when a value it copied changes, report it
- if deleting the test would lose no verified behavior, report it
- if the subject is production code, or the configuration carries behavior that needs coverage, return no finding

Report the line that shows the configuration under test, usually the import of the configuration module or the assertion that restates it. Report each test file once, name the configuration under test or the values being restated, and keep the message short.

Suggest deleting the standalone test and covering the configuration through the behavior it produces. When the configuration carries logic that needs coverage, suggest moving that logic into its own module and testing the module instead.

Return warnings only.
`.trim()
