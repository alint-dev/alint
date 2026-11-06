import type { IndexedHelper } from '../../repo'

/*
 * Worked examples, not prose rules. Reasoning is asked for before the decision, per
 * arXiv:2407.02402: one step of chain-of-thought significantly improves clone detection.
 *
 * PITFALL: keep the negative examples, and never take one from the evaluation corpus. The
 * fingerprints already took every provable pair, so everything left looks alike without being
 * identical, which is where a model over-reports.
 */
export const duplicatedHelperInstructions = [
  'You review small helper functions in one file, and decide whether any of them reimplements a helper that already exists elsewhere in this workspace.',
  '',
  'WHAT IS ALREADY DONE, AND MUST NOT BE REPEATED:',
  'Helpers that are character-for-character identical, and helpers that differ only in the names they declare (their own name, their parameters, their locals), have ALREADY been found and reported without a model. Do not look for those, and do not report them. Your job is the case a fingerprint cannot settle: two helpers written differently that carry the same responsibility.',
  '',
  'THE QUESTION YOU ARE ANSWERING:',
  'Not "could one of these be deleted outright?" but "do these two answer the same question, and should they therefore live in one place?" Two helpers can share a responsibility without being interchangeable at a call site, and they still belong together.',
  '',
  'THREE WORKED EXAMPLES. None of these helpers is in the workspace you are reviewing; they are here to show what the question means.',
  '',
  'EXAMPLE 1 — report it.',
  '  A: function isTimeout(error: unknown): boolean {',
  '       return error instanceof Error && error.name === \'TimeoutError\'',
  '     }',
  '  B: function timedOut(value: unknown): boolean {',
  '       return isError(value) && \'name\' in value && value.name === \'TimeoutError\'',
  '     }',
  '  Duplicate. Both ask whether an error is a timeout. They share no name and no',
  '  fingerprint matches them: one uses `instanceof`, the other a helper and a key',
  '  check. One question, two shapes — which is exactly the case you are here for.',
  '  reason: "Both ask whether an error is a timeout."',
  '',
  'EXAMPLE 2 — do NOT report it.',
  '  A: function firstLine(text: string): string {',
  '       return text.split(\'\\n\')[0]',
  '     }',
  '  B: function firstWord(text: string): string {',
  '       return text.split(\' \')[0]',
  '     }',
  '  Not a duplicate. One shape, two questions: a line is not a word, and the',
  '  separator they split on is the whole difference between them. A shape is not a',
  '  responsibility, and two helpers that merely look alike are the commonest way to',
  '  be wrong here.',
  '',
  'EXAMPLE 3 — report it, and note why it is not obvious.',
  '  A: function isHttpError(error: unknown): error is HttpError {',
  '       return error instanceof HttpError',
  '     }',
  '  B: function isHttpStatus(error: unknown, status: number): boolean {',
  '       return error instanceof HttpError && error.status === status',
  '     }',
  '  Duplicate. Both ask whether a value is an HTTP error; the second is the narrowed',
  '  form of the first. Neither can literally replace the other — only the guard',
  '  narrows the type at a call site — and they are still one family that belongs in',
  '  one place. Do not let "they are not interchangeable" talk you out of a duplicate.',
  '  reason: "Both ask whether an error is an HTTP error."',
  '',
  'And when you are unsure, say nothing. A false report costs a reader\'s trust in',
  'every other report; silence costs almost nothing, because the same helper will be',
  'seen again on the next run.',
  '',
  'HOW TO WORK, one helper at a time:',
  '1. Say in one sentence what the helper does. Describe the behavior, not the name.',
  '2. The helpers that most resemble it are ALREADY BELOW, in full. Go through them one at a time and say, for each, whether it carries the same responsibility as the helper under review — and why, or why not. Work from the bodies, and do not dismiss one because its name is different: a reimplementation always has a different name. That is what makes it hard to see.',
  '3. The ranking that put them there is crude — it counts shared words — so it can rank a stranger above a twin, and the twin may not be there at all. If none of these is it and you believe one exists, go and look: search_helper_bodies searches inside bodies for what the code DOES, such as `instanceof Error` or `.trim()`. Never search for the name. list_helpers, find_similar and get_helper are there too.',
  '4. Never decide from a name or a rank. Decide from a body you have read.',
  '5. Compare behavior against the rubric above, then decide. The order in which two helpers were shown to you means nothing.',
  '6. If it is a duplicate, call report_duplicate once. In `reason`, name the responsibility the two share, in at most twelve words. It is read at the end of a line, beside two names and a path — so name the shared job, not what each helper does, and not what should be done about it. "Both ask whether an error is a missing-file error." is the right length.',
  '',
  'If nothing qualifies, report nothing and say so. Reporting nothing is a common and correct outcome.',
].join('\n')

/**
 * The nearest helpers are pasted in rather than fetched: measured, the agent spent three of its four steps discovering what to read,
 * and every step re-sends the system prompt and every tool schema.
 */
export function buildDuplicatedHelperPrompt(options: {
  candidates: readonly IndexedHelper[]
  filePath: string
  helpers: readonly IndexedHelper[]
}): string {
  const { candidates, filePath, helpers } = options

  return [
    `Review the helpers of: ${filePath}`,
    '',
    'These are the helpers to review. No fingerprint could settle them, so each one is either original, or a reimplementation of something written differently elsewhere.',
    '',
    ...helpers.map(helper => `--- ${helper.id}  (${helper.name}, ${helper.language})\n${helper.text}`),
    '',
    candidates.length === 0
      ? 'No other helper in the workspace resembles these, so there is nothing to compare them against unless you go looking.'
      : [
          'These are the helpers elsewhere in the workspace that most resemble them, closest first. They are a place to start, not a shortlist: the twin may not be here, and most of these will be strangers that happen to look alike.',
          '',
          ...candidates.map(candidate => `--- ${candidate.id}  (${candidate.name}, ${candidate.language})\n${candidate.text}`),
        ].join('\n'),
    '',
    `Work through the ${helpers.length === 1
      ? 'helper'
      : `${helpers.length} helpers`} one at a time, following the procedure.`,
  ].join('\n')
}
