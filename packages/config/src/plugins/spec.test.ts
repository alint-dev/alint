import { dirname, normalize, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { getPluginSpecifierKey, parsePluginSpecifier } from './spec'

describe('plugin specifiers', () => {
  it('preserves exact registry package parsing', () => {
    expect(parsePluginSpecifier('@alint-js/plugin-python@0.3.1')).toEqual({
      name: '@alint-js/plugin-python',
      raw: '@alint-js/plugin-python@0.3.1',
      registryPath: '@alint-js%2fplugin-python',
      segments: ['@alint-js', 'plugin-python'],
      type: 'registry',
      version: '0.3.1',
    })
  })

  it('parses POSIX absolute and config-relative directories', () => {
    expect(parsePluginSpecifier('/repo/plugins/python')).toEqual({
      directory: normalize('/repo/plugins/python'),
      raw: '/repo/plugins/python',
      type: 'directory',
    })
    const configFile = resolve('/repo/config/alint.config.toml')

    expect(parsePluginSpecifier('../plugins/python', {
      configFile,
    })).toEqual({
      directory: resolve(dirname(configFile), '../plugins/python'),
      raw: '../plugins/python',
      type: 'directory',
    })
  })

  it.each([
    [String.raw`.\plugin`, './plugin'],
    [String.raw`..\plugin`, '../plugin'],
  ])('resolves Windows-style relative separators as path segments: %s', (windowsRelative, posixRelative) => {
    const options = { configFile: '/repo/config/alint.config.toml' }
    const windowsSpecifier = parsePluginSpecifier(windowsRelative, options)
    const posixSpecifier = parsePluginSpecifier(posixRelative, options)

    expect(windowsSpecifier.type).toBe('directory')
    expect(posixSpecifier.type).toBe('directory')
    if (windowsSpecifier.type !== 'directory' || posixSpecifier.type !== 'directory') {
      throw new Error('Expected directory plugin specifiers.')
    }
    expect(windowsSpecifier.directory).toBe(posixSpecifier.directory)
  })

  it.each([
    'file:/repo/plugin',
    'file:///repo/plugin',
    'FiLe:///repo/plugin',
  ])('rejects file URL plugin specifier %s', (value) => {
    expect(() => parsePluginSpecifier(value)).toThrow('Static plugin file URLs are not supported.')
  })

  it.each([
    '.',
    '..',
    './plugin',
    '../plugin',
    '.\\plugin',
    '..\\plugin',
  ]) (
    'rejects relative directory %s without config provenance',
    (value) => {
      expect(() => parsePluginSpecifier(value)).toThrow('requires a config file')
    },
  )

  it.each([
    String.raw`C:\plugins\python`,
    String.raw`\\server\share\plugins\python`,
  ])('classifies Windows absolute directory syntax on any host: %s', (value) => {
    expect(parsePluginSpecifier(value)).toEqual({
      directory: value,
      raw: value,
      type: 'directory',
    })
  })

  it('uses exact registry identity and normalized directory identity as keys', () => {
    const registry = parsePluginSpecifier('@scope/plugin@1.0.0')
    const firstDirectory = parsePluginSpecifier('./plugins/python', {
      configFile: '/repo/alint.config.toml',
    })
    const secondDirectory = parsePluginSpecifier('./plugins/../plugins/python', {
      configFile: '/repo/alint.config.toml',
    })

    expect(getPluginSpecifierKey(registry)).toBe('registry:@scope/plugin@1.0.0')
    expect(getPluginSpecifierKey(firstDirectory)).toBe(getPluginSpecifierKey(secondDirectory))
  })

  it('preserves directory case in lexical parse-layer identity', () => {
    const configFile = resolve('/repo/alint.config.toml')
    const upperCase = parsePluginSpecifier('./plugins/Local', { configFile })
    const lowerCase = parsePluginSpecifier('./plugins/local', { configFile })

    expect(upperCase.type).toBe('directory')
    expect(lowerCase.type).toBe('directory')
    if (upperCase.type !== 'directory' || lowerCase.type !== 'directory') {
      throw new Error('Expected directory plugin specifiers.')
    }
    expect(upperCase.directory).toBe(resolve(dirname(configFile), 'plugins/Local'))
    expect(lowerCase.directory).toBe(resolve(dirname(configFile), 'plugins/local'))
    expect(getPluginSpecifierKey(upperCase)).not.toBe(getPluginSpecifierKey(lowerCase))
  })
})
