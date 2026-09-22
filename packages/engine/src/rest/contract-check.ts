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
/**
 * Schema nodes one check may visit. Generous, since a real response (hundreds of rows of dozens of
 * properties) must be checkable: the worker's deadline is what bounds the time, and this only stops a
 * body the deadline would let through yet is still too big to finish.
 */
export const MAX_REST_CHECK_NODES = 200_000;
export const MAX_CONTRACT_PATH_LENGTH = 300;
/** Value nodes the `writeOnly` pass may visit; it walks the value, so the schema's shape cannot loop it. */
const MAX_WRITE_ONLY_NODES = MAX_REST_CHECK_NODES;

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
    path: p.path.length > MAX_CONTRACT_PATH_LENGTH ? p.path.slice(0, MAX_CONTRACT_PATH_LENGTH) : p.path,
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

interface WriteOnlyPass {
  readonly problems: JsonSchemaProblem[];
  /** The node cap stopped the pass before it saw the whole value. */
  readonly capped: boolean;
  /** The time budget ran out during the pass. */
  readonly expired: boolean;
  /** An `anyOf`/`oneOf` branch could not be decided (its check hit its own cap), so was not followed. */
  readonly undecided: boolean;
}

/** The schema that applies to item `i`: a tuple's own (`prefixItems`, or draft-07 array `items`), then the rest. */
function itemSchema(sch: SchemaObject, i: number): unknown {
  const items = sch['items'];
  const prefix = Array.isArray(sch['prefixItems']) ? sch['prefixItems'] : Array.isArray(items) ? items : undefined;
  if (prefix !== undefined && i < prefix.length) return (prefix as readonly unknown[])[i];
  if (Array.isArray(sch['prefixItems'])) return items;
  return Array.isArray(items) ? sch['additionalItems'] : items;
}

/**
 * Every present property whose schema says `writeOnly: true`. `allOf` is always followed; an
 * `anyOf`/`oneOf` branch only when the value matches it, so a write-only property of an alternative
 * the value is not does not count. Composition keywords are followed without moving in the value,
 * so a per-value set of schemas already applied stops a cycle there; everything else descends into
 * the value, which is finite and bounded by the node cap.
 */
function writeOnlyProblems(value: unknown, schema: unknown, max: number, expired: () => boolean): WriteOnlyPass {
  const problems: JsonSchemaProblem[] = [];
  let nodes = 0;
  let capped = false;
  let outOfTime = false;
  let undecided = false;
  const halted = (): boolean => {
    if (problems.length >= max || capped || outOfTime) return true;
    if (nodes >= MAX_WRITE_ONLY_NODES) capped = true;
    else if (expired()) outOfTime = true;
    return capped || outOfTime;
  };
  const visit = (val: unknown, sch: unknown, path: string, applied: Set<unknown>): void => {
    if (!isObject(sch) || applied.has(sch) || halted()) return;
    applied.add(sch);
    nodes++;
    const allOf = sch['allOf'];
    if (Array.isArray(allOf)) for (const b of allOf) visit(val, b, path, applied);
    for (const keyword of ['anyOf', 'oneOf']) {
      const branches = sch[keyword];
      if (!Array.isArray(branches)) continue;
      for (const b of branches) {
        if (halted()) return;
        const trial = validateJsonSchema(val, b, { maxProblems: 1 });
        if (trial.length === 0) visit(val, b, path, applied);
        else if (trial[0]?.keyword === 'budget') undecided = true;
      }
    }
    if (Array.isArray(val)) {
      val.forEach((item, i) => visit(item, itemSchema(sch, i), `${path}/${i}`, new Set()));
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
  return { problems, capped, expired: outOfTime, undecided };
}

export function checkRestResponse(input: RestContractInput, options?: RestContractCheckOptions): RestContractResult {
  const skipped: RestContractResult = { status: 'skipped', problems: [], notes: [] };
  if (input.language !== 'json' || input.streamed) return skipped;
  if (utf8Length(input.bodyText, MAX_CHECKED_BODY_BYTES) > MAX_CHECKED_BODY_BYTES) return skipped;
  const { operation, responses } = input;
  if (operation === undefined || responses === undefined) return { status: 'no-contract', problems: [], notes: [] };

  // Only a body detected as JSON gets here, so one with no Content-Type is read as `application/json`.
  const contentType = input.contentType?.trim() ? input.contentType : 'application/json';
  const selection = selectResponse(responses, input.status, contentType);
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
  const notes = unsupportedKeywordsIn(schema).map((k) => `\`${k}\` is not checked`);
  const notChecked: RestContractResult = { status: 'not-checked', ...found, problems: [], notes };
  const expired = (): boolean => now() - start > budgetMs;
  let problems: JsonSchemaProblem[];
  let stopped: string | undefined;
  try {
    const checked = validateJsonSchema(value, schema, {
      maxProblems: MAX_CONTRACT_PROBLEMS,
      maxNodes: MAX_REST_CHECK_NODES,
      redactValues: true,
    });
    if (expired()) return notChecked;
    // A stop on the node or depth cap is not a fault of the body: it only means part went unchecked.
    stopped = checked.find((p) => p.keyword === 'budget')?.message;
    problems = checked.filter((p) => p.keyword !== 'budget');
    if (problems.length < MAX_CONTRACT_PROBLEMS) {
      const pass = writeOnlyProblems(value, schema, MAX_CONTRACT_PROBLEMS - problems.length, expired);
      if (pass.expired) return notChecked;
      problems.push(...pass.problems);
      if (pass.capped) notes.push(`write-only check stopped after ${MAX_WRITE_ONLY_NODES} nodes`);
      if (pass.undecided) {
        notes.push('write-only check could not tell which anyOf/oneOf branch a value matches, so did not follow it');
      }
    }
  } catch (error) {
    // The validator stops self-referencing schemas itself; this is the last resort should some
    // shape still exhaust the stack.
    if (error instanceof RangeError) return notChecked;
    throw error;
  }
  if (expired()) return notChecked;
  if (stopped !== undefined) {
    if (problems.length === 0) return { ...notChecked, notes: [stopped, ...notes] };
    notes.unshift(`partial check: ${stopped}`);
  }
  return { status: problems.length === 0 ? 'ok' : 'violation', ...found, problems: capped(problems), notes };
}
