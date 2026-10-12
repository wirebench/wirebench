/**
 * Linting one OpenAPI document (#342 spec §2): the version checked, the rules handed to the
 * runner, the references fenced, and the runner's diagnostics turned into {@link LintFinding}s.
 */

import { Document, Spectral } from '@stoplight/spectral-core';
import type { ISpectralDiagnostic, RulesetDefinition, RuleDefinition } from '@stoplight/spectral-core';
import Parsers from '@stoplight/spectral-parsers';
import { OpenApiError } from '../../../errors.js';
import type { FetchDocument } from '../../../http/fetch-document.js';
import { parseDocumentText } from '../../../json/schema/parse-text.js';
import { versionOf } from '../parse.js';
import type { LintFinding, LintReport, LintRuleInfo, LintRulesetFile, LintSeverity } from './model.js';
import { lintResolver, referenceLocation, runnerSource } from './resolver.js';
import { planLintRules } from './ruleset.js';
import type { LintRule } from './rules.js';
import { openapi2, openapi3 } from './rules.js';

/** The document to lint: its text, and the absolute location its references resolve against. */
export interface LintInput {
  readonly text: string;
  /** A `file:` or `http(s):` URL; anything else (`inline:`) may reference nothing local. */
  readonly location: string;
}

export interface LintOptions {
  readonly fetchDocument: FetchDocument;
  /** Let a local document reference remote ones. */
  readonly allowRemoteRefs?: boolean;
  readonly signal?: AbortSignal;
}

/** Options for {@link lintOpenApi}: how to read references, and the project's rule sets. */
export interface LintOpenApiOptions extends LintOptions {
  /** Project rule-set files, applied in order after the built-ins (spec §5). */
  readonly rulesets?: readonly LintRulesetFile[];
}

const RUNNER_SEVERITY: Readonly<Record<LintSeverity, 'error' | 'warn' | 'info' | 'hint'>> = {
  error: 'error',
  warning: 'warn',
  info: 'info',
  hint: 'hint',
};

/** The runner's numeric severities, 0 (error) to 3 (hint). */
const FROM_RUNNER: readonly LintSeverity[] = ['error', 'warning', 'info', 'hint'];

/** RFC 6901: `~` is `~0` and `/` is `~1`, in that order. */
function pointer(path: readonly (string | number)[]): string {
  return path.map((segment) => `/${String(segment).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

function toFinding(diagnostic: ISpectralDiagnostic, rootLocation: string, rootSource: string): LintFinding {
  const source =
    diagnostic.source === undefined || diagnostic.source === rootSource
      ? rootLocation
      : referenceLocation(diagnostic.source);
  return {
    rule: String(diagnostic.code),
    severity: FROM_RUNNER[diagnostic.severity] ?? 'error',
    message: diagnostic.message,
    path: pointer(diagnostic.path),
    source,
    range: {
      start: { line: diagnostic.range.start.line + 1, column: diagnostic.range.start.character + 1 },
      end: { line: diagnostic.range.end.line + 1, column: diagnostic.range.end.character + 1 },
    },
  };
}

function compare(a: LintFinding, b: LintFinding): number {
  return (
    a.source.localeCompare(b.source) ||
    (a.range?.start.line ?? 0) - (b.range?.start.line ?? 0) ||
    (a.range?.start.column ?? 0) - (b.range?.start.column ?? 0) ||
    a.rule.localeCompare(b.rule) ||
    a.path.localeCompare(b.path)
  );
}

function rulesetOf(rules: readonly LintRule[]): RulesetDefinition {
  const definitions: Record<string, RuleDefinition> = {};
  for (const rule of rules) {
    // `{{error}}` is the function's own message: without it the runner shows the description.
    definitions[rule.id] = {
      ...rule.body,
      severity: RUNNER_SEVERITY[rule.severity],
      description: rule.description,
      message: '{{error}}',
    };
  }
  return { formats: [openapi2, openapi3], rules: definitions };
}

/**
 * Lints `input` with `rules`, the rule list already decided (built-ins, overrides, project rules).
 *
 * @throws OpenApiError `openapi-malformed` (neither JSON nor YAML), `openapi-not-a-document`, or
 * `lint-unsupported-version` (Swagger 1.x, or an OpenAPI version this client does not read)
 */
export async function lintWithRules(
  input: LintInput,
  rules: readonly LintRule[],
  options: LintOptions,
): Promise<LintReport> {
  const root = parseDocumentText(input.text);
  let version: ReturnType<typeof versionOf>;
  try {
    version = versionOf(root);
  } catch (error) {
    if (error instanceof OpenApiError && error.code === 'openapi-unsupported-version') {
      throw new OpenApiError('lint-unsupported-version', error.message, { cause: error });
    }
    throw error;
  }
  if (version.version.startsWith('1.')) {
    throw new OpenApiError(
      'lint-unsupported-version',
      `${version.declared} is not linted; lint reads OpenAPI 2.0, 3.0, 3.1 and 3.2`,
      { details: { version: version.declared } },
    );
  }

  const spectral = new Spectral({
    resolver: lintResolver({
      rootLocation: input.location,
      fetchDocument: options.fetchDocument,
      ...(options.allowRemoteRefs !== undefined ? { allowRemoteRefs: options.allowRemoteRefs } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    }),
  });
  spectral.setRuleset(rulesetOf(rules));
  const source = runnerSource(input.location);
  const json = /^\s*[{[]/.test(input.text.replace(/^﻿/, ''));
  const document = json
    ? new Document(input.text, Parsers.Json, source)
    : new Document(input.text, Parsers.Yaml, source);
  const diagnostics = await spectral.run(document, { ignoreUnknownFormat: true });

  const info: LintRuleInfo[] = rules.map(({ id, severity, description, ruleset }) => ({
    id,
    severity,
    description,
    ruleset,
  }));
  return {
    version: version.version,
    declaredVersion: version.declared,
    findings: diagnostics.map((diagnostic) => toFinding(diagnostic, input.location, source)).sort(compare),
    rules: info,
  };
}

/**
 * Lints one OpenAPI 2.0, 3.0, 3.1 or 3.2 document with the built-in rule sets and `rulesets`.
 *
 * @throws WirebenchError `lint-ruleset-invalid` for a rule-set file that is not valid; the
 * OpenApiError codes of {@link lintWithRules}
 */
export async function lintOpenApi(input: LintInput, options: LintOpenApiOptions): Promise<LintReport> {
  return await lintWithRules(input, planLintRules(options.rulesets ?? []), options);
}
