import type { PlannedSourceTarget, ResolvedModel, RuleContext } from '@alint-js/plugin'

import { createHash } from 'node:crypto'

import { createSourceRuntime } from '@alint-js/core'
import { getDescription } from 'valibot'
import { describe, expect, it, vi } from 'vitest'

import {
  createPythonPlugin,
  createPythonSemanticBoundaryMessages,
  createPythonTypedArtifactBoundaryMessages,
  createReportFindingsToolParameters,
  pythonPlugin,
  pythonSemanticBoundaryFindingSchema,
  pythonSemanticBoundaryPrompt,
  pythonSemanticBoundaryResponseSchema,
  pythonTypedArtifactBoundaryFindingSchema,
  pythonTypedArtifactBoundaryPrompt,
  pythonTypedArtifactBoundaryResponseSchema,
  reportPythonSemanticBoundaryFindings,
  reportPythonTypedArtifactBoundaryFindings,
} from './index'

const sourceText = 'class Downloader:\n    async def download(self):\n        pass\n'

const generateStructuredMock = vi.hoisted(() => vi.fn())

vi.mock('@alint-js/core/structured-output', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@alint-js/core/structured-output')>()

  return {
    ...actual,
    generateStructured: generateStructuredMock,
  }
})

function createResolvedModel(): ResolvedModel {
  return {
    aliases: [],
    capabilities: ['tool-call'],
    id: 'model',
    name: 'model',
    params: {},
    provider: {
      endpoint: 'http://localhost:11434/v1',
      headers: {},
      id: 'provider',
      type: 'openai-compatible',
    },
  }
}

function createRuleContext(): RuleContext {
  return {
    cwd: '/repo',
    id: 'python/semantic-boundary',
    localId: 'semantic-boundary',
    logger: {
      debug: () => {},
    },
    metering: {
      recordUsage: () => {},
    },
    model: async () => createResolvedModel(),
    options: [],
    report: () => {},
    settings: {},
    src: createSourceRuntime({
      readFile: async file => ({
        contentHash: createHash('sha256').update(sourceText).digest('hex'),
        language: 'plaintext',
        lines: sourceText.split('\n'),
        path: typeof file === 'string'
          ? file
          : file.path,
        text: sourceText,
      }),
    }),
  }
}

function createSourceTarget<Kind extends PlannedSourceTarget['kind']>(kind: Kind, path = '/repo/processing/media/downloaders/resourceItem.py'): PlannedSourceTarget & { kind: Kind } {
  const file = {
    contentHash: createHash('sha256').update(sourceText).digest('hex'),
    language: 'plaintext',
    path,
  }

  return {
    file,
    identity: `${kind}:demo`,
    kind,
    language: file.language,
  }
}

function getPythonSemanticBoundaryRule() {
  const rule = pythonPlugin.rules?.['semantic-boundary']

  if (!rule) {
    throw new Error('Expected Python plugin to expose semantic-boundary rule')
  }

  return rule
}

function getPythonTypedArtifactBoundaryRule() {
  const rule = pythonPlugin.rules?.['typed-artifact-boundary']

  if (!rule) {
    throw new Error('Expected Python plugin to expose typed-artifact-boundary rule')
  }

  return rule
}

describe('pythonPlugin', () => {
  it('creates the Python semantic-boundary plugin without requiring callers to inject an agent adapter', () => {
    const plugin = createPythonPlugin()

    expect(plugin.rules?.['semantic-boundary']).toBeDefined()
    expect(plugin.rules?.['typed-artifact-boundary']).toBeDefined()
    expect(plugin.configs?.example).toEqual(pythonPlugin.configs?.example)
  })

  it('uses flat plugin shape with a generic Python semantic-boundary config alias', () => {
    expect('scope' in pythonPlugin).toBe(false)
    expect(pythonPlugin.configs?.example).toEqual([
      {
        files: ['**/*.py'],
        language: 'plaintext',
        rules: {
          'python/semantic-boundary': 'warn',
          'python/typed-artifact-boundary': 'warn',
        },
      },
    ])
  })

  it('exposes the semantic-boundary rule through onTargetFile only', () => {
    const handlers = getPythonSemanticBoundaryRule().create(createRuleContext())

    expect(handlers.onTargetFile).toBeTypeOf('function')
    expect('onFile' in handlers).toBe(false)
    expect('onFunction' in handlers).toBe(false)
    expect('onClass' in handlers).toBe(false)
  })

  it('exposes the typed-artifact-boundary rule through onTargetFile only', () => {
    const handlers = getPythonTypedArtifactBoundaryRule().create(createRuleContext())

    expect(handlers.onTargetFile).toBeTypeOf('function')
    expect('onFile' in handlers).toBe(false)
    expect('onFunction' in handlers).toBe(false)
    expect('onClass' in handlers).toBe(false)
  })

  it('ignores non-Python files before requesting a model', async () => {
    const context = createRuleContext()
    let modelRequests = 0
    context.model = async () => {
      modelRequests += 1
      throw new Error('Model should not be requested for non-Python targets')
    }

    await getPythonSemanticBoundaryRule().create(context).onTargetFile?.(createSourceTarget('file', '/repo/service.ts'))

    expect(modelRequests).toBe(0)
  })

  it('reports semantic boundary findings returned by the judge for Python files', async () => {
    const diagnostics: Parameters<RuleContext['report']>[0][] = []
    const context = createRuleContext()
    context.report = diagnostic => diagnostics.push(diagnostic)
    generateStructuredMock.mockResolvedValueOnce({
      findings: [
        {
          category: 'typed-boundary',
          confidence: 'high',
          line: 2,
          message: 'Raw external data crosses into orchestration.',
          relatedDeclarations: [
            {
              line: 3,
              name: 'format_output',
              role: 'format helper on the wrong owner',
            },
          ],
          suggestion: 'Return a typed boundary object from the adapter before orchestration consumes the result.',
        },
      ],
    })

    await getPythonSemanticBoundaryRule().create(context).onTargetFile?.(createSourceTarget('file'))

    expect(generateStructuredMock).toHaveBeenCalledTimes(1)
    expect(diagnostics).toEqual([
      {
        evidence: {
          category: 'typed-boundary',
          confidence: 'high',
          relatedDeclarations: [
            {
              line: 3,
              name: 'format_output',
              role: 'format helper on the wrong owner',
            },
          ],
          suggestion: 'Return a typed boundary object from the adapter before orchestration consumes the result.',
        },
        filePath: '/repo/processing/media/downloaders/resourceItem.py',
        loc: {
          start: {
            column: 0,
            line: 2,
          },
        },
        message: 'Raw external data crosses into orchestration.',
      },
    ])
  })
})

describe('createPythonTypedArtifactBoundaryMessages', () => {
  it('sends Python source code to the artifact-boundary judge with stable line numbers', () => {
    const messages = createPythonTypedArtifactBoundaryMessages('class DownloadResult:\n    pass\n', undefined)

    expect(messages.at(-1)?.content).toContain([
      'Python code with line numbers:',
      '',
      '1 | class DownloadResult:',
      '2 |     pass',
      '3 | ',
    ].join('\n'))
  })

  it('describes typed artifact boundary smells without project-specific trigger terms or textual matching', () => {
    expect(pythonTypedArtifactBoundaryPrompt).toContain('You are reviewing one Python source file.')
    expect(pythonTypedArtifactBoundaryPrompt).toContain('typed artifact boundary')
    expect(pythonTypedArtifactBoundaryPrompt).toContain('list[dict]')
    expect(pythonTypedArtifactBoundaryPrompt).toContain('manual dictionary serialization')
    expect(pythonTypedArtifactBoundaryPrompt).toContain('Convert to dictionaries only at the outer serialization boundary')
    expect(pythonTypedArtifactBoundaryPrompt).toContain('When a nested item and its aggregate result leak the same artifact protocol')
    expect(pythonTypedArtifactBoundaryPrompt).toContain('Point the finding line at the aggregate result class')
    expect(pythonTypedArtifactBoundaryPrompt).toContain('Do not report plain dictionaries that are confined to a serializer')
    expect(pythonTypedArtifactBoundaryPrompt).toContain('Do not use textual pattern matching as the basis of the decision')
    expect(pythonTypedArtifactBoundaryPrompt).not.toContain(['Bili', 'bili'].join(''))
    expect(pythonTypedArtifactBoundaryPrompt).not.toContain(['sub', 'title'].join(''))
    expect(pythonTypedArtifactBoundaryPrompt).not.toContain(['dan', 'maku'].join(''))
    expect(pythonTypedArtifactBoundaryPrompt).not.toContain(['sr', 't'].join(''))
    expect(pythonTypedArtifactBoundaryPrompt).not.toContain(['reg', 'exp'].join(''))
    expect(pythonTypedArtifactBoundaryPrompt).not.toContain(['reg', 'ex'].join(''))
  })

  it('stores typed artifact output requirements in schema descriptions', () => {
    expect(getDescription(pythonTypedArtifactBoundaryResponseSchema.entries.findings)).toContain('Python typed artifact boundary')
    expect(getDescription(pythonTypedArtifactBoundaryFindingSchema.pipe[0].entries.line)).toContain('left-column line number')
    expect(getDescription(pythonTypedArtifactBoundaryFindingSchema.pipe[0].entries.category)).toContain('typed-artifact-boundary')
    expect(getDescription(pythonTypedArtifactBoundaryFindingSchema.pipe[0].entries.suggestion)).toContain('design direction')
  })
})

describe('createPythonSemanticBoundaryMessages', () => {
  it('sends Python source code to the judge with stable line numbers', () => {
    const messages = createPythonSemanticBoundaryMessages('class Downloader:\n    pass\n', undefined)

    expect(messages.at(-1)?.content).toContain([
      'Python code with line numbers:',
      '',
      '1 | class Downloader:',
      '2 |     pass',
      '3 | ',
    ].join('\n'))
  })

  it('includes output language instructions when provided', () => {
    const messages = createPythonSemanticBoundaryMessages('class Downloader:\n    pass\n', undefined, 'Japanese')

    expect(messages.at(-1)?.content).toContain('Write all human-readable finding messages and suggestions in this language: Japanese.')
  })

  it('describes semantic boundary smells without project-specific trigger terms or textual matching', () => {
    expect(pythonSemanticBoundaryPrompt).toContain('You are reviewing one Python source file.')
    expect(pythonSemanticBoundaryPrompt).toContain('typed boundary')
    expect(pythonSemanticBoundaryPrompt).toContain('domain object')
    expect(pythonSemanticBoundaryPrompt).toContain('format serialization')
    expect(pythonSemanticBoundaryPrompt).toContain('raw external data')
    expect(pythonSemanticBoundaryPrompt).toContain('Report boundary leaks separately from ordinary parsing bugs')
    expect(pythonSemanticBoundaryPrompt).toContain('Do not treat example names, domains, packages, protocols, or technologies as trigger terms')
    expect(pythonSemanticBoundaryPrompt).toContain('Do not use textual pattern matching as the basis of the decision')
    expect(pythonSemanticBoundaryPrompt).toContain('the same smell should be found when classes, functions, fields, and modules are renamed')
    expect(pythonSemanticBoundaryPrompt).toContain('Do not report a focused adapter merely because it normalizes external input at the edge')
    expect(pythonSemanticBoundaryPrompt).toContain('Do not report small helpers when they serve one cohesive local abstraction')
    expect(pythonSemanticBoundaryPrompt).toContain('Do not report parsing or rendering ownership merely because an orchestrator calls a value object method')
    expect(pythonSemanticBoundaryPrompt).toContain('when the reviewed source shows parsing and presentation behavior already live on a cohesive domain object')
    expect(pythonSemanticBoundaryPrompt).toContain('Do not report a persistence writer merely because it calls a cohesive value object render method')
    expect(pythonSemanticBoundaryPrompt).not.toContain(['Bili', 'bili'].join(''))
    expect(pythonSemanticBoundaryPrompt).not.toContain(['sub', 'title'].join(''))
    expect(pythonSemanticBoundaryPrompt).not.toContain(['dan', 'maku'].join(''))
    expect(pythonSemanticBoundaryPrompt).not.toContain(['sr', 't'].join(''))
    expect(pythonSemanticBoundaryPrompt).not.toContain(['reg', 'exp'].join(''))
    expect(pythonSemanticBoundaryPrompt).not.toContain(['reg', 'ex'].join(''))
  })

  it('stores finding output requirements in schema descriptions', () => {
    expect(getDescription(pythonSemanticBoundaryResponseSchema.entries.findings)).toContain('Python semantic boundary')
    expect(getDescription(pythonSemanticBoundaryFindingSchema.pipe[0].entries.line)).toContain('left-column line number')
    expect(getDescription(pythonSemanticBoundaryFindingSchema.pipe[0].entries.category)).toContain('semantic-boundary')
    expect(getDescription(pythonSemanticBoundaryFindingSchema.pipe[0].entries.relatedDeclarations.wrapped)).toContain('same cohesive issue cluster')
    expect(getDescription(pythonSemanticBoundaryFindingSchema.pipe[0].entries.suggestion)).toContain('design direction')
  })

  it('normalizes nested tool object schemas for strict function calling', () => {
    const parameters = createReportFindingsToolParameters()
    const findings = parameters.properties?.findings

    expect(parameters.additionalProperties).toBe(false)
    expect(typeof findings).toBe('object')

    if (typeof findings === 'object' && !Array.isArray(findings.items) && typeof findings.items === 'object') {
      expect(findings.items.additionalProperties).toBe(false)
      expect(findings.items.required).toEqual([
        'category',
        'confidence',
        'line',
        'message',
        'relatedDeclarations',
        'suggestion',
      ])
    }
    else {
      throw new TypeError('Expected findings.items to be an object schema')
    }
  })
})

describe('reportPythonSemanticBoundaryFindings', () => {
  it('maps semantic boundary findings into diagnostics with design evidence', () => {
    const diagnostics: Parameters<RuleContext['report']>[0][] = []
    const context = createRuleContext()
    context.report = diagnostic => diagnostics.push(diagnostic)

    reportPythonSemanticBoundaryFindings(context, '/repo/processing/media/downloaders/resourceItem.py', [
      {
        category: 'typed-boundary',
        confidence: 'high',
        line: 18,
        message: 'External response shapes leak through the downloader boundary.',
        suggestion: 'Normalize external entries into a small domain object at the provider boundary before orchestration consumes them.',
      },
    ])

    expect(diagnostics).toEqual([
      {
        evidence: {
          category: 'typed-boundary',
          confidence: 'high',
          suggestion: 'Normalize external entries into a small domain object at the provider boundary before orchestration consumes them.',
        },
        filePath: '/repo/processing/media/downloaders/resourceItem.py',
        loc: {
          start: {
            column: 0,
            line: 18,
          },
        },
        message: 'External response shapes leak through the downloader boundary.',
      },
    ])
  })

  it('preserves related declarations for cohesive misplaced-model clusters', () => {
    const diagnostics: Parameters<RuleContext['report']>[0][] = []
    const context = createRuleContext()
    context.report = diagnostic => diagnostics.push(diagnostic)

    reportPythonSemanticBoundaryFindings(context, '/repo/processing/media/downloaders/resourceItem.py', [
      {
        category: 'domain-model',
        confidence: 'medium',
        line: 44,
        message: 'Parsing, formatting, and orchestration are missing a domain owner.',
        relatedDeclarations: [
          {
            line: 79,
            name: '_to_output_format',
            role: 'format serialization helper',
          },
          {
            line: 93,
            name: '_coerce_time',
            role: 'raw value coercion helper',
          },
        ],
        suggestion: 'Move parsing and formatting into a value object and leave the downloader with selection and persistence flow.',
      },
    ])

    expect(diagnostics[0]?.evidence).toEqual({
      category: 'domain-model',
      confidence: 'medium',
      relatedDeclarations: [
        {
          line: 79,
          name: '_to_output_format',
          role: 'format serialization helper',
        },
        {
          line: 93,
          name: '_coerce_time',
          role: 'raw value coercion helper',
        },
      ],
      suggestion: 'Move parsing and formatting into a value object and leave the downloader with selection and persistence flow.',
    })
  })
})

describe('reportPythonTypedArtifactBoundaryFindings', () => {
  it('maps typed artifact boundary findings into diagnostics with design evidence', () => {
    const diagnostics: Parameters<RuleContext['report']>[0][] = []
    const context = createRuleContext()
    context.report = diagnostic => diagnostics.push(diagnostic)

    reportPythonTypedArtifactBoundaryFindings(context, '/repo/processing/media/downloaders/resourceItem.py', [
      {
        category: 'typed-artifact-boundary',
        confidence: 'high',
        line: 44,
        message: 'A typed result still exposes raw resource dictionaries.',
        relatedDeclarations: [],
        suggestion: 'Introduce a typed artifact value and convert it to a dictionary only at the API serialization edge.',
      },
    ])

    expect(diagnostics).toEqual([
      {
        evidence: {
          category: 'typed-artifact-boundary',
          confidence: 'high',
          relatedDeclarations: [],
          suggestion: 'Introduce a typed artifact value and convert it to a dictionary only at the API serialization edge.',
        },
        filePath: '/repo/processing/media/downloaders/resourceItem.py',
        loc: {
          start: {
            column: 0,
            line: 44,
          },
        },
        message: 'A typed result still exposes raw resource dictionaries.',
      },
    ])
  })
})
