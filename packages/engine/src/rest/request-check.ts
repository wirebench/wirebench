/**
 * Checking an incoming request against its OpenAPI operation (mock services spec §Validation → REST):
 * the request-side counterpart of `contract-check.ts`. Parameters are converted from text to their
 * schema's primitive type (the `form` style, the only one this slice parses) and validated; a JSON
 * body is validated against its media type's schema with values left out of every message.
 */

import { unsupportedKeywordsIn, validateJsonSchema } from '../json/schema-validate.js';
import type { JsonSchemaProblem } from '../json/schema-validate.js';
import { MAX_CHECKED_BODY_BYTES } from './contract-check.js';
import type { OpenApiMediaType, OpenApiOperation, OpenApiParameter } from './openapi/model.js';

/** Problems one check reports, at most. */
export const MAX_REQUEST_PROBLEMS = 20;

export interface RestRequestProblem {
  /** `path`, `query`, `header`, `cookie` or `body`. */
  readonly in: 'path' | 'query' | 'header' | 'cookie' | 'body';
  readonly name?: string;
  /** A JSON Pointer into the value, `''` for the value itself. */
  readonly path: string;
  readonly message: string;
}

export interface RestRequestInput {
  readonly operation: OpenApiOperation;
  readonly pathParams: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, readonly string[]>>;
  /** Header name (any case) to its values. */
  readonly headers: readonly (readonly [string, string])[];
  readonly bodyText: string;
}

export interface RestRequestResult {
  readonly problems: readonly RestRequestProblem[];
  /** The request's media type matches none the operation accepts: answer 415. */
  readonly unsupportedMediaType: boolean;
  /** What was not checked, and why (an unsupported style, an unchecked keyword, a body too large). */
  readonly notes: readonly string[];
}

type SchemaObject = Record<string, unknown>;

function isObject(value: unknown): value is SchemaObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The schema's primitive type, looking through a one-type `type` array. */
function primitiveType(schema: unknown): string | undefined {
  if (!isObject(schema)) return undefined;
  const type = schema['type'];
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) {
    const named = type.filter((entry): entry is string => typeof entry === 'string' && entry !== 'null');
    return named.length === 1 ? named[0] : undefined;
  }
  return undefined;
}

/** `text` as the schema's primitive type, or the text itself when it does not read as one. */
function convert(text: string, schema: unknown): unknown {
  switch (primitiveType(schema)) {
    case 'integer':
    case 'number': {
      const value = Number(text);
      return text.trim() !== '' && Number.isFinite(value) ? value : text;
    }
    case 'boolean':
      return text === 'true' ? true : text === 'false' ? false : text;
    case 'null':
      return text === '' || text === 'null' ? null : text;
    default:
      return text;
  }
}

function headerValues(headers: RestRequestInput['headers'], name: string): string[] {
  const wanted = name.toLowerCase();
  return headers.filter(([candidate]) => candidate.toLowerCase() === wanted).map(([, value]) => value);
}

function cookieValue(headers: RestRequestInput['headers'], name: string): string | undefined {
  for (const header of headerValues(headers, 'cookie')) {
    for (const pair of header.split(';')) {
      const eq = pair.indexOf('=');
      if (eq !== -1 && pair.slice(0, eq).trim() === name) {
        return pair.slice(eq + 1).trim();
      }
    }
  }
  return undefined;
}

/** Every value the request sent for the parameter; empty when it sent none. */
function valuesOf(parameter: OpenApiParameter, input: RestRequestInput): string[] {
  switch (parameter.in) {
    case 'path': {
      const value = Object.hasOwn(input.pathParams, parameter.name) ? input.pathParams[parameter.name] : undefined;
      return value === undefined ? [] : [value];
    }
    case 'query':
      return Object.hasOwn(input.query, parameter.name) ? [...(input.query[parameter.name] ?? [])] : [];
    case 'header':
      return headerValues(input.headers, parameter.name);
    case 'cookie': {
      const value = cookieValue(input.headers, parameter.name);
      return value === undefined ? [] : [value];
    }
    default:
      return [];
  }
}

function defaultStyle(location: string): string {
  return location === 'query' || location === 'cookie' ? 'form' : 'simple';
}

function fromSchemaProblems(
  found: readonly JsonSchemaProblem[],
  where: RestRequestProblem['in'],
  name: string | undefined,
): RestRequestProblem[] {
  return found.map((item) => ({
    in: where,
    ...(name !== undefined ? { name } : {}),
    path: item.path,
    message: item.message,
  }));
}

function checkParameter(
  parameter: OpenApiParameter,
  input: RestRequestInput,
  problems: RestRequestProblem[],
  notes: string[],
): void {
  const where = parameter.in as RestRequestProblem['in'];
  const values = valuesOf(parameter, input);
  if (values.length === 0) {
    if (parameter.required === true || parameter.in === 'path') {
      problems.push({
        in: where,
        name: parameter.name,
        path: '',
        message: `The required ${parameter.in} parameter "${parameter.name}" is missing`,
      });
    }
    return;
  }
  const schema = parameter.schema;
  if (schema === undefined) return;
  const style = parameter.style ?? defaultStyle(parameter.in);
  const isArray = primitiveType(schema) === 'array';
  // A primitive is the same text in every style, so only a composite needs the style parsed.
  if (isArray || primitiveType(schema) === 'object') {
    if (!(style === 'form' && isArray && parameter.in === 'query')) {
      notes.push(`The ${parameter.in} parameter "${parameter.name}" uses the ${style} style, which is not checked`);
      return;
    }
    const explode = parameter.explode ?? true;
    const items = explode ? values : values.flatMap((value) => value.split(','));
    const itemSchema = isObject(schema) ? schema['items'] : undefined;
    const value = items.map((item) => convert(item, itemSchema));
    problems.push(
      ...fromSchemaProblems(
        validateJsonSchema(value, schema, { redactValues: true, maxProblems: MAX_REQUEST_PROBLEMS }),
        where,
        parameter.name,
      ),
    );
    return;
  }
  const value = convert(values[0] ?? '', schema);
  problems.push(
    ...fromSchemaProblems(
      validateJsonSchema(value, schema, { redactValues: true, maxProblems: MAX_REQUEST_PROBLEMS }),
      where,
      parameter.name,
    ),
  );
}

/** The media type the request's `Content-Type` selects: exact, then `type/*`, then `*\/*`. */
export function selectMediaType(
  content: Readonly<Record<string, OpenApiMediaType>>,
  contentType: string | undefined,
): { readonly type: string; readonly media: OpenApiMediaType } | undefined {
  const wanted = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const entries = Object.entries(content).map(([type, media]) => ({ type: type.toLowerCase(), media }));
  const exact = entries.find((entry) => entry.type === wanted);
  if (exact !== undefined) return exact;
  const slash = wanted.indexOf('/');
  const range = slash === -1 ? undefined : `${wanted.slice(0, slash)}/*`;
  return entries.find((entry) => entry.type === range) ?? entries.find((entry) => entry.type === '*/*');
}

export function isJsonMediaType(type: string): boolean {
  const bare = type.split(';')[0]?.trim().toLowerCase() ?? '';
  return bare === 'application/json' || bare.endsWith('+json');
}

/** Checks one request against its operation. Never throws. */
export function checkRestRequest(input: RestRequestInput): RestRequestResult {
  const problems: RestRequestProblem[] = [];
  const notes: string[] = [];
  for (const parameter of input.operation.parameters) {
    if (problems.length >= MAX_REQUEST_PROBLEMS) break;
    checkParameter(parameter, input, problems, notes);
  }

  let unsupportedMediaType = false;
  const requestBody = input.operation.requestBody;
  const contentType = headerValues(input.headers, 'content-type')[0];
  const hasBody = input.bodyText.length > 0;
  if (requestBody !== undefined) {
    if (!hasBody) {
      if (requestBody.required === true) {
        problems.push({ in: 'body', path: '', message: 'The request body is required' });
      }
    } else if (Object.keys(requestBody.content).length > 0) {
      const selected = selectMediaType(requestBody.content, contentType);
      if (selected === undefined) {
        unsupportedMediaType = true;
        problems.push({
          in: 'body',
          path: '',
          message: `The operation does not accept ${contentType ?? 'a body without a Content-Type'}; it accepts ${Object.keys(requestBody.content).join(', ')}`,
        });
      } else if (isJsonMediaType(selected.type) && selected.media.schema !== undefined) {
        if (Buffer.byteLength(input.bodyText, 'utf8') > MAX_CHECKED_BODY_BYTES) {
          notes.push(`The body is over ${MAX_CHECKED_BODY_BYTES} bytes and was not checked`);
        } else {
          let value: unknown;
          let parsed = true;
          try {
            value = JSON.parse(input.bodyText);
          } catch {
            parsed = false;
            problems.push({ in: 'body', path: '', message: 'The body is not valid JSON' });
          }
          if (parsed) {
            notes.push(
              ...unsupportedKeywordsIn(selected.media.schema).map((keyword) => `\`${keyword}\` is not checked`),
            );
            problems.push(
              ...fromSchemaProblems(
                validateJsonSchema(value, selected.media.schema, {
                  redactValues: true,
                  maxProblems: MAX_REQUEST_PROBLEMS,
                }),
                'body',
                undefined,
              ),
            );
          }
        }
      }
    }
  }
  return { problems: problems.slice(0, MAX_REQUEST_PROBLEMS), unsupportedMediaType, notes };
}
