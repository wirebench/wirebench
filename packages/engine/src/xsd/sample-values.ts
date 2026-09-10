import { NS } from '../xml/namespaces.js';
import type { QName } from '../wsdl/qname.js';
import { qnameToString } from '../wsdl/qname.js';
import type { BuiltinType } from './builtins.js';
import type { Facet, SimpleType, TypeDefinition } from './model.js';

/** The lookups the value helpers need; satisfied by a built `SchemaSet`. */
export interface SampleValueContext {
  lookupType(name: QName): TypeDefinition | undefined;
  builtin(name: QName): BuiltinType | undefined;
}

/** Options controlling how a leaf's content is produced. */
export interface SampleValueOptions {
  /** When false, every leaf is the SoapUI placeholder `?`. */
  readonly sampleValues: boolean;
}

/** A reference to a simple type: a name, an inline definition, or nothing. */
export type SimpleTypeRef = QName | SimpleType | undefined;

/** The SoapUI placeholder emitted for every leaf when sample values are off. */
export const PLACEHOLDER = '?';

const INTEGER_NAMES = new Set([
  'integer',
  'nonPositiveInteger',
  'negativeInteger',
  'long',
  'int',
  'short',
  'byte',
  'nonNegativeInteger',
  'unsignedLong',
  'unsignedInt',
  'unsignedShort',
  'unsignedByte',
  'positiveInteger',
]);

function isQName(ref: QName | SimpleType): ref is QName {
  return !('kind' in ref);
}

/** The value of the first `enumeration` facet, if the type declares one. */
function enumerationFacet(facets: readonly Facet[]): readonly string[] | undefined {
  for (const facet of facets) {
    if (facet.kind === 'enumeration') {
      return facet.values;
    }
  }
  return undefined;
}

/** The lexical value of the first bound facet of `kind`. */
function boundFacet(
  facets: readonly Facet[],
  kind: 'minInclusive' | 'maxInclusive' | 'minExclusive' | 'maxExclusive',
): string | undefined {
  for (const facet of facets) {
    if (facet.kind === kind) {
      return facet.value;
    }
  }
  return undefined;
}

/** The value of the first `length` facet, falling back to `minLength`. */
function lengthFacet(facets: readonly Facet[]): number | undefined {
  for (const kind of ['length', 'minLength'] as const) {
    for (const facet of facets) {
      if (facet.kind === kind) {
        return facet.value;
      }
    }
  }
  return undefined;
}

/** Resolves a named reference to its simple type definition, if the schema has one. */
function resolveSimple(ctx: SampleValueContext, ref: SimpleTypeRef): SimpleType | undefined {
  if (ref === undefined) {
    return undefined;
  }
  if (!isQName(ref)) {
    return ref;
  }
  const type = ctx.lookupType(ref);
  return type !== undefined && type.kind === 'simpleType' ? type : undefined;
}

/**
 * Walks a simple type's restriction chain down to the built-in it ultimately
 * derives from. Returns `undefined` for unresolvable or non-atomic chains.
 */
export function builtinBaseOf(
  ctx: SampleValueContext,
  ref: SimpleTypeRef,
  visited = new Set<string>(),
): BuiltinType | undefined {
  if (ref === undefined) {
    return undefined;
  }
  if (isQName(ref)) {
    const key = qnameToString(ref);
    if (visited.has(key)) {
      return undefined;
    }
    visited.add(key);
    const builtin = ctx.builtin(ref);
    if (builtin !== undefined) {
      return builtin.aliasOf !== undefined ? (ctx.builtin(builtin.aliasOf) ?? builtin) : builtin;
    }
    return builtinBaseOf(ctx, resolveSimple(ctx, ref), visited);
  }
  if (ref.variety !== 'atomic') {
    return undefined;
  }
  return builtinBaseOf(ctx, ref.base ?? ref.baseType, visited);
}

/** The nearest `enumeration` facet in a simple type's restriction chain. */
function enumerationOf(
  ctx: SampleValueContext,
  ref: SimpleTypeRef,
  visited = new Set<string>(),
): readonly string[] | undefined {
  const simple = resolveSimple(ctx, ref);
  if (simple === undefined) {
    return undefined;
  }
  if (isQName(ref as QName | SimpleType)) {
    const key = qnameToString(ref as QName);
    if (visited.has(key)) {
      return undefined;
    }
    visited.add(key);
  }
  const values = enumerationFacet(simple.facets);
  if (values !== undefined && values.length > 0) {
    return values;
  }
  return simple.variety === 'atomic' ? enumerationOf(ctx, simple.base ?? simple.baseType, visited) : undefined;
}

/** The constraining facets a form editor can act on, gathered from a restriction chain. */
export interface FormFacets {
  readonly enum?: readonly string[];
  readonly pattern?: string;
  /** Lexical `minInclusive`/`minExclusive` bound, whichever the chain declares first. */
  readonly min?: string;
  readonly max?: string;
}

/**
 * Collects the facets a form field can enforce (`enumeration`, `pattern` and the
 * numeric/date bounds) by walking a simple type's restriction chain, nearest
 * declaration winning. Returns an empty object for built-ins and unresolvable
 * references — the form never blocks on a facet it could not read.
 */
export function facetsOf(ctx: SampleValueContext, ref: SimpleTypeRef, visited = new Set<string>()): FormFacets {
  const simple = resolveSimple(ctx, ref);
  if (simple === undefined) {
    return {};
  }
  if (ref !== undefined && isQName(ref)) {
    const key = qnameToString(ref);
    if (visited.has(key)) {
      return {};
    }
    visited.add(key);
  }
  const inherited = simple.variety === 'atomic' ? facetsOf(ctx, simple.base ?? simple.baseType, visited) : {};
  const values = enumerationFacet(simple.facets);
  const pattern = simple.facets.find((f) => f.kind === 'pattern');
  const min = boundFacet(simple.facets, 'minInclusive') ?? boundFacet(simple.facets, 'minExclusive');
  const max = boundFacet(simple.facets, 'maxInclusive') ?? boundFacet(simple.facets, 'maxExclusive');
  return {
    ...inherited,
    ...(values !== undefined && values.length > 0 ? { enum: values } : {}),
    ...(pattern !== undefined && pattern.kind === 'pattern' ? { pattern: pattern.value } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
  };
}

/** Adds `delta` to an integer bound, leaving non-integer bounds untouched. */
function shiftBound(value: string, delta: number, integer: boolean): string {
  if (!integer) {
    return value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(Math.trunc(parsed) + delta) : value;
}

/**
 * Derives a value from a simple type's facets. Facets are considered in a fixed
 * order so output stays predictable: `enumeration` (first value), then the
 * bounds (`minInclusive`, `minExclusive` + 1 for integers, `maxInclusive`,
 * `maxExclusive` - 1 for integers), then `length`/`minLength` (that many `?`),
 * and finally the built-in base's own sample value.
 */
function atomicSample(ctx: SampleValueContext, simple: SimpleType, visited: Set<string>): string {
  const values = enumerationFacet(simple.facets);
  if (values !== undefined && values.length > 0) {
    return values[0] as string;
  }
  const base = builtinBaseOf(ctx, simple);
  const integer = base !== undefined && base.name.namespaceUri === NS.XSD && INTEGER_NAMES.has(base.name.localName);
  const minInclusive = boundFacet(simple.facets, 'minInclusive');
  if (minInclusive !== undefined) {
    return minInclusive;
  }
  const minExclusive = boundFacet(simple.facets, 'minExclusive');
  if (minExclusive !== undefined) {
    return shiftBound(minExclusive, 1, integer);
  }
  const maxInclusive = boundFacet(simple.facets, 'maxInclusive');
  if (maxInclusive !== undefined) {
    return maxInclusive;
  }
  const maxExclusive = boundFacet(simple.facets, 'maxExclusive');
  if (maxExclusive !== undefined) {
    return shiftBound(maxExclusive, -1, integer);
  }
  const length = lengthFacet(simple.facets);
  if (length !== undefined && length > 0 && length <= 64) {
    return PLACEHOLDER.repeat(length);
  }
  return sampleFor(ctx, simple.base ?? simple.baseType, visited);
}

function sampleFor(ctx: SampleValueContext, ref: SimpleTypeRef, visited: Set<string>): string {
  if (ref === undefined) {
    return PLACEHOLDER;
  }
  if (isQName(ref)) {
    const key = qnameToString(ref);
    if (visited.has(key)) {
      return PLACEHOLDER;
    }
    visited.add(key);
    const builtin = ctx.builtin(ref);
    if (builtin !== undefined) {
      return builtin.sampleValue === '' ? PLACEHOLDER : builtin.sampleValue;
    }
    const simple = resolveSimple(ctx, ref);
    return simple === undefined ? PLACEHOLDER : sampleFor(ctx, simple, visited);
  }
  switch (ref.variety) {
    case 'list': {
      // A list sample shows two items so the separator is visible.
      const item = sampleFor(ctx, ref.itemType, visited);
      return `${item} ${item}`;
    }
    case 'union': {
      const first = ref.memberTypes?.[0];
      return first === undefined ? PLACEHOLDER : sampleFor(ctx, first, visited);
    }
    default:
      return atomicSample(ctx, ref, visited);
  }
}

/**
 * Produces the text content for a simple-typed leaf: the SoapUI placeholder
 * `?` unless `sampleValues` is on, in which case a facet- and built-in-derived
 * example value is returned. Callers apply `fixed`/`default` themselves; those
 * always win over anything computed here.
 *
 * @param type the leaf's type: a named reference, an inline definition, or `undefined` (treated as `xs:anyType`)
 */
export function sampleValueFor(ctx: SampleValueContext, type: SimpleTypeRef, options: SampleValueOptions): string {
  if (!options.sampleValues) {
    return PLACEHOLDER;
  }
  return sampleFor(ctx, type, new Set());
}

/** Renders a type name with its conventional prefix (`xs:int`, `soapenc:string`, `ColorCode`). */
function typeLabel(name: QName): string {
  if (name.namespaceUri === NS.XSD) {
    return `xs:${name.localName}`;
  }
  if (name.namespaceUri === NS.SOAP11_ENC) {
    return `soapenc:${name.localName}`;
  }
  return name.localName;
}

/**
 * Builds the body of a leaf's `<!--type: …-->` comment, e.g. `type: xs:int` or
 * `type: xs:string - enumeration: [RED, GREEN, BLUE]`. Named simple types are
 * reported by the built-in they ultimately restrict, so the comment always
 * says what the value must look like. Returns `undefined` when nothing useful
 * is known about the type.
 */
export function typeCommentFor(ctx: SampleValueContext, type: SimpleTypeRef): string | undefined {
  if (type === undefined) {
    return undefined;
  }
  const simple = resolveSimple(ctx, type);
  if (simple !== undefined && simple.variety === 'list') {
    const item = typeCommentFor(ctx, simple.itemType);
    return item === undefined ? undefined : `type: list of ${item.replace(/^type: /, '')}`;
  }
  if (simple !== undefined && simple.variety === 'union') {
    const members = (simple.memberTypes ?? [])
      .map((m) => typeCommentFor(ctx, m)?.replace(/^type: /, ''))
      .filter((m): m is string => m !== undefined);
    return members.length === 0 ? undefined : `type: union of [${members.join(', ')}]`;
  }
  const base = builtinBaseOf(ctx, type);
  const label = base !== undefined ? typeLabel(base.name) : isQName(type) ? typeLabel(type) : undefined;
  if (label === undefined) {
    return undefined;
  }
  const values = enumerationOf(ctx, type);
  const suffix = values !== undefined ? ` - enumeration: [${values.join(', ')}]` : '';
  return `type: ${label}${suffix}`;
}
