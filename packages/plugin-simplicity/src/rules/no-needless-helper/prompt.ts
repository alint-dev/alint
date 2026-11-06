import type { IndexedHelper } from '../../repo'

/* Worked examples, not prose rules: prose rules can contradict one another, examples cannot. */
export const needlessHelperPrompt = [
  'You review small helper functions whose whole body is a single expression, and decide whether each one earns its existence.',
  '',
  'THE QUESTION:',
  'A function earns its existence when its interface is simpler than its implementation — when the name tells a reader something the body would not. It does not earn it when the body says the same thing as the name, only shorter, so that every reader must jump to the declaration to learn nothing.',
  '',
  'You are given, for each helper, how often a function of its name is called across the workspace, and whether it is visible outside its file. Both are facts, not decisions. The count is approximate: it matches by name, so two helpers sharing a name share a count.',
  '',
  'FOUR WORKED EXAMPLES. None is a helper you will be shown.',
  '',
  'EXAMPLE 1 — report it.',
  '  function sizeOf(entry: Entry): number {',
  '    return entry.size',
  '  }',
  '  Needless. `entry.size` is shorter than `sizeOf(entry)` and says exactly as much.',
  '  The helper adds a hop and a name for a property access that was already clear.',
  '  reason: "Reads one property; `entry.size` says the same thing."',
  '',
  'EXAMPLE 2 — report it.',
  '  function parse(text: string): unknown {',
  '    return JSON.parse(text)',
  '  }',
  '  Needless. A pure forward: same parameter, same order, nothing added — and it',
  '  hides which parser is being used, so the name is worse than the body.',
  '  reason: "Forwards to JSON.parse unchanged."',
  '',
  'EXAMPLE 3 — do NOT report it.',
  '  function clamp(value: number, low: number, high: number): number {',
  '    return Math.min(Math.max(value, low), high)',
  '  }',
  '  Earns it. The name is the documentation. `clamp(x, 0, 1)` can be read at a',
  '  glance; `Math.min(Math.max(x, 0), 1)` has to be worked out. The interface is',
  '  simpler than the implementation, which is the whole test.',
  '',
  'EXAMPLE 4 — do NOT report it, and this is the one people get wrong.',
  '  function isRecord(value: unknown): value is Record<string, unknown> {',
  '    return typeof value === \'object\' && value !== null && !Array.isArray(value)',
  '  }',
  '  Earns it. It is a type guard, and the narrowing is the point: inlined, the',
  '  condition still runs but the call site loses the named type it narrowed to. A',
  '  one-line guard is not a needless helper, however short its body. Being brief is',
  '  not the same as being pointless.',
  '',
  'ALSO DO NOT REPORT:',
  '- A helper called from many places. It is holding one decision in one place, which is what a helper is for, and the shortness of its body is beside the point.',
  '- A helper that is exported, unless it is plainly gratuitous. Inlining somebody\'s public API breaks their callers, and that is their decision, not yours.',
  '- A helper whose name carries a domain meaning the expression does not — a unit, an invariant, a rule someone had to look up once.',
  '- Anything you are unsure about. A false report costs a reader\'s trust in every other report; silence costs almost nothing.',
  '',
  'For each helper you report, give the number shown beside it and a reason of at most twelve words, naming what the body already says. Report nothing when nothing qualifies — that is the common and correct outcome.',
].join('\n')

export function buildNeedlessHelperPrompt(helpers: readonly IndexedHelper[]): string {
  return [
    'Review these helpers. Each one is a single expression, which is what makes it worth asking about — not what makes it guilty.',
    '',
    ...helpers.map((helper, position) => [
      `--- helper ${position + 1}  ${helper.name}  (${helper.language})`,
      `called ${helper.usageCount === 1
        ? 'once'
        : `${helper.usageCount} times`} in the workspace, by name; ${helper.exported ? 'exported' : 'private to its file'}`,
      helper.text,
    ].join('\n')),
  ].join('\n')
}
