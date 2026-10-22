/**
 * What an OpenAPI lint reports (#342 spec §2): one finding per rule broken, located by a JSON
 * Pointer and, where the text allows, a 1-based line and column.
 */

import type { OpenApiVersion } from '../model.js';

/** How much a finding matters. `--fail-severity` and the SARIF level both read this. */
export type LintSeverity = 'error' | 'warning' | 'info' | 'hint';

/** Every severity, most severe first — the order the gate and the summary count in. */
export const LINT_SEVERITIES: readonly LintSeverity[] = ['error', 'warning', 'info', 'hint'];

/** The two rule sets Wirebench ships. */
export type LintBuiltinRuleset = 'hygiene' | 'owasp';

export const LINT_BUILTIN_RULESETS: readonly LintBuiltinRuleset[] = ['hygiene', 'owasp'];

/** A 1-based position in a document's text. */
export interface LintPosition {
  readonly line: number;
  readonly column: number;
}

/** One rule broken at one place. */
export interface LintFinding {
  /** The rule id — `operation-operationId`, `owasp-plain-http`, `invalid-ref`, a project rule's own id… */
  readonly rule: string;
  readonly severity: LintSeverity;
  readonly message: string;
  /** Where in the document, as a JSON Pointer (`''` is the document itself). */
  readonly path: string;
  /** The location of the document the finding is in: the root, or a file a `$ref` pulled in. */
  readonly source: string;
  readonly range?: { readonly start: LintPosition; readonly end: LintPosition };
}

/** A rule that took part in a lint, for the SARIF driver and the JSON report. */
export interface LintRuleInfo {
  readonly id: string;
  readonly severity: LintSeverity;
  readonly description: string;
  /** `hygiene`, `owasp`, or the rule-set file a project rule came from. */
  readonly ruleset: string;
}

/** What {@link lintOpenApi} produced. */
export interface LintReport {
  readonly version: OpenApiVersion;
  readonly declaredVersion: string;
  /** Sorted by source, line, column and rule, so two runs over one document print the same thing. */
  readonly findings: readonly LintFinding[];
  readonly rules: readonly LintRuleInfo[];
}

/** One project rule-set file, already read: its name (for messages) and its text. */
export interface LintRulesetFile {
  /** A path or label the user recognises; every error about the file names it. */
  readonly name: string;
  readonly text: string;
}

/** How many findings of each severity, for the summary line and the reports. */
export type LintCounts = Readonly<Record<LintSeverity, number>>;

/** Counts `findings` by severity. */
export function countFindings(findings: readonly LintFinding[]): LintCounts {
  const counts: Record<LintSeverity, number> = { error: 0, warning: 0, info: 0, hint: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

/**
 * Whether any finding is at `threshold` or worse. `none` never fails: it is how a job reports
 * without gating.
 */
export function failsAt(findings: readonly LintFinding[], threshold: LintSeverity | 'none'): boolean {
  if (threshold === 'none') {
    return false;
  }
  const limit = LINT_SEVERITIES.indexOf(threshold);
  return findings.some((finding) => LINT_SEVERITIES.indexOf(finding.severity) <= limit);
}
