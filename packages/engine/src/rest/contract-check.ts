/**
 * Checks a received REST response against the schema its OpenAPI operation declares for it.
 *
 * Pure and synchronous, plain data in and out, so it can run in a worker: a contract's `pattern` is
 * untrusted, and the time budget here only stops the check between steps (reporting `not-checked`,
 * neither a pass nor a failure) — the worker is what bounds a single call that runs away.
 */
import { unsupportedKeywordsIn, validateJsonSchema, type JsonSchemaProblem } from '../json/schema-validate.js';
import type { OpenApiResponses } from './openapi/model.js';
import type { RestOperationRef } from './openapi/match.js';
import { selectResponse } from './openapi/responses.js';

/** A body bigger than this (UTF-8 bytes) is not parsed or validated: it is reported `skipped`. */
export const MAX_CHECKED_BODY_BYTES = 1_048_576;
/** The default time one response's check may take before it gives up as `not-checked`. */
export const DEFAULT_REST_CHECK_BUDGET_MS = 200;
export const MAX_CONTRACT_PROBLEMS = 50;
export const MAX_CONTRACT_MESSAGE_LENGTH = 300;
/** Value nodes the `writeOnly` pass may visit; it walks the value, so the schema's shape cannot loop it. */
const MAX_WRITE_ONLY_NODES = 10_000;

export type RestContractStatus =
  'ok' | 'violation' | 'unmatched' | 'no-schema' | 'no-contract' | 'skipped' | 'not-checked';

export interface RestContractProblem {
  readonly path: string;
  readonly keyword: string;
  readonly message: string;
}

export interface RestContractResult {
  readonly status: RestContractStatus;
  readonly operation?: RestOperationRef;
  readonly responseKey?: string;
  readonly mediaType?: string;
  readonly problems: readonly RestContractProblem[];
  readonly notes: readonly string[];
}

export interface RestContractInput {
  readonly status: number;
  readonly contentType?: string | undefined;
  readonly bodyText: string;
  readonly language: string;
  readonly streamed: boolean;
  readonly operation?: RestOperationRef | undefined;
  readonly responses?: OpenApiResponses | undefined;
}

export interface RestContractCheckOptions {
  readonly budgetMs?: number;
  readonly now?: () => number;
}

function utf8Length(text: string, limit: number): number {
  if (text.length > limit) return text.length;
  if (text.length * 3 <= limit) return text.length;
  return new TextEncoder().encode(text).length;
}

function capped(problems: readonly JsonSchemaProblem[]): RestContractProblem[] {
  return problems.slice(0, MAX_CONTRACT_PROBLEMS).map((p) => ({
    path: p.path,
    keyword: p.keyword,
    message:
      p.message.length > MAX_CONTRACT_MESSAGE_LENGTH ? p.message.slice(0, MAX_CONTRACT_MESSAGE_LENGTH) : p.message,
  }));
}

type SchemaObject = Readonly<Record<string, unknown>>;

function isObject(v: unknown): v is SchemaObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function escapeSegment(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Every present property whose schema says `writeOnly: true`. Composition keywords are followed
 * without moving in the value, so a per-value set of schemas already applied stops a cycle there;
 * everything else descends into the value, which is finite and bounded by the node cap.
 */
function writeOnlyProblems(value: unknown, schema: unknown, max: number): JsonSchemaProblem[] {
  const problems: JsonSchemaProblem[] = [];
  let nodes = 0;
  const visit = (val: unknown, sch: unknown, path: string, applied: Set<unknown>): void => {
    if (!isObject(sch) || applied.has(sch) || problems.length >= max || nodes >= MAX_WRITE_ONLY_NODES) return;
    applied.add(sch);
    nodes++;
    for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
      const branches = sch[keyword];
      if (Array.isArray(branches)) for (const b of branches) visit(val, b, path, applied);
    }
    if (Array.isArray(val)) {
      const items = sch['items'];
      val.forEach((item, i) => {
        const itemSchema: unknown = Array.isArray(items) ? (items as readonly unknown[])[i] : items;
        visit(item, itemSchema, `${path}/${i}`, new Set());
      });
    } else if (isObject(val)) {
      const properties = isObject(sch['properties']) ? sch['properties'] : {};
      for (const key of Object.keys(val)) {
        const childPath = `${path}/${escapeSegment(key)}`;
        const own = Object.prototype.hasOwnProperty.call(properties, key);
        const propSchema = own ? properties[key] : sch['additionalProperties'];
        if (isObject(propSchema) && propSchema['writeOnly'] === true && problems.length < max) {
          problems.push({
            path: childPath,
            keyword: 'writeOnly',
            message: `"${key}" is write-only and must not be in a response`,
          });
        }
        visit(val[key], propSchema, childPath, new Set());
      }
    }
  };
  visit(value, schema, '', new Set());
  return problems;
}

export function checkRestResponse(input: RestContractInput, options?: RestContractCheckOptions): RestContractResult {
  const skipped: RestContractResult = { status: 'skipped', problems: [], notes: [] };
  if (input.language !== 'json' || input.streamed) return skipped;
  if (utf8Length(input.bodyText, MAX_CHECKED_BODY_BYTES) > MAX_CHECKED_BODY_BYTES) return skipped;
  const { operation, responses } = input;
  if (operation === undefined || responses === undefined) return { status: 'no-contract', problems: [], notes: [] };

  const selection = selectResponse(responses, input.status, input.contentType);
  if (selection.kind === 'unmatched') {
    return {
      status: 'unmatched',
      operation,
      problems: [],
      notes: [`the contract declares no ${input.status} response`],
    };
  }
  const { responseKey } = selection;
  if (selection.kind === 'no-body') {
    if (input.bodyText.trim() === '') return { status: 'ok', operation, responseKey, problems: [], notes: [] };
    return {
      status: 'violation',
      operation,
      responseKey,
      problems: [{ path: '', keyword: 'body', message: 'the contract declares no body' }],
      notes: [],
    };
  }
  if (selection.kind === 'no-schema') return { status: 'no-schema', operation, responseKey, problems: [], notes: [] };

  const { mediaType, schema } = selection;
  const found = { operation, responseKey, mediaType };
  let value: unknown;
  try {
    value = JSON.parse(input.bodyText);
  } catch {
    return {
      status: 'violation',
      ...found,
      problems: [{ path: '', keyword: 'json', message: 'not valid JSON' }],
      notes: [],
    };
  }

  const now = options?.now ?? (() => performance.now());
  const budgetMs = options?.budgetMs ?? DEFAULT_REST_CHECK_BUDGET_MS;
  const start = now();
  const notChecked: RestContractResult = { status: 'not-checked', ...found, problems: [], notes: [] };
  let problems: JsonSchemaProblem[];
  try {
    problems = validateJsonSchema(value, schema, { maxProblems: MAX_CONTRACT_PROBLEMS });
    if (now() - start > budgetMs) return notChecked;
    if (problems.length < MAX_CONTRACT_PROBLEMS) {
      problems.push(...writeOnlyProblems(value, schema, MAX_CONTRACT_PROBLEMS - problems.length));
    }
  } catch (error) {
    // A schema that composes itself (`allOf: [itself]`) recurses without moving in the value and
    // can exhaust the stack before the validator's node budget stops it.
    if (error instanceof RangeError) return notChecked;
    throw error;
  }
  const notes = unsupportedKeywordsIn(schema).map((k) => `\`${k}\` is not checked`);
  if (now() - start > budgetMs) return notChecked;
  return { status: problems.length === 0 ? 'ok' : 'violation', ...found, problems: capped(problems), notes };
}
