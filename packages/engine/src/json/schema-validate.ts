/**
 * A bounded, in-house JSON Schema validator for contract checks.
 *
 * There is no JSON Schema validator in the engine and no new dependency is allowed for one, so
 * this covers a draft-07-shaped subset: enough of AsyncAPI/OpenAPI message schemas to catch real
 * mistakes without pulling in a library. Unsupported keywords (`format`, `if`/`then`/`else`,
 * `dependencies`/`dependentSchemas`, `propertyNames`, `contains`, `unevaluated*`) and an unresolved
 * `$ref` are silently accepted rather than asserted — a caller wanting to warn about that uses
 * `unsupportedKeywordsIn` up front, once per document.
 *
 * The walk is recursive but shares one `{ nodes, problems }` budget across the whole call, so a
 * pathological schema (a huge array, a `$ref` cycle it does not even try to resolve) cannot make
 * validation expensive: it stops after `maxNodes` schema nodes visited or `maxProblems` problems
 * collected, appending one `budget` problem when the node cap is what stopped it.
 */

/** One validation failure, located by a JSON pointer into the value that was checked. */
export interface JsonSchemaProblem {
  readonly path: string;
  readonly keyword: string;
  readonly message: string;
}

/** Caps that bound a single `validateJsonSchema` call. */
export interface ValidateJsonOptions {
  readonly maxNodes?: number;
  readonly maxProblems?: number;
}

export const MAX_VALIDATE_NODES = 10_000;
export const MAX_VALIDATE_PROBLEMS = 20;

/** Keywords this validator recognises but never asserts; a document using one gets a summary line. */
export const UNSUPPORTED_JSON_SCHEMA_KEYWORDS: readonly string[] = [
  'contains',
  'dependencies',
  'dependentSchemas',
  'format',
  'if',
  'propertyNames',
  'then',
  'else',
  'unevaluatedItems',
  'unevaluatedProperties',
];

const UNSUPPORTED_SET = new Set(UNSUPPORTED_JSON_SCHEMA_KEYWORDS);

type Schema = Record<string, unknown>;

interface Budget {
  nodes: number;
  maxNodes: number;
  problems: JsonSchemaProblem[];
  maxProblems: number;
  stopped: boolean;
}

/** A `Budget` that shares the outer walk's node counter but collects into its own problem list —
 *  used to try a combinator's branch without either polluting the caller's problems or letting the
 *  branch's own node visits escape the shared cap. */
function branchBudget(outer: Budget, maxProblems: number): Budget {
  return {
    get nodes() {
      return outer.nodes;
    },
    set nodes(n: number) {
      outer.nodes = n;
    },
    maxNodes: outer.maxNodes,
    problems: [],
    maxProblems,
    stopped: false,
  };
}

/** Validates `value` against `schema`, returning every problem found (bounded by `options`). */
export function validateJsonSchema(
  value: unknown,
  schema: unknown,
  options?: ValidateJsonOptions,
): JsonSchemaProblem[] {
  const budget: Budget = {
    nodes: 0,
    maxNodes: options?.maxNodes ?? MAX_VALIDATE_NODES,
    problems: [],
    maxProblems: options?.maxProblems ?? MAX_VALIDATE_PROBLEMS,
    stopped: false,
  };
  walk(value, schema, '', budget);
  if (budget.stopped && budget.problems.at(-1)?.keyword !== 'budget' && budget.problems.length < budget.maxProblems) {
    budget.problems.push({ path: '', keyword: 'budget', message: 'validation stopped: node budget exhausted' });
  }
  return budget.problems;
}

/** Every keyword this validator does not assert, found anywhere in `schema` (deduplicated, sorted). */
export function unsupportedKeywordsIn(schema: unknown): string[] {
  const found = new Set<string>();
  const seen = new Set<unknown>();
  collectUnsupported(schema, found, seen);
  return [...found].sort();
}

function collectUnsupported(node: unknown, found: Set<string>, seen: Set<unknown>): void {
  if (!isPlainObject(node) || seen.has(node)) return;
  seen.add(node);
  for (const key of Object.keys(node)) {
    if (UNSUPPORTED_SET.has(key)) found.add(key);
    collectUnsupported(node[key], found, seen);
  }
}

function isPlainObject(v: unknown): v is Schema {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function report(budget: Budget, path: string, keyword: string, message: string): void {
  if (budget.problems.length >= budget.maxProblems) {
    budget.stopped = true;
    return;
  }
  budget.problems.push({ path, keyword, message });
}

function hasRoom(budget: Budget): boolean {
  if (budget.stopped) return false;
  if (budget.problems.length >= budget.maxProblems) {
    budget.stopped = true;
    return false;
  }
  if (budget.nodes >= budget.maxNodes) {
    budget.stopped = true;
    return false;
  }
  budget.nodes += 1;
  return true;
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value: unknown, want: string): boolean {
  if (want === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (want === 'number') return typeof value === 'number';
  return typeName(value) === want;
}

function jsonEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => jsonEquals(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEquals(a[k], b[k]));
  }
  return false;
}

/** Walks one schema node against one value, at `path`, appending problems into the shared budget. */
function walk(value: unknown, schemaValue: unknown, path: string, budget: Budget): void {
  if (!hasRoom(budget)) return;
  if (!isPlainObject(schemaValue)) return; // `true`/`false`/malformed schema: nothing to assert
  const schema = schemaValue;

  if (typeof schema.$ref === 'string') return; // unresolved $ref: passes, per scope

  const nullable = schema.nullable === true;
  const rawTypes = schema.type === undefined ? undefined : Array.isArray(schema.type) ? schema.type : [schema.type];
  const types = rawTypes?.filter((t): t is string => typeof t === 'string');
  if (value === null && (nullable || types?.includes('null'))) {
    return; // an explicitly nullable slot accepts null without checking the rest of the schema
  }

  // 1. type
  if (types && !types.some((t) => matchesType(value, t))) {
    report(budget, path, 'type', `expected ${types.join(' or ')}, got ${typeName(value)}`);
    return; // further keywords assume the right shape
  }

  // 2. const
  if ('const' in schema) {
    if (!jsonEquals(value, schema.const)) {
      report(budget, path, 'const', `expected ${JSON.stringify(schema.const)}`);
      return;
    }
  }

  // 3. enum
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some((v: unknown) => jsonEquals(value, v))) {
      report(budget, path, 'enum', `value is not one of the allowed values`);
      return;
    }
  }

  // 4. string checks
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      report(budget, path, 'minLength', `length ${value.length} is less than ${schema.minLength}`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      report(budget, path, 'maxLength', `length ${value.length} is more than ${schema.maxLength}`);
    }
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(value)) {
          report(budget, path, 'pattern', `does not match /${schema.pattern}/`);
        }
      } catch {
        // an invalid pattern is ignored rather than thrown
      }
    }
  }

  // 5. number checks
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      report(budget, path, 'minimum', `${value} is less than ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      report(budget, path, 'maximum', `${value} is more than ${schema.maximum}`);
    }
    const exclusiveMin = schema.exclusiveMinimum;
    if (typeof exclusiveMin === 'number' && value <= exclusiveMin) {
      report(budget, path, 'exclusiveMinimum', `${value} is not more than ${exclusiveMin}`);
    } else if (exclusiveMin === true && typeof schema.minimum === 'number' && value <= schema.minimum) {
      report(budget, path, 'exclusiveMinimum', `${value} is not more than ${schema.minimum}`);
    }
    const exclusiveMax = schema.exclusiveMaximum;
    if (typeof exclusiveMax === 'number' && value >= exclusiveMax) {
      report(budget, path, 'exclusiveMaximum', `${value} is not less than ${exclusiveMax}`);
    } else if (exclusiveMax === true && typeof schema.maximum === 'number' && value >= schema.maximum) {
      report(budget, path, 'exclusiveMaximum', `${value} is not less than ${schema.maximum}`);
    }
    if (typeof schema.multipleOf === 'number' && schema.multipleOf > 0) {
      const ratio = value / schema.multipleOf;
      if (Math.abs(ratio - Math.round(ratio)) > 1e-9) {
        report(budget, path, 'multipleOf', `${value} is not a multiple of ${schema.multipleOf}`);
      }
    }
  }

  // 6. array checks
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      report(budget, path, 'minItems', `has ${value.length} items, fewer than ${schema.minItems}`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      report(budget, path, 'maxItems', `has ${value.length} items, more than ${schema.maxItems}`);
    }
    if (schema.uniqueItems === true) {
      const dup = value.some((v, i) => value.slice(0, i).some((prior) => jsonEquals(prior, v)));
      if (dup) report(budget, path, 'uniqueItems', 'items are not unique');
    }
    if (Array.isArray(schema.items)) {
      const itemSchemas: unknown[] = schema.items;
      for (let i = 0; i < value.length; i += 1) {
        if (budget.stopped) break;
        const itemSchema = itemSchemas[i];
        if (itemSchema !== undefined) walk(value[i], itemSchema, `${path}/${i}`, budget);
      }
    } else if (isPlainObject(schema.items)) {
      for (let i = 0; i < value.length; i += 1) {
        if (budget.stopped) break;
        walk(value[i], schema.items, `${path}/${i}`, budget);
      }
    }
  }

  // 7. object checks
  if (isPlainObject(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          report(budget, path, 'required', `missing required property "${key}"`);
        }
      }
    }
    if (typeof schema.minProperties === 'number' && Object.keys(value).length < schema.minProperties) {
      report(budget, path, 'minProperties', `has fewer than ${schema.minProperties} properties`);
    }
    if (typeof schema.maxProperties === 'number' && Object.keys(value).length > schema.maxProperties) {
      report(budget, path, 'maxProperties', `has more than ${schema.maxProperties} properties`);
    }

    const properties = isPlainObject(schema.properties) ? schema.properties : undefined;
    const patternProperties = isPlainObject(schema.patternProperties) ? schema.patternProperties : undefined;
    const compiledPatterns: Array<[RegExp, Schema]> = [];
    if (patternProperties) {
      for (const [pattern, sub] of Object.entries(patternProperties)) {
        if (!isPlainObject(sub)) continue;
        try {
          compiledPatterns.push([new RegExp(pattern), sub]);
        } catch {
          // an invalid pattern is ignored rather than thrown
        }
      }
    }

    for (const key of Object.keys(value)) {
      if (budget.stopped) break;
      const childPath = `${path}/${escapePointerSegment(key)}`;
      let matched = false;
      if (properties && Object.prototype.hasOwnProperty.call(properties, key)) {
        matched = true;
        walk(value[key], properties[key], childPath, budget);
      }
      for (const [regex, sub] of compiledPatterns) {
        if (budget.stopped) break;
        if (regex.test(key)) {
          matched = true;
          walk(value[key], sub, childPath, budget);
        }
      }
      if (!matched && schema.additionalProperties === false) {
        report(budget, childPath, 'additionalProperties', `unexpected property "${key}"`);
      } else if (!matched && isPlainObject(schema.additionalProperties)) {
        walk(value[key], schema.additionalProperties, childPath, budget);
      }
    }
  }

  // 8. allOf / anyOf / oneOf / not
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) {
      if (budget.stopped) break;
      walk(value, sub, path, budget);
    }
  }
  if (Array.isArray(schema.anyOf) && !budget.stopped) {
    const anyPasses = schema.anyOf.some((sub: unknown) => {
      const trial = branchBudget(budget, 1);
      walk(value, sub, path, trial);
      return trial.problems.length === 0;
    });
    if (!anyPasses && !budget.stopped) {
      report(budget, path, 'anyOf', 'value matches none of the allowed schemas');
    }
  }
  if (Array.isArray(schema.oneOf) && !budget.stopped) {
    const matches = schema.oneOf.filter((sub: unknown) => {
      const trial = branchBudget(budget, 1);
      walk(value, sub, path, trial);
      return trial.problems.length === 0;
    }).length;
    if (matches !== 1 && !budget.stopped) {
      report(budget, path, 'oneOf', `value matches ${matches} of the allowed schemas, not exactly one`);
    }
  }
  if (isPlainObject(schema.not) && !budget.stopped) {
    const trial = branchBudget(budget, 1);
    walk(value, schema.not, path, trial);
    const notPasses = trial.problems.length === 0;
    if (notPasses && !budget.stopped) {
      report(budget, path, 'not', 'value matches the disallowed schema');
    }
  }
}

function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}
