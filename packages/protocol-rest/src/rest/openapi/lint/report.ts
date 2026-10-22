/**
 * A lint report written out (#342 spec §6): the JSON report, and SARIF 2.1.0 for code scanning.
 *
 * Locations in both are given as the caller wants them shown — the CLI passes a function that turns
 * a `file:` URL into a path relative to the working directory, which is what code scanning matches
 * against the repository.
 */

import type { LintCounts, LintFinding, LintReport, LintSeverity } from './model.js';
import { countFindings } from './model.js';

/** Who wrote the report, as the SARIF driver and the JSON `tool` name it. */
export interface LintTool {
  readonly name: string;
  readonly version: string;
}

export interface LintReportOptions {
  readonly tool: LintTool;
  /** The document as the user named it: a path, a URL or `project:<name>`. */
  readonly document: string;
  /** How a finding's source location is written; the location itself when absent. */
  readonly displayLocation?: (location: string) => string;
}

/** The JSON report's shape (spec §6). */
export interface LintJsonReport {
  readonly tool: LintTool;
  readonly document: string;
  readonly declaredVersion: string;
  readonly summary: LintCounts;
  readonly findings: readonly LintFinding[];
}

export function lintReportJson(report: LintReport, options: LintReportOptions): LintJsonReport {
  const display = options.displayLocation ?? ((location: string) => location);
  return {
    tool: options.tool,
    document: options.document,
    declaredVersion: report.declaredVersion,
    summary: countFindings(report.findings),
    findings: report.findings.map((finding) => ({ ...finding, source: display(finding.source) })),
  };
}

/** SARIF has three levels that mean something here; a hint is as advisory as an info. */
const SARIF_LEVEL: Readonly<Record<LintSeverity, 'error' | 'warning' | 'note'>> = {
  error: 'error',
  warning: 'warning',
  info: 'note',
  hint: 'note',
};

/** The SARIF 2.1.0 log of one lint: one run, every rule that ran, one result per finding. */
export function lintReportSarif(report: LintReport, options: LintReportOptions): Record<string, unknown> {
  const display = options.displayLocation ?? ((location: string) => location);
  const known = new Set(report.rules.map((rule) => rule.id));
  // A finding the runner itself raises (an unresolvable reference, a parse problem) has no rule of
  // ours; SARIF wants every result's rule in the driver, so it gets one.
  const extra = [...new Set(report.findings.map((finding) => finding.rule).filter((id) => !known.has(id)))];
  const rules = [
    ...report.rules.map((rule) => ({
      id: rule.id,
      shortDescription: { text: rule.description },
      defaultConfiguration: { level: SARIF_LEVEL[rule.severity] },
      properties: { ruleset: rule.ruleset },
    })),
    ...extra.map((id) => ({ id, shortDescription: { text: id }, defaultConfiguration: { level: 'error' } })),
  ];
  const index = new Map(rules.map((rule, position) => [rule.id, position]));
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: options.tool.name,
            version: options.tool.version,
            informationUri: 'https://github.com/wirebench/wirebench',
            rules,
          },
        },
        results: report.findings.map((finding) => ({
          ruleId: finding.rule,
          ruleIndex: index.get(finding.rule),
          level: SARIF_LEVEL[finding.severity],
          message: { text: finding.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: display(finding.source) },
                ...(finding.range !== undefined
                  ? {
                      region: {
                        startLine: finding.range.start.line,
                        startColumn: finding.range.start.column,
                        endLine: finding.range.end.line,
                        endColumn: finding.range.end.column,
                      },
                    }
                  : {}),
              },
              logicalLocations: [{ fullyQualifiedName: finding.path === '' ? '/' : finding.path, kind: 'member' }],
            },
          ],
        })),
      },
    ],
  };
}
