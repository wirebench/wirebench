/**
 * One JSON Schema differ for both contract formats (#56 spec §3.2, §3.3). A WSDL message reaches it
 * through the XSD bridge's JSON Schema; an OpenAPI message is JSON Schema already. Every difference is
 * classified for the side it is on: the client writes the request and reads the response.
 */
import type { ChangeSeverity, ContractChange, ContractChangeKind, MessageSide } from './model.js';
import { bySide } from './model.js';

export interface DiffSchemasOptions {
  readonly side: MessageSide;
  /** Where the two schemas sit: `request`, `request.body`, `response.200`. */
  readonly location: string;
  readonly operation?: string;
  /**
   * XML messages: a single element that becomes repeating (a value becoming an array of it) widens,
   * because one element is still valid for a repeating particle; in JSON it is a type change.
   */
  readonly xmlOccurrence?: boolean;
  /** The documents `$ref`s resolve against; each schema itself when absent. */
  readonly oldRoot?: unknown;
  readonly newRoot?: unknown;
}

type Schema = Readonly<Record<string, unknown>>;

const isSchema = (value: unknown): value is Schema =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const MAX_REF_HOPS = 32;

/** A local `$ref` (`#/a/b`) looked up in `root`; undefined when it leads nowhere. */
function pointer(root: unknown, ref: string): unknown {
  if (!ref.startsWith('#')) {
    return undefined;
  }
  let node = root;
  for (const raw of ref.slice(1).split('/').slice(1)) {
    const key = decodeURIComponent(raw).replaceAll('~1', '/').replaceAll('~0', '~');
    if (!isSchema(node) || !Object.hasOwn(node, key)) {
      return undefined;
    }
    node = node[key];
  }
  return node;
}

/** The schema a node stands for, its `$ref`s followed; `true` (and a missing schema) allows anything. */
function resolve(node: unknown, root: unknown): Schema {
  let current = node;
  for (let hop = 0; hop < MAX_REF_HOPS; hop += 1) {
    if (!isSchema(current)) {
      return current === false ? { not: {} } : {};
    }
    const ref = current['$ref'];
    if (typeof ref !== 'string') {
      return current;
    }
    const target = pointer(root, ref);
    if (target === undefined) {
      return current;
    }
    current = target;
  }
  return {};
}

const NULL_ONLY = (value: unknown): boolean =>
  isSchema(value) && value['type'] === 'null' && Object.keys(value).every((key) => key === 'type');

/** A schema read as one value: its own keywords plus whether `null` is allowed (OpenAPI 3.0 `nullable`, a nillable element). */
interface Node {
  readonly schema: Schema;
  readonly nullable: boolean;
}

function unwrap(node: unknown, root: unknown): Node {
  const schema = resolve(node, root);
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const options = schema[keyword];
    if (Array.isArray(options) && options.length === 2 && options.some(NULL_ONLY)) {
      const other: unknown = (options as unknown[]).find((option) => !NULL_ONLY(option));
      const inner = unwrap(other, root);
      return { schema: inner.schema, nullable: true };
    }
  }
  return { schema, nullable: schema['nullable'] === true };
}

/** The value types a schema allows; undefined when it does not say (anything). */
function typesOf(node: Node): Set<string> | undefined {
  const { schema } = node;
  const declared = schema['type'];
  let types: Set<string> | undefined;
  if (typeof declared === 'string') {
    types = new Set([declared]);
  } else if (Array.isArray(declared)) {
    types = new Set(declared.filter((value): value is string => typeof value === 'string'));
  } else if (isSchema(schema['properties'])) {
    types = new Set(['object']);
  } else if (schema['items'] !== undefined) {
    types = new Set(['array']);
  }
  if (types !== undefined && node.nullable) {
    types.add('null');
  }
  return types;
}

/** Whether every value of `inner` is a value of `outer`. */
function contains(outer: Set<string> | undefined, inner: Set<string> | undefined): boolean {
  if (outer === undefined) {
    return true;
  }
  if (inner === undefined) {
    return false;
  }
  return [...inner].every((type) => outer.has(type) || (type === 'integer' && outer.has('number')));
}

const sameTypes = (a: Set<string> | undefined, b: Set<string> | undefined): boolean => contains(a, b) && contains(b, a);

const typeText = (types: Set<string> | undefined): string => (types === undefined ? 'any' : [...types].join(' | '));

const valueText = (value: unknown): string => JSON.stringify(value) ?? String(value);

const changeText = (keyword: string, was: unknown, now: unknown): string =>
  `${keyword} ${was === undefined ? 'unset' : valueText(was)} became ${now === undefined ? 'unset' : valueText(now)}`;

function enumOf(schema: Schema): unknown[] | undefined {
  if (Array.isArray(schema['enum'])) {
    return schema['enum'] as unknown[];
  }
  return Object.hasOwn(schema, 'const') ? [schema['const']] : undefined;
}

const LOWER_BOUNDS = ['minLength', 'minimum', 'exclusiveMinimum', 'minItems', 'minProperties'] as const;
const UPPER_BOUNDS = ['maxLength', 'maximum', 'exclusiveMaximum', 'maxItems', 'maxProperties'] as const;
/** `format`s whose second value holds every value of the first. */
const FORMAT_WIDENINGS: ReadonlySet<string> = new Set(['int32>int64', 'float>double']);

/** Keywords that make a combinator option a schema of its own rather than a bare constraint. */
const SHAPE_KEYWORDS = ['type', 'properties', 'items', '$ref', 'enum', 'const', 'allOf', 'oneOf', 'anyOf'];
const IGNORED_KEYWORDS: ReadonlySet<string> = new Set(['description', 'title', 'example', 'examples', '$comment']);

/** Structural equality, cycle-safe, ignoring documentation keywords. */
function sameValue(a: unknown, b: unknown, seen = new Map<object, Set<object>>()): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  const pairs = seen.get(a) ?? new Set<object>();
  if (pairs.has(b)) {
    return true;
  }
  pairs.add(b);
  seen.set(a, pairs);
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameValue(item, b[index], seen))
    );
  }
  const left = a as Schema;
  const right = b as Schema;
  const keys = (record: Schema): string[] => Object.keys(record).filter((key) => !IGNORED_KEYWORDS.has(key));
  const leftKeys = keys(left);
  const rightKeys = keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key], seen))
  );
}

class Differ {
  private readonly changes: ContractChange[] = [];
  private readonly seen = new Map<object, Set<object>>();
  /** The documents `$ref`s resolve against, old then new. */
  private roots: readonly [unknown, unknown] = [undefined, undefined];

  constructor(private readonly options: DiffSchemasOptions) {}

  run(oldSchema: unknown, newSchema: unknown): ContractChange[] {
    const oldRoot = this.options.oldRoot ?? oldSchema;
    const newRoot = this.options.newRoot ?? newSchema;
    this.roots = [oldRoot, newRoot];
    this.node(oldSchema, newSchema, this.options.location);
    return this.changes;
  }

  private add(kind: ContractChangeKind, severity: ChangeSeverity, location: string, message: string): void {
    this.changes.push({
      kind,
      severity,
      ...(this.options.operation !== undefined ? { operation: this.options.operation } : {}),
      location,
      message,
    });
  }

  private sided(onRequest: ChangeSeverity, onResponse: ChangeSeverity): ChangeSeverity {
    return bySide(this.options.side, onRequest, onResponse);
  }

  private node(oldValue: unknown, newValue: unknown, location: string): void {
    this.compare(unwrap(oldValue, this.roots[0]), unwrap(newValue, this.roots[1]), location);
  }

  private firstVisit(a: object, b: object): boolean {
    const pairs = this.seen.get(a) ?? new Set<object>();
    if (pairs.has(b)) {
      return false;
    }
    pairs.add(b);
    this.seen.set(a, pairs);
    return true;
  }

  private compare(before: Node, after: Node, location: string): void {
    if (!this.firstVisit(before.schema, after.schema)) {
      return;
    }
    const oldTypes = typesOf(before);
    const newTypes = typesOf(after);

    if (this.options.xmlOccurrence === true && this.occurrence(before, after, oldTypes, newTypes, location)) {
      return;
    }

    let typeChanged = false;
    if (!sameTypes(oldTypes, newTypes)) {
      typeChanged = true;
      const text = `type ${typeText(oldTypes)} became ${typeText(newTypes)}`;
      if (contains(oldTypes, newTypes)) {
        this.add('type-narrowed', this.sided('breaking', 'compatible'), location, `${text} (narrower)`);
      } else if (contains(newTypes, oldTypes)) {
        this.add('type-widened', this.sided('compatible', 'breaking'), location, `${text} (wider)`);
      } else {
        this.add('type-changed', 'breaking', location, text);
      }
    }

    this.enumeration(before.schema, after.schema, location);
    // A type change already says the values differ; its bounds (an xs:int's range) would only repeat it.
    if (!typeChanged) {
      this.constraints(before.schema, after.schema, location);
    }
    this.object(before.schema, after.schema, location);
    const oldItems = before.schema['items'];
    const newItems = after.schema['items'];
    if (oldItems !== undefined && newItems !== undefined) {
      this.node(oldItems, newItems, `${location}[]`);
    }
    for (const keyword of ['allOf', 'oneOf', 'anyOf'] as const) {
      this.combinator(keyword, before.schema, after.schema, location);
    }
  }

  /** XML occurrence (§3.3): a single value against an array of it. True when it decided the node. */
  private occurrence(
    before: Node,
    after: Node,
    oldTypes: Set<string> | undefined,
    newTypes: Set<string> | undefined,
    location: string,
  ): boolean {
    const isArray = (types: Set<string> | undefined): boolean => types?.size === 1 && types.has('array');
    if (oldTypes !== undefined && !isArray(oldTypes) && isArray(newTypes)) {
      this.add('type-widened', this.sided('compatible', 'breaking'), location, 'a single element now repeats');
      this.node(before.schema, after.schema['items'], location);
      return true;
    }
    if (isArray(oldTypes) && newTypes !== undefined && !isArray(newTypes)) {
      this.add('type-narrowed', this.sided('breaking', 'compatible'), location, 'a repeating element is now single');
      this.node(before.schema['items'], after.schema, location);
      return true;
    }
    return false;
  }

  private enumeration(before: Schema, after: Schema, location: string): void {
    const oldValues = enumOf(before);
    const newValues = enumOf(after);
    if (oldValues === undefined && newValues === undefined) {
      return;
    }
    if (oldValues === undefined) {
      this.add(
        'enum-values-removed',
        this.sided('breaking', 'compatible'),
        location,
        `now limited to ${(newValues ?? []).map(valueText).join(', ')}`,
      );
      return;
    }
    if (newValues === undefined) {
      this.add(
        'enum-values-added',
        this.sided('compatible', 'breaking'),
        location,
        'no longer limited to an enumeration',
      );
      return;
    }
    const has = (values: unknown[], value: unknown): boolean => values.some((candidate) => sameValue(candidate, value));
    const removed = oldValues.filter((value) => !has(newValues, value));
    const added = newValues.filter((value) => !has(oldValues, value));
    if (removed.length > 0) {
      this.add(
        'enum-values-removed',
        this.sided('breaking', 'compatible'),
        location,
        `enumeration values removed: ${removed.map(valueText).join(', ')}`,
      );
    }
    if (added.length > 0) {
      this.add(
        'enum-values-added',
        this.sided('compatible', 'breaking'),
        location,
        `enumeration values added: ${added.map(valueText).join(', ')}`,
      );
    }
  }

  private narrowed(location: string, message: string): void {
    this.add('constraint-narrowed', this.sided('breaking', 'compatible'), location, message);
  }

  private widened(location: string, message: string): void {
    this.add('constraint-widened', 'compatible', location, message);
  }

  private constraints(before: Schema, after: Schema, location: string): void {
    const bound = (keyword: string, lower: boolean): void => {
      const was = before[keyword];
      const now = after[keyword];
      if (sameValue(was, now)) {
        return;
      }
      const text = changeText(keyword, was, now);
      if (typeof was === 'number' && typeof now === 'number') {
        if (lower ? now > was : now < was) this.narrowed(location, text);
        else this.widened(location, text);
        return;
      }
      // An unset bound against a set one; an OpenAPI 3.0 boolean `exclusiveMinimum` too.
      if (now === undefined || now === false) this.widened(location, text);
      else this.narrowed(location, text);
    };
    for (const keyword of LOWER_BOUNDS) bound(keyword, true);
    for (const keyword of UPPER_BOUNDS) bound(keyword, false);

    for (const keyword of ['pattern', 'multipleOf'] as const) {
      const was = before[keyword];
      const now = after[keyword];
      if (!sameValue(was, now)) {
        // A different pattern cannot be proved wider, so it counts as narrower.
        if (now === undefined) this.widened(location, changeText(keyword, was, now));
        else this.narrowed(location, changeText(keyword, was, now));
      }
    }

    const oldFormat = before['format'];
    const newFormat = after['format'];
    if (!sameValue(oldFormat, newFormat)) {
      const wider =
        newFormat === undefined ||
        (typeof oldFormat === 'string' &&
          typeof newFormat === 'string' &&
          FORMAT_WIDENINGS.has(`${oldFormat}>${newFormat}`));
      if (wider) this.widened(location, changeText('format', oldFormat, newFormat));
      else this.narrowed(location, changeText('format', oldFormat, newFormat));
    }

    if (before['uniqueItems'] !== after['uniqueItems']) {
      if (after['uniqueItems'] === true) this.narrowed(location, 'items must now be unique');
      else this.widened(location, 'items no longer need to be unique');
    }
  }

  private object(before: Schema, after: Schema, location: string): void {
    const oldProperties = isSchema(before['properties']) ? before['properties'] : undefined;
    const newProperties = isSchema(after['properties']) ? after['properties'] : undefined;
    if (oldProperties === undefined || newProperties === undefined) {
      return;
    }
    const oldClosed = before['additionalProperties'] === false;
    const newClosed = after['additionalProperties'] === false;
    if (!oldClosed && newClosed) {
      this.narrowed(location, 'other properties are no longer allowed');
    } else if (oldClosed && !newClosed) {
      this.widened(location, 'other properties are now allowed');
    }
    const requiredOf = (schema: Schema): ReadonlySet<unknown> =>
      new Set(Array.isArray(schema['required']) ? (schema['required'] as unknown[]) : []);
    const oldRequired = requiredOf(before);
    const newRequired = requiredOf(after);
    const oldKeys = Object.keys(oldProperties);
    const newKeys = Object.keys(newProperties);
    const at = (key: string): string => `${location}.${key}`;

    for (const key of oldKeys) {
      if (!Object.hasOwn(newProperties, key)) {
        this.add('field-removed', 'breaking', at(key), `${key} removed`);
      }
    }
    for (const key of newKeys) {
      if (Object.hasOwn(oldProperties, key)) {
        continue;
      }
      if (newRequired.has(key)) {
        this.add('field-added', this.sided('breaking', 'compatible'), at(key), `${key} added, required`);
      } else {
        this.add('field-added', 'compatible', at(key), `${key} added, optional`);
      }
    }
    for (const key of oldKeys) {
      if (!Object.hasOwn(newProperties, key)) {
        continue;
      }
      if (!oldRequired.has(key) && newRequired.has(key)) {
        this.add('field-required', this.sided('breaking', 'compatible'), at(key), `${key} is now required`);
      } else if (oldRequired.has(key) && !newRequired.has(key)) {
        this.add('field-optional', this.sided('compatible', 'breaking'), at(key), `${key} is now optional`);
      }
      this.node(oldProperties[key], newProperties[key], at(key));
    }
  }

  private combinator(keyword: 'allOf' | 'oneOf' | 'anyOf', before: Schema, after: Schema, location: string): void {
    const listOf = (schema: Schema): unknown[] =>
      Array.isArray(schema[keyword]) ? (schema[keyword] as unknown[]) : [];
    const oldOptions = listOf(before);
    const newOptions = listOf(after);
    if (sameValue(oldOptions, newOptions)) {
      return;
    }
    if (oldOptions.length !== newOptions.length) {
      const more = newOptions.length > oldOptions.length;
      // More alternatives widen what is allowed; more parts of an allOf narrow it.
      const wider = keyword === 'allOf' ? !more : more;
      const text = `${keyword} has ${String(newOptions.length)} schemas, was ${String(oldOptions.length)}`;
      if (wider) this.add('type-widened', this.sided('compatible', 'breaking'), location, text);
      else this.add('type-narrowed', this.sided('breaking', 'compatible'), location, text);
      return;
    }
    const shaped = (option: unknown): boolean => isSchema(option) && SHAPE_KEYWORDS.some((key) => key in option);
    oldOptions.forEach((oldOption, index) => {
      const newOption = newOptions[index];
      if (sameValue(oldOption, newOption)) {
        return;
      }
      if (shaped(oldOption) && shaped(newOption)) {
        this.node(oldOption, newOption, location);
      } else {
        this.narrowed(location, `a ${keyword} constraint changed`);
      }
    });
  }
}

/** Every difference between two JSON Schemas, classified for `options.side`. */
export function diffSchemas(oldSchema: unknown, newSchema: unknown, options: DiffSchemasOptions): ContractChange[] {
  return new Differ(options).run(oldSchema, newSchema);
}

/** Whether two schemas (or any two JSON values) are the same, documentation aside; cycle-safe. */
export function sameSchema(a: unknown, b: unknown): boolean {
  return sameValue(a, b);
}
