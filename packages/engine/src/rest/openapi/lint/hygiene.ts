/**
 * The built-in `hygiene` rule set (#342 spec §3): what makes a definition usable by the people and
 * tools that read it — descriptions, examples, operation ids and reusable schemas.
 *
 * Every check is a small function rather than a pattern: a document is untrusted input, and a
 * function over its values has no regular expression to backtrack.
 */

import type { LintFunction, LintRule } from './rules.js';
import { MEDIA_TYPES, OPERATIONS, at, isObject, openapi2, openapi3, operationsOf } from './rules.js';

const RULESET = 'hygiene';

function blank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

/** Reports `field` missing or empty on an object, skipping a `$ref` (its target is checked where it is). */
function requireText(field: string, message: string): LintFunction {
  return (input, _options, context) => {
    if (!isObject(input) || '$ref' in input) return [];
    return blank(input[field]) ? [at(context.path, message)] : [];
  };
}

const operationDescription: LintFunction = (input, _options, context) =>
  isObject(input) && blank(input['summary']) && blank(input['description'])
    ? [at(context.path, 'Operation has neither a summary nor a description')]
    : [];

const successResponse: LintFunction = (input, _options, context) => {
  if (!isObject(input)) return [];
  const responses = input['responses'];
  const keys = isObject(responses) ? Object.keys(responses) : [];
  return keys.some((key) => key.startsWith('2') || key.startsWith('3'))
    ? []
    : [at(context.path, 'Operation declares no 2xx or 3xx response')];
};

/** Every second and later use of one `operationId`, reported where the repeat is. */
const uniqueOperationIds: LintFunction = (input, _options, context) => {
  if (!isObject(input)) return [];
  const seen = new Set<string>();
  const results = [];
  for (const [path, item] of Object.entries(input)) {
    for (const [method, operation] of operationsOf(item)) {
      const id = operation['operationId'];
      if (typeof id !== 'string') continue;
      if (seen.has(id)) {
        results.push(
          at(context.path, `operationId "${id}" is used by more than one operation`, path, method, 'operationId'),
        );
      }
      seen.add(id);
    }
  }
  return results;
};

const mediaExample: LintFunction = (input, _options, context) => {
  if (!isObject(input)) return [];
  const schema = input['schema'];
  const hasExample =
    input['example'] !== undefined ||
    (isObject(input['examples']) && Object.keys(input['examples']).length > 0) ||
    (isObject(schema) && (schema['example'] !== undefined || Array.isArray(schema['examples'])));
  return hasExample ? [] : [at(context.path, 'Media type has no example')];
};

/**
 * An inline object schema with properties — something a client generator would want to name. A
 * parameter's schema only counts in Swagger 2.0, where a `body` parameter carries the request body;
 * in 3.x it is a query or header value's schema, not a body.
 */
const inlineObjectSchema: LintFunction = (input, _options, context) => {
  if (!isObject(input) || '$ref' in input) return [];
  if (context.path.includes('parameters') && !openapi2(context.document.data)) return [];
  const properties = input['properties'];
  return isObject(properties) && Object.keys(properties).length > 0
    ? [at(context.path, 'Body schema is an inline object; move it to the reusable schemas and reference it')]
    : [];
};

export const HYGIENE_RULES: readonly LintRule[] = [
  {
    id: 'info-description',
    severity: 'warning',
    ruleset: RULESET,
    description: 'The API has a description.',
    body: { given: '$.info', then: { function: requireText('description', 'info has no description') } },
  },
  {
    id: 'operation-operationId',
    severity: 'warning',
    ruleset: RULESET,
    description: 'Every operation has an operationId.',
    body: { given: OPERATIONS, then: { function: requireText('operationId', 'Operation has no operationId') } },
  },
  {
    id: 'operation-operationId-unique',
    severity: 'error',
    ruleset: RULESET,
    description: 'No two operations share an operationId.',
    body: { given: '$.paths', then: { function: uniqueOperationIds } },
  },
  {
    id: 'operation-description',
    severity: 'warning',
    ruleset: RULESET,
    description: 'Every operation has a summary or a description.',
    body: { given: OPERATIONS, then: { function: operationDescription } },
  },
  {
    id: 'operation-success-response',
    severity: 'warning',
    ruleset: RULESET,
    description: 'Every operation declares a 2xx or 3xx response.',
    body: { given: OPERATIONS, then: { function: successResponse } },
  },
  {
    id: 'parameter-description',
    severity: 'warning',
    ruleset: RULESET,
    description: 'Every parameter has a description.',
    body: {
      given: [
        '$.paths[*].parameters[*]',
        `${OPERATIONS}.parameters[*]`,
        '$.components.parameters[*]',
        '$.parameters[*]',
      ],
      resolved: false,
      then: { function: requireText('description', 'Parameter has no description') },
    },
  },
  {
    id: 'schema-description',
    severity: 'warning',
    ruleset: RULESET,
    description: 'Every reusable schema has a description.',
    body: {
      given: ['$.components.schemas[*]', '$.definitions[*]'],
      resolved: false,
      then: { function: requireText('description', 'Schema has no description') },
    },
  },
  {
    id: 'media-example',
    severity: 'warning',
    ruleset: RULESET,
    description: 'Every request and response body has an example.',
    body: { given: [...MEDIA_TYPES], formats: [openapi3], resolved: false, then: { function: mediaExample } },
  },
  {
    id: 'inline-object-schema',
    severity: 'warning',
    ruleset: RULESET,
    description: 'Request and response bodies reference reusable schemas instead of declaring inline objects.',
    body: {
      given: [
        ...MEDIA_TYPES.map((media) => `${media}.schema`),
        `${OPERATIONS}.parameters[*].schema`,
        `${OPERATIONS}.responses[*].schema`,
      ],
      resolved: false,
      then: { function: inlineObjectSchema },
    },
  },
];
