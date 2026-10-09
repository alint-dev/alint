import { defineCommand } from '../command'
import { github } from './github/github'
import { stopGate } from './stop-gate/stop-gate'

export const integrations = defineCommand({
  children: [github, stopGate],
  description: 'Run external integrations',
  name: 'integrations',
})
