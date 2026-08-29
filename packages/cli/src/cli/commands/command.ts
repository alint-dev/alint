import type { Cli, CliIo, CliWritable } from '../types'

import { escapeLineValue } from '../output'

export type CommandAction = (
  context: CommandContext,
  ...args: any[]
) => number | Promise<number>

export interface CommandContext {
  globalOptions: {
    outputLanguage?: string
  }
  interceptConsoleOutput: (stdout: CliWritable) => () => void
  io: CliIo
  setupNoInteractive: boolean
  signal?: AbortSignal
}

export interface CommandHelp {
  examples?: readonly string[]
  help?: string
}

export interface CommandNode extends CommandHelp {
  action?: CommandAction
  alias?: readonly string[]
  allowUnknownOptions?: boolean
  arguments?: string
  children?: readonly CommandNode[]
  default?: boolean
  description: string
  exactArguments?: boolean
  name: string
  options?: readonly CommandOption[]
}

export interface CommandOption {
  config?: {
    default?: unknown
    type?: unknown[]
  }
  description: string
  flags: string
}

export function defineCommand(node: CommandNode): CommandNode {
  return node
}

export function registerCommandTree(
  cli: Cli,
  nodes: readonly CommandNode[],
  context: CommandContext,
  setPendingResult: (result: Promise<number>) => Promise<number>,
  help: CommandHelp = {},
): void {
  for (const node of nodes) {
    registerRootCommand(cli, node, context, setPendingResult)
  }

  cli.globalCommand.helpCallback = sections =>
    formatCommandHelp(sections, nodes, cli.rawArgs, help)
}

function collectCommandOptions(node: CommandNode): CommandOption[] {
  const options = new Map<string, CommandOption>()

  for (const option of node.options ?? []) {
    options.set(option.flags, option)
  }

  for (const child of node.children ?? []) {
    for (const option of collectCommandOptions(child)) {
      options.set(option.flags, option)
    }
  }

  return [...options.values()]
}

function commandPattern(node: CommandNode): string {
  if (node.default) {
    return node.arguments ?? node.name
  }

  return [node.name, node.children ? '[...args]' : node.arguments]
    .filter(Boolean)
    .join(' ')
}

function dispatchCommand(
  context: CommandContext,
  node: CommandNode,
  args: readonly string[],
  options: unknown,
  path: readonly string[],
): Promise<number> {
  const [subcommand, ...restArgs] = args
  const child = node.children?.find(item =>
    item.name === subcommand || item.alias?.includes(subcommand ?? ''),
  )

  if (child) {
    return dispatchCommand(context, child, restArgs, options, [...path, child.name])
  }

  if (subcommand === undefined && node.children?.length && !node.action) {
    return Promise.resolve(reportMissingSubcommand(context, path, node.children))
  }

  if (!node.action) {
    return Promise.resolve(reportUnknownCommand(context, path, args))
  }

  if (node.exactArguments === true) {
    const expectedArgumentCount = node.arguments?.split(/\s+/u).filter(Boolean).length ?? 0
    const unexpectedArgument = args[expectedArgumentCount]

    if (unexpectedArgument !== undefined) {
      context.io.stderr.write(
        `unexpected argument "${escapeLineValue(unexpectedArgument)}". usage: alint ${formatUsagePattern(path, node)}.\n`,
      )
      return Promise.resolve(2)
    }
  }

  return Promise.resolve(node.action(context, ...parseCommandArguments(node, args), options))
}

function formatChildCommandHelp(
  parentPath: readonly string[],
  child: CommandNode,
): { description: string, pattern: string } {
  const parts = [...parentPath, child.name]

  if (!child.children && child.arguments) {
    parts.push(child.arguments)
  }

  return {
    description: child.description,
    pattern: parts.join(' '),
  }
}

function formatCommandHelp(
  sections: Array<{ body: string, title?: string }>,
  nodes: readonly CommandNode[],
  argv: readonly string[],
  rootHelp: CommandHelp,
): Array<{ body: string, title?: string }> {
  const helpPath = resolveHelpPath(nodes, argv)
  const node = helpPath.at(-1)?.node

  if (!node) {
    return insertExamplesSection(insertHelpSection(sections, rootHelp), rootHelp)
  }

  const path = helpPath.map(item => item.node.name)
  const normalizedSections = rewriteUsageSection(
    insertExamplesSection(
      insertHelpSection(sections.filter(section => section.title !== 'Options'), node),
      node,
    ),
    path,
    node,
  )

  if (!node.children) {
    const optionSection = formatOptionsSection(node.options ?? [])

    return optionSection
      ? [...normalizedSections, optionSection]
      : normalizedSections
  }

  const children = node.children ?? []
  const commands = children.map(child => formatChildCommandHelp(path, child))
  const longestCommand = Math.max(...commands.map(command => command.pattern.length))
  const commandSection = {
    body: commands
      .map(command => `  ${command.pattern.padEnd(longestCommand)}  ${command.description}`)
      .join('\n'),
    title: 'Commands',
  }

  const optionSection = formatOptionsSection(node.options ?? [])
  const usageIndex = normalizedSections.findIndex(section => section.title === 'Usage')
  const withCommands = usageIndex === -1
    ? [commandSection, ...normalizedSections]
    : [
        ...normalizedSections.slice(0, usageIndex + 1),
        commandSection,
        ...normalizedSections.slice(usageIndex + 1),
      ]

  return optionSection ? [...withCommands, optionSection] : withCommands
}

function formatExamples(examples: readonly string[]): string {
  return examples
    .map(example => example.split('\n').map(line => `  ${line}`).join('\n'))
    .join('\n\n')
}

function formatOptionDescription(option: CommandOption): string {
  if (option.config?.default === undefined) {
    return option.description
  }

  return `${option.description} (default: ${option.config.default})`
}

function formatOptionsSection(options: readonly CommandOption[]): undefined | { body: string, title: string } {
  if (options.length === 0) {
    return undefined
  }

  const rows = options.map(option => ({
    description: formatOptionDescription(option),
    flags: option.flags,
  }))
  const longestFlag = Math.max(...rows.map(row => row.flags.length))

  return {
    body: rows
      .map(row => `  ${row.flags.padEnd(longestFlag)}  ${row.description}`)
      .join('\n'),
    title: 'Options',
  }
}

function formatUnknownCommand(path: readonly string[], args: readonly string[]): string {
  return [...path, ...args].filter(Boolean).join(' ')
}

function formatUsagePattern(path: readonly string[], node: CommandNode): string {
  const parts = [...path]

  if (!node.children && node.arguments) {
    parts.push(node.arguments)
  }

  return parts.join(' ')
}

function insertExamplesSection(
  sections: Array<{ body: string, title?: string }>,
  node: CommandHelp,
): Array<{ body: string, title?: string }> {
  if (!node.examples?.length) {
    return sections
  }

  const usageIndex = sections.findIndex(section => section.title === 'Usage')
  const examplesSection = {
    body: formatExamples(node.examples),
    title: 'Examples',
  }

  if (usageIndex === -1) {
    return [...sections, examplesSection]
  }

  return [
    ...sections.slice(0, usageIndex),
    examplesSection,
    ...sections.slice(usageIndex),
  ]
}

function insertHelpSection(
  sections: Array<{ body: string, title?: string }>,
  node: CommandHelp & { description?: string },
): Array<{ body: string, title?: string }> {
  const help = node.help ?? node.description

  if (!help) {
    return sections
  }

  const usageIndex = sections.findIndex(section => section.title === 'Usage')
  const helpSection = { body: help }

  if (usageIndex === -1) {
    return [...sections, helpSection]
  }

  return [
    ...sections.slice(0, usageIndex),
    helpSection,
    ...sections.slice(usageIndex),
  ]
}

function parseCommandArguments(node: CommandNode, args: readonly string[]): unknown[] {
  if (!node.arguments) {
    return []
  }

  const parts = node.arguments.split(/\s+/u).filter(Boolean)
  const values: unknown[] = []
  let argIndex = 0

  for (const part of parts) {
    if (part.startsWith('[...') || part.startsWith('<...')) {
      values.push(args.slice(argIndex))
      argIndex = args.length
      continue
    }

    if (part.startsWith('<') && argIndex >= args.length) {
      throw new Error(`Missing required argument ${part}.`)
    }

    values.push(args[argIndex])
    argIndex += 1
  }

  return values
}

function registerRootCommand(
  cli: Cli,
  node: CommandNode,
  context: CommandContext,
  setPendingResult: (result: Promise<number>) => Promise<number>,
): void {
  const command = cli.command(commandPattern(node), node.description)

  if (node.allowUnknownOptions || node.children) {
    command.allowUnknownOptions()
  }

  for (const alias of node.alias ?? []) {
    command.alias(alias)
  }

  for (const option of collectCommandOptions(node)) {
    command.option(option.flags, option.description, option.config)
  }

  command.action((...args: unknown[]) => {
    const options = args.at(-1)
    const result = node.children
      ? dispatchCommand(context, node, (args[0] as string[] | undefined) ?? [], options, [node.name])
      : Promise.resolve(node.action?.(context, ...args.slice(0, -1), options) ?? 0)

    return setPendingResult(result)
  })
}

function reportMissingSubcommand(
  context: CommandContext,
  path: readonly string[],
  children: readonly CommandNode[],
): number {
  const command = path.join(' ')

  context.io.stderr.write([
    `missing subcommand for "${command}"`,
    '',
    'available subcommands:',
    ...children.map(child => `  ${child.name}`),
    '',
    `run \`alint ${command} --help\` for more information`,
    '',
  ].join('\n'))
  return 2
}

function reportUnknownCommand(
  context: CommandContext,
  path: readonly string[],
  args: readonly string[],
): number {
  context.io.stderr.write(`unknown command: ${formatUnknownCommand(path, args)}\n`)
  return 2
}

function resolveHelpPath(
  nodes: readonly CommandNode[],
  argv: readonly string[],
): Array<{ node: CommandNode }> {
  const path: Array<{ node: CommandNode }> = []
  let currentNodes = nodes
  let skipNext = false

  for (const arg of argv.slice(2)) {
    if (skipNext) {
      skipNext = false
      continue
    }

    if (arg.startsWith('-')) {
      skipNext = shouldSkipOptionValue(arg)
      continue
    }

    const node = currentNodes.find(item =>
      item.name === arg || item.alias?.includes(arg),
    )

    if (!node) {
      break
    }

    path.push({ node })
    currentNodes = node.children ?? []
  }

  return path
}

function rewriteUsageSection(
  sections: Array<{ body: string, title?: string }>,
  path: readonly string[],
  node: CommandNode,
): Array<{ body: string, title?: string }> {
  return sections.map(section =>
    section.title === 'Usage'
      ? { ...section, body: `  $ alint ${formatUsagePattern(path, node)}` }
      : section,
  )
}

function shouldSkipOptionValue(arg: string): boolean {
  if (arg.includes('=')) {
    return false
  }

  return [
    '--by',
    '--cache-location',
    '--config',
    '--cwd',
    '--format',
    '--interval',
    '--metric',
    '--model',
    '--provider',
    '--provider-endpoint',
    '--provider-header',
    '--provider-id',
    '--provider-model',
    '--rule',
    '--rule-concurrency',
    '--since',
    '--timeout-ms',
    '--with-speed-concurrency',
    '-c',
    '-f',
    '-l',
  ].includes(arg)
}
