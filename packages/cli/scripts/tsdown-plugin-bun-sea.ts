import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { cwd } from 'node:process'
import { fileURLToPath } from 'node:url'

import { findWorkspaceDir } from '@pnpm/find-workspace-dir'
import { getPackageInfo, resolveModule } from 'local-pkg'
import { findDynamicImports, findStaticImports, parseStaticImport } from 'mlly'
import { relative } from 'pathe'
import { x } from 'tinyexec'

export interface BuildBunExecutableOptions {
  bunTarget: string
  outfile: string
  oxcBinding: string
  target: string
}

export async function pluginBunSea(options: BuildBunExecutableOptions): Promise<void> {
  const workspaceRoot = (await findWorkspaceDir(cwd()))!
  const oxcPackage = await getPackageInfo('oxc-parser', {
    paths: [
      join(workspaceRoot, 'packages/core'),
    ],
  })
  if (!oxcPackage) {
    throw new Error('Could not find oxc-parser package.')
  }

  const oxcBindingPackage = await getPackageInfo(`@oxc-parser/binding-${options.oxcBinding}`, {
    paths: [oxcPackage.rootPath],
  })
  if (!oxcBindingPackage) {
    throw new Error(`Could not find @oxc-parser/binding-${options.oxcBinding} package.`)
  }

  const bindingPath = resolveModule(`@oxc-parser/binding-${options.oxcBinding}`, {
    paths: [oxcPackage.rootPath],
  })
  if (!bindingPath) {
    throw new Error(`Could not resolve @oxc-parser/binding-${options.oxcBinding} from oxc-parser.`)
  }

  // NOTICE: on macOS, tmpdir() usually points to /var/folders/..., while when bun is bundling, /private/var/folders/... is resolved.
  // Therefore if we use tmpdir() as the temp root, bun will fail to find the generated entry file.
  // To avoid this, we use a temp root under the workspace root instead.
  const tempRoot = join(workspaceRoot, '.tmp')
  await mkdir(tempRoot, { recursive: true })

  const tempDir = await mkdtemp(join(tempRoot, `alint-bun-${options.target}-`))
  const entryPath = join(tempDir, 'entry.ts')
  const cliEntryPath = join(workspaceRoot, 'packages/cli/src/cli/index.ts')
  const templatePath = fileURLToPath(new URL('./bin.template.ts', import.meta.url))

  try {
    // NOTICE: `oxc-parser` loads its NAPI-RS binding while alint core is
    // imported. Bun only embeds `.node` files into standalone executables when
    // the binding file is a direct static import, so the generated bootstrap
    // must import the platform binding file before importing the CLI entry.
    await writeFile(entryPath, rewriteBootstrapImports(await readFile(templatePath, 'utf8'), {
      __ALINT_CLI_ENTRY__: relative(tempDir, cliEntryPath),
      __ALINT_OXC_BINDING__: relative(tempDir, bindingPath),
    }))

    await mkdir(dirname(options.outfile), { recursive: true })

    await x('bun', [
      'build',
      '--compile',
      `--target=${options.bunTarget}`,
      entryPath,
      '--outfile',
      options.outfile,
    ], {
      nodeOptions: { stdio: 'inherit' },
      throwOnError: true,
    })
  }
  finally {
    await rm(tempDir, { force: true, recursive: true })
  }
}

function parseDynamicImportSpecifier(expression: string): string | undefined {
  const quote = expression[0]

  if ((quote !== '\'' && quote !== '"' && quote !== '`') || expression.at(-1) !== quote) {
    return undefined
  }

  return expression.slice(1, -1)
}

function replaceImportSpecifier(code: string, specifier: string, replacement: string): string {
  for (const quote of ['\'', '"', '`']) {
    const quoted = `${quote}${specifier}${quote}`

    if (code.includes(quoted)) {
      return code.replace(quoted, `${quote}${replacement}${quote}`)
    }
  }

  throw new Error(`Could not replace import specifier ${specifier}.`)
}

function rewriteBootstrapImports(code: string, replacements: Record<string, string>): string {
  let rewritten = code
  const pending = new Set(Object.keys(replacements))
  const imports = [
    ...findStaticImports(code).map(matched => ({
      code: matched.code,
      end: matched.end,
      specifier: parseStaticImport(matched).specifier,
      start: matched.start,
    })),
    ...findDynamicImports(code).map(matched => ({
      code: matched.code,
      end: matched.end,
      specifier: parseDynamicImportSpecifier(matched.expression),
      start: matched.start,
    })),
  ].sort((left, right) => right.start - left.start)

  for (const matched of imports) {
    if (!matched.specifier) {
      continue
    }

    const replacement = replacements[matched.specifier]
    if (!replacement) {
      continue
    }

    rewritten = `${rewritten.slice(0, matched.start)}${replaceImportSpecifier(matched.code, matched.specifier, replacement)}${rewritten.slice(matched.end)}`
    pending.delete(matched.specifier)
  }

  if (pending.size > 0) {
    throw new Error(`Could not find bootstrap import placeholder: ${[...pending].join(', ')}`)
  }

  return rewritten
}
