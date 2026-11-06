import { dirname, isAbsolute, normalize, posix, resolve, sep, win32 } from 'node:path'

export interface DirectoryPluginSpecifier {
  directory: string
  raw: string
  type: 'directory'
}

export type ParsedPluginSpecifier = DirectoryPluginSpecifier | RegistryPluginSpecifier

export interface ParsePluginSpecifierOptions {
  configFile?: string
}

export interface RegistryPluginSpecifier {
  name: string
  raw: string
  registryPath: string
  segments: string[]
  type: 'registry'
  version: string
}

const explicitRelativePathPattern = /^\.{1,2}(?:[\\/]|$)/u

export function getPluginSpecifierKey(specifier: ParsedPluginSpecifier): string {
  return specifier.type === 'registry'
    ? `registry:${specifier.raw}`
    : `directory:${normalizeDirectoryIdentity(specifier.directory)}`
}

export function isDirectoryPluginSpecifier(value: string): boolean {
  return isAbsolute(value)
    || win32.isAbsolute(value)
    || explicitRelativePathPattern.test(value)
}

export function parsePluginSpecifier(
  value: string,
  options: ParsePluginSpecifierOptions = {},
): ParsedPluginSpecifier {
  if (/^file:/iu.test(value)) {
    throw new Error('Static plugin file URLs are not supported. Use a relative or absolute directory path instead.')
  }

  if (isAbsolute(value) || win32.isAbsolute(value)) {
    return {
      directory: isAbsolute(value)
        ? normalize(value)
        : win32.normalize(value),
      raw: value,
      type: 'directory',
    }
  }

  if (explicitRelativePathPattern.test(value)) {
    if (options.configFile === undefined) {
      throw new Error(`Relative static plugin directory "${value}" requires a config file.`)
    }

    const relativePath = value.split(/[\\/]/u).join(sep)

    return {
      directory: resolve(dirname(options.configFile), relativePath),
      raw: value,
      type: 'directory',
    }
  }

  const versionSeparator = value.lastIndexOf('@')

  if (versionSeparator <= 0 || versionSeparator === value.length - 1) {
    throw new Error(`Static plugin specifier "${value}" must include an exact package version.`)
  }

  const name = value.slice(0, versionSeparator)
  const segments = parsePackageNameSegments(name)

  return {
    name,
    raw: value,
    registryPath: name.startsWith('@')
      ? name.replace('/', '%2f')
      : encodeURIComponent(name),
    segments,
    type: 'registry',
    version: value.slice(versionSeparator + 1),
  }
}

function normalizeDirectoryIdentity(directory: string): string {
  // Parse-layer identity stays lexical and case-preserving; resolvers own physical realpath canonicalization.
  return isAbsolute(directory)
    ? normalize(directory)
    : win32.normalize(directory)
}

function parsePackageNameSegments(name: string): string[] {
  if (
    name === ''
    || name.includes('\\')
    || isAbsolute(name)
    || posix.isAbsolute(name)
  ) {
    throw new Error(`Invalid static plugin package name "${name}".`)
  }

  const segments = name.split('/')

  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Invalid static plugin package name "${name}".`)
  }

  const segmentPattern = /^[a-z0-9][a-z0-9._~-]*$/u

  if (name.startsWith('@')) {
    const [scope, packageName, extraSegment] = segments

    if (
      segments.length !== 2
      || scope === undefined
      || packageName === undefined
      || extraSegment !== undefined
      || !scope.startsWith('@')
      || !segmentPattern.test(scope.slice(1))
      || !segmentPattern.test(packageName)
    ) {
      throw new Error(`Invalid static plugin package name "${name}".`)
    }

    return segments
  }

  if (segments.length !== 1 || !segmentPattern.test(segments[0]!)) {
    throw new Error(`Invalid static plugin package name "${name}".`)
  }

  return segments
}
