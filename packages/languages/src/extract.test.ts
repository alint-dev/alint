import type { CallSite, FunctionInfo, LanguageContext, LanguageDefinition, SourceTarget } from '@alint-js/core'

import { createSourceFile, createSourceRuntime } from '@alint-js/core'
import { describe, expect, it } from 'vitest'

import { extractTargets } from './extract'
import { goLanguage, pythonLanguage, rustLanguage } from './index'

// Nothing in this package reads the context, but `LanguageDefinition.extract` is handed one, and a
// test is worth more when it calls the real signature.
const context: LanguageContext = {
  cwd: '/repo',
  languageOptions: {},
  src: createSourceRuntime(),
}

describe('the file target', () => {
  it('comes first, holds the whole file, and carries every call', async () => {
    const source = [
      'func total(entries []Entry) int {',
      '\treturn len(entries)',
      '}',
      '',
      'var size = total(all())',
    ].join('\n')

    const targets = await targetsOf(goLanguage, '/repo/size.go', source)

    expect(targets[0].kind).toBe('file')
    expect(targets[0].identity).toBe('file')
    expect(targets[0].language).toBe('go')
    expect(targets[0].text).toBe(source)
    expect(targets[0].origin?.physicalPath).toBe('/repo/size.go')

    // `total(all())` sits outside every function and still counts. Anything measuring how often a
    // name is used needs the uses, not only the definitions.
    expect(callsOf(targets[0]).map(call => call.name)).toStrictEqual(['len', 'total', 'all'])
  })
})

describe('go', () => {
  it('reports a function target with its position, text and declared names', async () => {
    const source = [
      'func isMissing(err error) bool {',
      '\treturn errors.Is(err, fs.ErrNotExist)',
      '}',
    ].join('\n')

    const targets = await targetsOf(goLanguage, '/repo/fs.go', source)
    const [isMissing] = functionsOf(targets)

    expect(isMissing.name).toBe('isMissing')
    expect(isMissing.language).toBe('go')
    expect(isMissing.loc?.start.line).toBe(1)
    expect(isMissing.loc?.end.line).toBe(3)
    expect(source.slice(isMissing.range?.start, isMissing.range?.end)).toBe(isMissing.text)

    const info = infoOf(isMissing)
    expect(info.declaredNames).toContain('isMissing')
    expect(info.declaredNames).toContain('err')
    // A function does not declare the packages it calls into, so `errors` is not one of its names.
    expect(info.declaredNames).not.toContain('errors')
  })

  it('reads a capital as exported, and reports it on the target as well as the info', async () => {
    const source = 'func Total(n int) int {\n\treturn n\n}\n\nfunc total(n int) int {\n\treturn n\n}'

    const [exported, unexported] = functionsOf(await targetsOf(goLanguage, '/repo/n.go', source))

    expect(infoOf(exported).exported).toBe(true)
    expect(exported.metadata?.exported).toBe(true)
    expect(infoOf(unexported).exported).toBe(false)
    expect(unexported.metadata?.exported).toBe(false)
  })
})

describe('rust', () => {
  it('rebases comment and identifier ranges onto the target\'s own text', async () => {
    const source = [
      'fn walk_files(root: &Path) -> Vec<PathBuf> {',
      '    // read the directory',
      '    let entries = read_dir(root);',
      '    entries.collect()',
      '}',
    ].join('\n')

    const targets = await targetsOf(rustLanguage, '/repo/walk.rs', source)
    const [walkFiles] = functionsOf(targets)
    const info = infoOf(walkFiles)

    expect(info.commentRanges).toHaveLength(1)
    const [comment] = info.commentRanges
    expect(walkFiles.text.slice(comment.start, comment.end)).toBe('// read the directory')

    const identifiers = info.identifierRanges.map(range => walkFiles.text.slice(range.start, range.end))
    expect(identifiers).toContain('walk_files')
    expect(identifiers).toContain('entries')
    expect(identifiers).toContain('read_dir')
    // A type name refers outwards rather than being declared here, so it is never renameable.
    expect(identifiers).not.toContain('PathBuf')

    // `read_dir` is a plain call and `collect` a method call. Both are calls.
    expect(callsOf(targets[0]).map(call => call.name)).toStrictEqual(['read_dir', 'collect'])
  })

  it('reads `pub` as exported', async () => {
    const source = 'pub fn open() {}\n\nfn close() {}'

    const [open, close] = functionsOf(await targetsOf(rustLanguage, '/repo/io.rs', source))

    expect(infoOf(open).exported).toBe(true)
    expect(infoOf(close).exported).toBe(false)
  })
})

describe('python', () => {
  // Python is why `@anchor` exists at all: it writes the `name` in `self.name` as a plain
  // `identifier`, so without anchoring, a parameter called `name` would pull the attribute in too.
  it('never treats an attribute as renameable', async () => {
    const source = 'def read(name):\n    return self.name + name'

    const [read] = functionsOf(await targetsOf(pythonLanguage, '/repo/io.py', source))
    const identifiers = infoOf(read).identifierRanges.map(range => read.text.slice(range.start, range.end))

    // The parameter and its use, but not the attribute `name` in `self.name`.
    expect(identifiers.filter(text => text === 'name')).toHaveLength(2)
    expect(identifiers).toContain('read')
    expect(identifiers).toContain('self')
  })

  it('reads a leading underscore as unexported', async () => {
    const source = 'def read():\n    return 1\n\ndef _read():\n    return 1'

    const [read, hidden] = functionsOf(await targetsOf(pythonLanguage, '/repo/io.py', source))

    expect(infoOf(read).exported).toBe(true)
    expect(infoOf(hidden).exported).toBe(false)
  })

  // A docstring is a string statement, so a grammar counts it as code. Treated that way it would
  // inflate the statement count and make rewording a docstring look like a change to the body.
  it('counts a docstring as documentation rather than a statement', async () => {
    const source = 'def f(e):\n    """Return the length."""\n    return len(e.name)'

    const [f] = functionsOf(await targetsOf(pythonLanguage, '/repo/f.py', source))

    expect(infoOf(f).bodyStatements).toBe(1)
    expect(infoOf(f).commentRanges).toHaveLength(1)
  })

  it('still treats a string that is not the first statement as code', async () => {
    const source = 'def f(e):\n    x = "not a docstring"\n    return x'

    const [f] = functionsOf(await targetsOf(pythonLanguage, '/repo/f.py', source))

    expect(infoOf(f).bodyStatements).toBe(2)
  })
})

// All three grammars make a comment a named child of its block. Counting one would take a one-line
// function to two statements, and hide it from any rule looking for trivial functions.
describe('a comment is not a statement', () => {
  it.each([
    [
      goLanguage,
      'f.go',
      'func f(e E) int {\n\treturn len(e.Name)\n}',
      'func f(e E) int {\n\t// why\n\treturn len(e.Name)\n}',
    ],
    [
      rustLanguage,
      'f.rs',
      'fn f(e: &E) -> usize {\n    e.name.len()\n}',
      'fn f(e: &E) -> usize {\n    // why\n    e.name.len()\n}',
    ],
    [
      pythonLanguage,
      'f.py',
      'def f(e):\n    return len(e.name)',
      'def f(e):\n    # why\n    return len(e.name)',
    ],
  ] as const)('does not count a comment in a $0.name body', async (language, path, plain, commented) => {
    const [bare] = functionsOf(await targetsOf(language, `/repo/${path}`, plain))
    const [documented] = functionsOf(await targetsOf(language, `/repo/${path}`, commented))

    expect(infoOf(bare).bodyStatements).toBe(1)
    expect(infoOf(bare).bodyIsSingleExpression).toBe(true)
    expect(infoOf(documented).bodyStatements).toBe(1)
    expect(infoOf(documented).bodyIsSingleExpression).toBe(true)
  })

  it('reads a body holding a branch as more than one expression', async () => {
    const source = 'fn f(n: u8) -> u8 {\n    if n > 0 {\n        return n;\n    }\n    0\n}'

    const [f] = functionsOf(await targetsOf(rustLanguage, '/repo/f.rs', source))

    expect(infoOf(f).bodyStatements).toBe(2)
    expect(infoOf(f).bodyIsSingleExpression).toBe(false)
  })
})

describe('identities', () => {
  it('names a function that is alone under that name, and falls back to its position when it is not', async () => {
    // Two `impl` blocks may each declare `get`, which is valid Rust. `size` is alone in its name.
    const source = [
      'struct A;',
      'struct B;',
      'impl A { fn get(&self) -> u8 { 1 } }',
      'impl B { fn get(&self) -> u8 { 2 } }',
      'fn size() -> u8 { 3 }',
    ].join('\n')

    const identities = functionsOf(await targetsOf(rustLanguage, '/repo/a.rs', source)).map(target => target.identity)

    expect(identities).toContain('function:size')
    expect(identities.filter(identity => identity.startsWith('function:get:'))).toHaveLength(2)
    expect(identities).not.toContain('function:get')
  })
})

describe('the language a target reports', () => {
  it('is the one the definition provides, not the one the file was read as', async () => {
    // `createSourceFile` infers from the extension and knows nothing about Go. Drop the
    // `withLanguage` call in the definition above and every target reports `unknown`, which then
    // matches no rule scoped to `go`.
    const file = createSourceFile('/repo/fs.go', 'func f() {}')
    expect(file.language).toBe('unknown')

    const targets = await goLanguage.extract(file, context)

    expect(targets.every(target => target.language === 'go')).toBe(true)
  })

  it('is rejected outright when this pack does not provide it', async () => {
    const file = createSourceFile('/repo/app.ts', 'const f = () => {}')

    await expect(extractTargets(file)).rejects.toThrow('Language "typescript" is not provided by @alint-js/languages.')
  })
})

function callsOf(target: SourceTarget): readonly CallSite[] {
  const calls = target.metadata?.calls

  if (!Array.isArray(calls)) {
    throw new TypeError(`Target "${target.identity}" carries no calls.`)
  }

  return calls as readonly CallSite[]
}

function functionsOf(targets: readonly SourceTarget[]): SourceTarget[] {
  return targets.filter(target => target.kind === 'function')
}

/** TypeScript knows `metadata` holds JSON values, not that `function` holds a `FunctionInfo`. */
function infoOf(target: SourceTarget): FunctionInfo {
  const info = target.metadata?.function

  if (info === undefined) {
    throw new TypeError(`Target "${target.identity}" carries no function info.`)
  }

  return info as FunctionInfo
}

async function targetsOf(language: LanguageDefinition, path: string, text: string): Promise<SourceTarget[]> {
  return language.extract(createSourceFile(path, text), context)
}
