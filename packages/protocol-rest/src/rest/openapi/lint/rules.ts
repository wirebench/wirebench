/**
 * What every lint rule is made of, and the pieces the built-in and project rules share: the two
 * format predicates and the JSONPath expressions for the parts of a document a rule targets.
 *
 * The runner is an open-source OpenAPI linter; a rule here is that runner's rule definition plus
 * the metadata Wirebench reports (its id, default severity, description and rule set). The runner's
 * own format detection does not know OpenAPI 3.2, so the formats are ours (spec §2).
 */

import type { RuleDefinition, RulesetFunction } from '@stoplight/spectral-core';
import type { LintSeverity } from './model.js';

/** A rule as the runner sees it, minus the two fields Wirebench sets from the rule's metadata. */
export type LintRuleBody = Omit<RuleDefinition, 'severity' | 'description'>;

/** One rule: what it is called, how bad it is by default, and how the runner checks it. */
export interface LintRule {
  readonly id: string;
  readonly severity: LintSeverity;
  readonly description: string;
  /** `hygiene`, `owasp`, or the file a project rule came from. */
  readonly ruleset: string;
  readonly body: LintRuleBody;
}

/** A path into a document, as the runner reports it: keys and array indexes. */
export type JsonPath = (string | number)[];

/** A plain object — all the custom functions walk into. */
export type JsonObject = Readonly<Record<string, unknown>>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value of `openapi` / `swagger` as a string, numbers included (`swagger: 2.0` in YAML). */
function declared(root: JsonObject, key: string): string | undefined {
  const value = root[key];
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' ? value.trim() : undefined;
}

/** A Swagger 2.0 document. */
export function openapi2(document: unknown): boolean {
  return isObject(document) && (declared(document, 'swagger') ?? '').startsWith('2');
}
openapi2.displayName = 'OpenAPI 2.0';

/** An OpenAPI 3.0, 3.1 or 3.2 document. */
export function openapi3(document: unknown): boolean {
  return isObject(document) && /^3\.[0-2](?:\.|$)/.test(declared(document, 'openapi') ?? '');
}
openapi3.displayName = 'OpenAPI 3.x';

/** The operation keys of a Path Item; `query` is OpenAPI 3.2's. */
export const OPERATION_KEYS = 'get,put,post,delete,options,head,patch,trace,query';

/** Every operation of every path. */
export const OPERATIONS = `$.paths[*][${OPERATION_KEYS}]`;

/** Every media type of every request and response body, 3.x. */
export const MEDIA_TYPES: readonly string[] = [
  `${OPERATIONS}.requestBody.content[*]`,
  `${OPERATIONS}.responses[*].content[*]`,
  '$.components.requestBodies[*].content[*]',
  '$.components.responses[*].content[*]',
];

/** A finding from a custom function at `path` (relative to `base`). */
export function at(base: JsonPath, message: string, ...path: (string | number)[]): { message: string; path: JsonPath } {
  return { message, path: [...base, ...path] };
}

/** A custom function, typed loosely on its input because a document can hold anything. */
export type LintFunction = RulesetFunction<unknown, unknown>;

/** The HTTP operations of one Path Item, with their keys, skipping anything else it holds. */
export function operationsOf(pathItem: unknown): readonly [string, JsonObject][] {
  if (!isObject(pathItem)) return [];
  const keys = OPERATION_KEYS.split(',');
  return Object.entries(pathItem).filter(
    (entry): entry is [string, JsonObject] => keys.includes(entry[0]) && isObject(entry[1]),
  );
}
