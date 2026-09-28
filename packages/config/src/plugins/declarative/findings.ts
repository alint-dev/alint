import type { DeclarativeFinding } from './types'

/**
 * Phrases that report the absence of a problem instead of reporting nothing.
 *
 * A clean target makes some models answer with a finding that asserts compliance, for example
 * "No violations found." The finding has the shape of a real one, so it reaches the reporter and
 * renders as a diagnostic whose remediation is "change nothing", with a confidence that makes it
 * look as trustworthy as a real hit.
 *
 * Every pattern requires an explicit compliance verb ("found", "needed", "compliant") so a real
 * finding that merely starts with a negative word survives: "No guard clause before the loop" is
 * a missing guard, not a statement that the file is clean.
 */
const compliancePatterns: readonly RegExp[] = [
  // "No violations found.", "No security issue was detected."
  /\bno\s+(?:\w+\s+){0,4}(?:violations?|issues?|problems?)\s+(?:\w+\s+){0,3}(?:found|detected|identified|present)\b/iu,
  // "No changes needed.", "No action is required.", "No fix necessary."
  /\bno\s+(?:\w+\s+){0,3}(?:action|change|changes|fix|fixes|modification|modifications)\s+(?:\w+\s+){0,2}(?:needed|required|necessary)\b/iu,
  // "Nothing to fix.", "Nothing needs to change."
  /\bnothing\s+(?:to|needs?\s+to)\s+(?:address|change|do|fix|report)\b/iu,
  // "The file is compliant.", "It looks compliant.", "The helper complies with the rule."
  /\b(?:is|are|looks?|appears?|seems?)\s+(?:fully\s+|otherwise\s+)?compliant\b/iu,
  /\bcompl(?:y|ies|iant)\s+with\b/iu,
  /\b(?:is|are)\s+(?:already\s+)?(?:correct|fine|good)\b/iu,
  /\b(?:lgtm|looks good|looks fine)\b/iu,
]

/**
 * Compliance phrased in Simplified Chinese, which the output language option can request.
 *
 * "不符合规范" negates the same characters, so the pattern refuses to match right after 不 or 未.
 */
const chineseCompliancePattern = /没有(?:违规|问题)|未发现(?:问题|违规|异常)|(?<![不未])符合(?:规范|要求|约定|预期)|(?<![不未])无需(?:修改|改动)/u

/**
 * A negation anywhere in the message keeps the finding: the message may describe a violation,
 * such as "The module is not compliant with the rule."
 */
const negationPattern = /\b(?:can(?:no|'?t)|didn'?t|doesn'?t|don'?t|isn'?t|aren'?t|never|no longer|not)\b/iu

/** Drops the findings that only assert the target is already correct. */
export function filterActionableFindings(findings: readonly DeclarativeFinding[]): DeclarativeFinding[] {
  return findings.filter(isActionableFinding)
}

/**
 * Whether a finding asks for a change the reviewed target can act on.
 *
 * Judged on the message alone: a real violation whose suggestion happens to say "no further
 * change needed" is still a violation the reader has to see.
 */
export function isActionableFinding(finding: DeclarativeFinding): boolean {
  return !isComplianceStatement(finding.message)
}

function isComplianceStatement(message: string): boolean {
  if (chineseCompliancePattern.test(message)) {
    return true
  }

  if (negationPattern.test(message)) {
    return false
  }

  return compliancePatterns.some(pattern => pattern.test(message))
}
