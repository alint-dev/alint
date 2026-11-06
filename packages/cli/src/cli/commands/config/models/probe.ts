import type { ProbeOptions } from '../probe'

import { errorMessageFrom } from '@moeru/std/error'

import { probeModels } from '../../../provider-registry'
import { defineCommand } from '../../command'
import { providerHeadersFromOptions } from '../probe'

export const probe = defineCommand({
  async action(context, options: ProbeOptions) {
    if (!options.endpoint) {
      context.io.stderr.write('config models probe requires --endpoint.\n')
      return 2
    }

    try {
      const models = await probeModels(options.endpoint, providerHeadersFromOptions(options))
      context.io.stdout.write(`${models.join('\n')}${models.length > 0
        ? '\n'
        : ''}`)
      return 0
    }
    catch (error) {
      context.io.stderr.write(`failed to probe models: ${errorMessageFrom(error) ?? String(error)}\n`)
      return 2
    }
  },
  description: 'Probe OpenAI-compatible models',
  examples: [
    [
      '# Probe a provider endpoint and print available model ids',
      'alint config models probe --endpoint https://openrouter.ai/api/v1',
    ].join('\n'),
    [
      '# Probe an endpoint that requires an authorization header',
      'alint config models probe --endpoint https://api.example.com/v1 --provider-header "Authorization=Bearer $TOKEN"',
    ].join('\n'),
  ],
  help: [
    'Probe an OpenAI-compatible models endpoint before saving it in setup config.',
    'The command calls the provider models endpoint using the supplied endpoint and optional headers, then prints the model ids returned by that provider.',
  ].join('\n\n'),
  name: 'probe',
  options: [
    { description: 'Provider endpoint', flags: '--endpoint <url>' },
    { description: 'Provider header', flags: '--provider-header <Key=Value>' },
  ],
})
