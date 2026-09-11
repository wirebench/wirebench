/**
 * Runs the WS-I Basic Profile 1.1 WSDL assertion catalogue over one description.
 */

import type { Document } from '@xmldom/xmldom';
import type { WsdlDefinition } from '../../wsdl/model.js';
import type { DefinitionBundle } from '../../wsdl/resolver.js';
import type { SchemaSet } from '../../xsd/schema-set.js';
import type { ValidationProblem } from '../types.js';
import { WSI_WSDL_ASSERTIONS } from './assertions/index.js';
import type {
  WsiAssertion,
  WsiAssertionReport,
  WsiAssertionResult,
  WsiReport,
  WsiSummary,
  WsiWsdlContext,
} from './types.js';
import { isNotApplicable } from './types.js';

/** What {@link wsiWsdlContext} needs: exactly the interesting half of an `ImportResult`. */
export interface WsiWsdlContextInput {
  readonly definition: WsdlDefinition;
  readonly bundle: DefinitionBundle;
  readonly schemaSet: SchemaSet;
}

/**
 * Builds the context the assertions run against, indexing the bundle's documents by location.
 *
 * @param input the parsed definition, its bundle and its schema set (an `ImportResult` fits)
 */
export function wsiWsdlContext(input: WsiWsdlContextInput): WsiWsdlContext {
  const documents = new Map<string, Document>();
  for (const doc of input.bundle.documents) {
    documents.set(doc.location, doc.document);
  }
  return { definition: input.definition, bundle: input.bundle, schemaSet: input.schemaSet, documents };
}

/** Options accepted by {@link runWsdlAssertions}. */
export interface RunWsdlAssertionsOptions {
  /** Run only these assertion ids (default: the whole catalogue). */
  readonly ids?: readonly string[];
  /** Include `passed`/`notApplicable` rows in `assertions` (the `wsi.verbose` preference). */
  readonly verbose?: boolean;
}

/** Classifies one assertion's outcome. */
function resultFor(assertion: WsiAssertion, context: WsiWsdlContext): WsiAssertionReport {
  const outcome = assertion.check(context);
  const findings = isNotApplicable(outcome) ? [] : outcome;
  let result: WsiAssertionResult;
  if (isNotApplicable(outcome)) {
    result = 'notApplicable';
  } else if (findings.length === 0) {
    result = 'passed';
  } else {
    result = assertion.level === 'REQUIRED' ? 'failed' : 'warning';
  }
  return {
    id: assertion.id,
    title: assertion.title,
    level: assertion.level,
    section: assertion.section,
    result,
    findings,
    ...(assertion.unverifiedId === true ? { unverifiedId: true } : {}),
  };
}

/**
 * Evaluates the WSDL assertion catalogue against one description.
 *
 * Every assertion reports one of four results; `summary` always counts all of them, while
 * `assertions` carries only the failing rows unless `verbose` is set.
 *
 * @param context the description to analyse, from {@link wsiWsdlContext}
 * @param options an id subset to run, and whether to keep non-failing rows
 */
export function runWsdlAssertions(context: WsiWsdlContext, options: RunWsdlAssertionsOptions = {}): WsiReport {
  const selected =
    options.ids === undefined
      ? WSI_WSDL_ASSERTIONS
      : WSI_WSDL_ASSERTIONS.filter((assertion) => options.ids?.includes(assertion.id) === true);

  const reports = selected.map((assertion) => resultFor(assertion, context));
  const summary: WsiSummary = {
    passed: reports.filter((report) => report.result === 'passed').length,
    failed: reports.filter((report) => report.result === 'failed').length,
    warning: reports.filter((report) => report.result === 'warning').length,
    notApplicable: reports.filter((report) => report.result === 'notApplicable').length,
  };

  return {
    target: context.bundle.root.location,
    profile: 'BP1.1',
    summary,
    assertions:
      options.verbose === true
        ? reports
        : reports.filter((report) => report.result === 'failed' || report.result === 'warning'),
  };
}

/**
 * Flattens a report's findings into the shared {@link ValidationProblem} shape, so a WS-I report
 * can be shown in the same Problems panel as the message validators' output.
 *
 * Positions are document positions, not envelope positions: `path` carries the document location
 * alongside the element path, as `<document>#<xpath>`, so a consumer can tell the two apart. A
 * finding that has an xpath but no document (or neither) contributes no `path`.
 *
 * @param report the report to flatten
 */
export function wsiProblems(report: WsiReport): readonly ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  for (const assertion of report.assertions) {
    for (const finding of assertion.findings) {
      problems.push({
        severity: assertion.result === 'warning' ? 'warning' : 'error',
        code: assertion.id,
        message: `${assertion.id}: ${finding.message}`,
        source: 'ws-i',
        ...(finding.location?.line !== undefined ? { line: finding.location.line } : {}),
        ...(finding.location?.column !== undefined ? { column: finding.location.column } : {}),
        ...(finding.location?.xpath !== undefined
          ? { path: `${finding.location.document}#${finding.location.xpath}` }
          : {}),
      });
    }
  }
  return problems;
}
