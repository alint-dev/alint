import type { RuleContext } from '@alint-js/plugin'
import type { InferOutput } from 'valibot'

import type { PackageImport } from './imports'

import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'

import { formatOutputLanguageInstruction, generateStructured } from '@alint-js/core/structured-output'
import { defineRule } from '@alint-js/plugin'
import { DEFAULT_IGNORE_PATTERNS, listFiles } from '@alint-js/tools-fs'
import { array, description, object, optional, pipe, string } from 'valibot'

import { extractPackageImports } from './imports'
import { buildMixedLibrariesPrompt, mixedLibrariesPrompt } from './prompt'

export interface MixedLibraryFinding {
  /** The package that the repository keeps. */
  canonical: string
  /** The package to replace. */
  name: string
  purpose: string
  reason: string
}

/** Package name -> absolute file path -> the imports of that package in that file. */
export type PackageUsage = Map<string, Map<string, PackageImport[]>>

export const mixedLibrariesResponseSchema = pipe(
  object({
    groups: array(object({
      alternatives: array(object({
        name: pipe(string(), description('Package name, exactly as listed.')),
        reason: pipe(string(), description('One sentence. Why the canonical package can replace this package.')),
      })),
      canonical: pipe(string(), description('Package name, exactly as listed.')),
      purpose: pipe(string(), description('The shared job, in a few lowercase words.')),
    })),
  }),
  description('Report the groups of overlapping packages. Report an empty list if there are none.'),
)

const optionsSchema = optional(object({
  /** Sets of packages that can coexist. A group inside one set is not reported. */
  allow: optional(array(array(string())), []),
  /** Packages that the repository has chosen. One of them becomes the canonical member of its group. */
  preferred: optional(array(string()), []),
}), {})

export type MixedLibrariesOptions = NonNullable<InferOutput<typeof optionsSchema>>

interface Review {
  findings: MixedLibraryFinding[]
  usage: PackageUsage
}

/*
 * The review is a fact about the workspace, not about one file, so it runs once per run: the
 * first file that asks builds it, and every other file reuses it. `ctx.src` is the one object a
 * run shares across rule instances, the same key the simplicity index uses.
 */
const reviews = new WeakMap<object, Promise<Review>>()

/**
 * Reports the imports of a library when the repository also uses another library for the same job.
 *
 * The usage index covers every JavaScript, TypeScript, and Vue file in the workspace, so a run on
 * changed files sees the same groups as a full run. Diagnostics go only to the linted files.
 */
export const mixedLibrariesRule = defineRule({
  // The verdict depends on every file in the workspace, not only on the linted target.
  cache: false,
  create: (ctx) => {
    const [{ allow, preferred }] = ctx.options

    return {
      async onTargetFile(target) {
        let review = reviews.get(ctx.src)
        if (review === undefined) {
          review = reviewWorkspace(ctx, { allow, preferred })
          reviews.set(ctx.src, review)
        }

        const { findings, usage } = await review
        const filePath = resolve(ctx.cwd, target.file.path)

        for (const finding of findings) {
          for (const found of usage.get(finding.name)?.get(filePath) ?? []) {
            ctx.report({
              evidence: {
                canonical: finding.canonical,
                suggestion: `Use \`${finding.canonical}\` instead of \`${finding.name}\`.`,
              },
              filePath: target.file.path,
              loc: {
                start: { column: 0, line: found.line },
              },
              message: `\`${finding.name}\` duplicates \`${finding.canonical}\` (${finding.purpose}). \`${finding.canonical}\` has ${usage.get(finding.canonical)?.size ?? 0} importing files and \`${finding.name}\` has ${usage.get(finding.name)?.size ?? 0}. ${finding.reason}`,
            })
          }
        }
      },
    }
  },
  languages: 'any',
  options: [optionsSchema],
})

/**
 * One line for each package, most imported first, with the directories that import it most.
 *
 * The directories tell the model whether two packages serve different products, for example one
 * in a server and one in a browser app, which the prompt says not to report.
 */
export function formatUsage(cwd: string, usage: PackageUsage): string {
  return [...usage]
    .sort(([, left], [, right]) => right.size - left.size)
    .map(([name, files]) => {
      const directories = new Map<string, number>()
      for (const filePath of files.keys()) {
        const directory = topDirectoryOf(relative(cwd, filePath))
        directories.set(directory, (directories.get(directory) ?? 0) + 1)
      }

      const top = [...directories]
        .sort(([, left], [, right]) => right - left)
        .slice(0, 4)
        .map(([directory, count]) => `${directory} ${count}`)

      return `${name}: ${files.size} files (${top.join(', ')})`
    })
    .join('\n')
}

/**
 * Turns the model's groups into one finding for each package to replace.
 *
 * A group is dropped when it names a package that no file imports, because the model can invent a
 * name, and when an `allow` set covers every member. A preferred member overrides the canonical
 * package that the model chose.
 */
export function resolveGroups(
  groups: { alternatives: { name: string, reason: string }[], canonical: string, purpose: string }[],
  usage: PackageUsage,
  options: { allow: readonly (readonly string[])[], preferred: readonly string[] },
): MixedLibraryFinding[] {
  const findings: MixedLibraryFinding[] = []

  for (const group of groups) {
    const members = [
      group.canonical,
      ...group.alternatives.map(alternative => alternative.name),
    ]
    if (members.some(name => !usage.has(name)))
      continue
    if (options.allow.some(allowed => members.every(name => allowed.includes(name))))
      continue

    const canonical = members.find(name => options.preferred.includes(name)) ?? group.canonical
    const reasons = new Map(group.alternatives.map(alternative => [alternative.name, alternative.reason]))

    for (const name of members) {
      if (name !== canonical) {
        findings.push({
          canonical,
          name,
          purpose: group.purpose,
          reason: reasons.get(name) ?? '',
        })
      }
    }
  }

  return findings
}

/**
 * Collects the external package imports of every source file in the workspace.
 *
 * Packages of the workspace itself are not library choices, so every `package.json` name is left
 * out. Type packages are left out too: `@types/x` always comes with `x`.
 */
async function collectUsage(cwd: string): Promise<PackageUsage> {
  const ignore = [...DEFAULT_IGNORE_PATTERNS]
  const workspacePackages = new Set<string>()
  for (const manifest of await listFiles(cwd, {
    ignore,
    patterns: ['**/package.json'],
  })) {
    const name = await readPackageName(manifest)
    if (name !== undefined)
      workspacePackages.add(name)
  }

  const usage: PackageUsage = new Map()
  const files = await listFiles(cwd, {
    ignore,
    patterns: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue}'],
  })

  for (const filePath of files.sort()) {
    for (const found of extractPackageImports(await readFile(filePath, 'utf8'))) {
      if (workspacePackages.has(found.name) || found.name.startsWith('@types/'))
        continue

      const byFile = usage.get(found.name) ?? new Map<string, PackageImport[]>()
      byFile.set(filePath, [
        ...byFile.get(filePath) ?? [],
        found,
      ])
      usage.set(found.name, byFile)
    }
  }

  return usage
}

async function readPackageName(manifest: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(manifest, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && 'name' in parsed && typeof parsed.name === 'string'
      ? parsed.name
      : undefined
  }
  catch {
    // A broken manifest names no package. The rule reviews imports, not manifests.
    return undefined
  }
}

async function reviewWorkspace(ctx: RuleContext<readonly [MixedLibrariesOptions]>, options: MixedLibrariesOptions): Promise<Review> {
  const usage = await collectUsage(ctx.cwd)
  if (usage.size < 2)
    return { findings: [], usage }

  const { groups } = await generateStructured({
    createMessages: retryFeedback => [
      {
        content: [
          mixedLibrariesPrompt,
          formatOutputLanguageInstruction(ctx.outputLanguage),
        ].filter(Boolean).join('\n\n'),
        role: 'system',
      },
      {
        content: buildMixedLibrariesPrompt(options.preferred, formatUsage(ctx.cwd, usage)),
        role: 'user',
      },
      ...(retryFeedback === undefined
        ? []
        : [
            { content: retryFeedback, role: 'user' as const },
          ]),
    ],
    logger: ctx.logger,
    metering: ctx.metering,
    model: await ctx.model(),
    operation: 'mixed-libraries-judge',
    schema: mixedLibrariesResponseSchema,
    signal: ctx.signal,
  })

  return {
    findings: resolveGroups(groups, usage, options),
    usage,
  }
}

/** `packages/ui/src/a.ts` -> `packages/ui`, `src/a.ts` -> `src`, `a.ts` -> `.` */
function topDirectoryOf(relativePath: string): string {
  const directory = dirname(relativePath)
  return directory === '.'
    ? '.'
    : directory.split(/[\\/]/).slice(0, 2).join('/')
}
