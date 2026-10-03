/**
 * Between an XSD and JSON (#33 spec §3.1, §5): the JSON Schema a body element's content maps to, XML
 * written from a JSON value through the form model, and JSON read back from XML.
 *
 * All three read a complex type's content the same way, as an ordered list of {@link Member}s with
 * stable JSON keys, in the order the form model emits its nodes: so the property a value is written
 * from is the one the schema names and the one the reader fills. Pure and synchronous.
 */
import type { QName } from '../wsdl/qname.js';
import { qnameToString } from '../wsdl/qname.js';
import { NS } from '../xml/namespaces.js';
import { prefixForNamespace } from '../xml/prefixes.js';
import type {
  ComplexType,
  ElementDecl,
  Facet,
  Occurs,
  Particle,
  ResolvedAttribute,
  ResolvedContent,
  SimpleType,
} from './model.js';
import { firstConcreteDerived, resolveType } from './sample-types.js';
import type { ResolvedType } from './sample-types.js';
import { builtinBaseOf } from './sample-values.js';
import type { SimpleTypeRef } from './sample-values.js';
import type { SchemaSet } from './schema-set.js';

/** A JSON Schema, as plain JSON. */
export type JsonSchemaObject = Record<string, unknown>;

/** What the bridge maps: a global element, or an element named here whose content is a type (an rpc part). */
export type BridgeTarget = { readonly element: QName } | { readonly name: QName; readonly type: QName };

export interface JsonSchemaOfResult {
  readonly schema: JsonSchemaObject;
  /** What the schema could not say: a pattern JSON Schema cannot express, an unresolved reference. */
  readonly notes: readonly string[];
}

/** Several targets written against one `$defs`: an operation's parts. */
export interface JsonSchemaWriter {
  /** The target's own content, inline even when its type is named. */
  schemaOf(target: BridgeTarget): JsonSchemaObject;
  /** Every named complex type reached so far, keyed as the `$ref`s name them; undefined when none. */
  defs(): JsonSchemaObject | undefined;
  notes(): readonly string[];
}

/** A property's description is the element's documentation, cut to this many characters. */
export const MAX_PROPERTY_DESCRIPTION = 200;

const FRAGMENT_DESCRIPTION = 'An XML fragment, inserted as written';

export const ONCE: Occurs = { min: 1, max: 1 };

/** One thing a complex type's content contributes to its JSON object, in particle order. */
export type Member =
  | {
      readonly kind: 'element';
      readonly key: string;
      readonly decl: ElementDecl;
      /** Every name that stands for it: the declaration's, and its substitution group's. */
      readonly names: readonly QName[];
      readonly occurs: Occurs;
      readonly optional: boolean;
    }
  | { readonly kind: 'any'; readonly key: string; readonly occurs: Occurs; readonly optional: boolean }
  | {
      readonly kind: 'choice';
      readonly occurs: Occurs;
      readonly optional: boolean;
      readonly branches: readonly (readonly Member[])[];
    }
  | {
      /** A compositor with `maxOccurs > 1`: an array of objects, each holding `members`. */
      readonly kind: 'group';
      readonly key: string;
      readonly compositor: 'sequence' | 'all' | 'choice';
      readonly occurs: Occurs;
      readonly optional: boolean;
      readonly members: readonly Member[];
    };

/** A complex type's content as the bridge reads it. */
export interface ContentShape {
  readonly content: ResolvedContent;
  readonly attributes: readonly { readonly key: string; readonly attribute: ResolvedAttribute }[];
  readonly members: readonly Member[];
}

/** True when a particle may appear more than once. */
export function repeats(occurs: Occurs): boolean {
  return occurs.max === 'unbounded' || occurs.max > 1;
}

/** The keys of one JSON object: unique, and stable for one content model. */
class KeySpace {
  private readonly taken = new Set<string>();
  private readonly prefixes = new Set<string>();
  private readonly elementNamespaces = new Map<string, string>();
  private readonly attributeNamespaces = new Map<string, string>();

  element(name: QName): string {
    return this.unique(this.qualified(name, this.elementNamespaces));
  }

  attribute(name: QName): string {
    return this.unique(`@${this.qualified(name, this.attributeNamespaces)}`);
  }

  reserve(key: string): string {
    return this.unique(key);
  }

  /** The local name; a second namespace for it gets a prefix. */
  private qualified(name: QName, seen: Map<string, string>): string {
    const first = seen.get(name.localName);
    if (first === undefined) {
      seen.set(name.localName, name.namespaceUri);
      return name.localName;
    }
    if (first === name.namespaceUri) {
      return name.localName;
    }
    const prefix = prefixForNamespace(name.namespaceUri, this.prefixes);
    this.prefixes.add(prefix);
    return `${prefix}:${name.localName}`;
  }

  private unique(key: string): string {
    let candidate = key;
    for (let n = 2; this.taken.has(candidate); n += 1) {
      candidate = `${key}_${String(n)}`;
    }
    this.taken.add(candidate);
    return candidate;
  }
}

/** The declaration a particle stands for, an abstract head replaced by its first concrete member. */
function elementTarget(
  set: SchemaSet,
  particle: Particle,
): { readonly decl: ElementDecl; readonly names: readonly QName[] } | undefined {
  if (particle.kind === 'localElement') {
    return { decl: particle.decl, names: [particle.decl.name] };
  }
  if (particle.kind !== 'elementRef') {
    return undefined;
  }
  const head = set.lookupElement(particle.ref);
  if (head === undefined) {
    return undefined;
  }
  const substitutions = set.substitutionsFor(particle.ref);
  const decl = head.abstract ? (substitutions.find((candidate) => !candidate.abstract) ?? head) : head;
  return { decl, names: [head.name, ...substitutions.map((member) => member.name)] };
}

/** The members a particle contributes, mirroring `buildParticle` in `form-model.ts` node for node. */
function membersOf(
  set: SchemaSet,
  particle: Particle | undefined,
  keys: KeySpace,
  optional: boolean,
  notes: string[],
): Member[] {
  if (particle === undefined) {
    return [];
  }
  const target = elementTarget(set, particle);
  if (target !== undefined) {
    return [
      {
        kind: 'element',
        key: keys.element(target.decl.name),
        decl: target.decl,
        names: target.names,
        occurs: particle.occurs,
        optional: optional || particle.occurs.min === 0,
      },
    ];
  }
  switch (particle.kind) {
    case 'localElement':
      return [];
    case 'elementRef':
      notes.push(`no element ${qnameToString(particle.ref)} in the schema`);
      return [];
    case 'groupRef':
      // `resolveContent` expands group references before this runs.
      return [];
    case 'any':
      return [
        {
          kind: 'any',
          key: keys.reserve('#any'),
          occurs: particle.occurs,
          optional: optional || particle.occurs.min === 0,
        },
      ];
    case 'choice': {
      const choiceOptional = optional || particle.occurs.min === 0;
      if (repeats(particle.occurs)) {
        const itemKeys = new KeySpace();
        return [
          {
            kind: 'group',
            key: keys.reserve('#choice'),
            compositor: 'choice',
            occurs: particle.occurs,
            optional: choiceOptional,
            members: [
              {
                kind: 'choice',
                occurs: ONCE,
                optional: false,
                branches: particle.particles.map((branch) => membersOf(set, branch, itemKeys, false, notes)),
              },
            ],
          },
        ];
      }
      return [
        {
          kind: 'choice',
          occurs: particle.occurs,
          optional: choiceOptional,
          branches: particle.particles.map((branch) => membersOf(set, branch, keys, false, notes)),
        },
      ];
    }
    case 'sequence':
    case 'all': {
      const groupOptional = optional || particle.occurs.min === 0;
      if (repeats(particle.occurs)) {
        const itemKeys = new KeySpace();
        return [
          {
            kind: 'group',
            key: keys.reserve(`#${particle.kind}`),
            compositor: particle.kind,
            occurs: particle.occurs,
            optional: groupOptional,
            members: particle.particles.flatMap((child) => membersOf(set, child, itemKeys, false, notes)),
          },
        ];
      }
      return particle.particles.flatMap((child) => membersOf(set, child, keys, groupOptional, notes));
    }
  }
}

/** An abstract type stands for its first concrete derivation, as the form model builds it. */
function concrete(set: SchemaSet, type: ComplexType): ComplexType {
  return type.abstract ? (firstConcreteDerived(set, type) ?? type) : type;
}

/** A complex type's attributes (SOAP-encoding bookkeeping left out, as the form does) and members. */
export function contentShape(set: SchemaSet, type: ComplexType, notes: string[]): ContentShape {
  const content = set.resolveContent(concrete(set, type));
  const keys = new KeySpace();
  const attributes = content.attributes
    .filter((attribute) => attribute.name.namespaceUri !== NS.SOAP11_ENC)
    .map((attribute) => ({ key: keys.attribute(attribute.name), attribute }));
  return { content, attributes, members: membersOf(set, content.particle, keys, false, notes) };
}

/** Every key a member puts in its object. */
export function memberKeys(member: Member): string[] {
  return member.kind === 'choice' ? member.branches.flat().flatMap(memberKeys) : [member.key];
}

/** Every element name a list of members can claim. */
export function namesOf(members: readonly Member[]): QName[] {
  return members.flatMap((member) => {
    switch (member.kind) {
      case 'element':
        return [...member.names];
      case 'any':
        return [];
      case 'choice':
        return member.branches.flatMap(namesOf);
      case 'group':
        return namesOf(member.members);
    }
  });
}

export function typeOfDecl(set: SchemaSet, decl: ElementDecl): ResolvedType {
  return resolveType(set, decl.type ?? decl.anonymousType);
}

/** The type of a target's content, or undefined when its element is not in the schema. */
export function targetType(set: SchemaSet, target: BridgeTarget): ResolvedType | undefined {
  if ('element' in target) {
    const decl = set.lookupElement(target.element);
    return decl === undefined ? undefined : typeOfDecl(set, decl);
  }
  return resolveType(set, target.type);
}

// ---------------------------------------------------------------------------
// Simple types
// ---------------------------------------------------------------------------

/** The value range of each built-in integer type; `undefined` where it is open. */
const INTEGER_BOUNDS: Readonly<Record<string, readonly [number | undefined, number | undefined]>> = {
  integer: [undefined, undefined],
  nonPositiveInteger: [undefined, 0],
  negativeInteger: [undefined, -1],
  long: [-(2 ** 63), 2 ** 63 - 1],
  int: [-(2 ** 31), 2 ** 31 - 1],
  short: [-32768, 32767],
  byte: [-128, 127],
  nonNegativeInteger: [0, undefined],
  unsignedLong: [0, 2 ** 64 - 1],
  unsignedInt: [0, 2 ** 32 - 1],
  unsignedShort: [0, 65535],
  unsignedByte: [0, 255],
  positiveInteger: [1, undefined],
};
const NUMBER_TYPES = new Set(['decimal', 'float', 'double']);
const FORMATS: Readonly<Record<string, string>> = { date: 'date', dateTime: 'date-time', time: 'time' };
const ENCODINGS: Readonly<Record<string, string>> = { base64Binary: 'base64', hexBinary: 'base16' };

export type JsonKind = 'integer' | 'number' | 'boolean' | 'string';

/** A simple type and the user-declared types it restricts, nearest first; built-ins end the chain. */
function simpleChain(set: SchemaSet, ref: SimpleTypeRef): SimpleType[] {
  const chain: SimpleType[] = [];
  const seen = new Set<string>();
  let current: SimpleTypeRef = ref;
  while (current !== undefined) {
    let simple: SimpleType | undefined;
    if ('kind' in current) {
      simple = current;
    } else {
      const key = qnameToString(current);
      if (seen.has(key) || set.builtin(current) !== undefined) {
        break;
      }
      seen.add(key);
      const found = set.lookupType(current);
      simple = found?.kind === 'simpleType' ? found : undefined;
    }
    if (simple === undefined) {
      break;
    }
    chain.push(simple);
    if (simple.variety !== 'atomic') {
      break;
    }
    current = simple.base ?? simple.baseType;
  }
  return chain;
}

/** The nearest facet of `kind` in a restriction chain. */
function facet<K extends Facet['kind']>(
  chain: readonly SimpleType[],
  kind: K,
): (Facet & { readonly kind: K }) | undefined {
  for (const simple of chain) {
    const found = simple.facets.find((candidate): candidate is Facet & { readonly kind: K } => candidate.kind === kind);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/** The XSD built-in a simple type restricts, by local name; undefined when it is no XSD built-in. */
function builtinLocal(set: SchemaSet, ref: SimpleTypeRef): string | undefined {
  const builtin = builtinBaseOf(set, ref);
  return builtin !== undefined && builtin.name.namespaceUri === NS.XSD ? builtin.name.localName : undefined;
}

/** The JSON type a simple type's values take. A list or union is a string. */
export function jsonKind(set: SchemaSet, ref: SimpleTypeRef): JsonKind {
  if (simpleChain(set, ref).some((simple) => simple.variety !== 'atomic')) {
    return 'string';
  }
  const local = builtinLocal(set, ref);
  if (local === undefined) {
    return 'string';
  }
  if (Object.hasOwn(INTEGER_BOUNDS, local)) {
    return 'integer';
  }
  if (NUMBER_TYPES.has(local)) {
    return 'number';
  }
  return local === 'boolean' ? 'boolean' : 'string';
}

const INTEGER_TEXT = /^[+-]?\d+$/;
const NUMBER_TEXT = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** A lexical value as its JSON type, or undefined when it is not lexically valid for it. */
export function typedLexical(kind: JsonKind, text: string): unknown {
  switch (kind) {
    case 'string':
      return text;
    case 'integer': {
      if (!INTEGER_TEXT.test(text)) return undefined;
      const value = Number(text);
      return Number.isSafeInteger(value) ? value : undefined;
    }
    case 'number':
      return NUMBER_TEXT.test(text) ? Number(text) : undefined;
    case 'boolean':
      return text === 'true' || text === '1' ? true : text === 'false' || text === '0' ? false : undefined;
  }
}

/**
 * XSD-only regex syntax that ECMAScript has no form for, and any Unicode property escape: the engine's
 * JSON Schema validator compiles patterns without the `u` flag, where `\p{…}` means a literal `p`.
 */
const XSD_ONLY_PATTERN = /\\[iIcC]|\\[pP]\{|-\[/;

/** An XSD pattern as a JSON Schema one (XSD patterns are anchored), or undefined when it has none. */
function jsonPattern(pattern: string): string | undefined {
  if (XSD_ONLY_PATTERN.test(pattern)) {
    return undefined;
  }
  const anchored = `^(?:${pattern})$`;
  try {
    return new RegExp(anchored, 'u').source.length > 0 ? anchored : undefined;
  } catch {
    return undefined;
  }
}

function simpleSchema(set: SchemaSet, ref: SimpleTypeRef, notes: string[], where: string): JsonSchemaObject {
  const chain = simpleChain(set, ref);
  if (chain.some((simple) => simple.variety !== 'atomic')) {
    return { type: 'string' };
  }
  const local = builtinLocal(set, ref);
  const kind = jsonKind(set, ref);
  const schema: JsonSchemaObject = { type: kind };
  const format = local === undefined ? undefined : FORMATS[local];
  if (format !== undefined) {
    schema['format'] = format;
  }
  const enumeration = facet(chain, 'enumeration');
  if (enumeration !== undefined) {
    schema['enum'] = enumeration.values.map((value) => typedLexical(kind, value) ?? value);
  }
  const pattern = facet(chain, 'pattern');
  if (pattern !== undefined) {
    const translated = jsonPattern(pattern.value);
    if (translated === undefined) {
      notes.push(`${where}: the XSD pattern ${pattern.value} has no JSON Schema form; the XSD check still applies it`);
    } else if (kind === 'string') {
      schema['pattern'] = translated;
    }
  }
  if (kind === 'integer' || kind === 'number') {
    const [low, high] = (local === undefined ? undefined : INTEGER_BOUNDS[local]) ?? [undefined, undefined];
    const bound = (name: 'minInclusive' | 'maxInclusive' | 'minExclusive' | 'maxExclusive'): number | undefined => {
      const found = facet(chain, name);
      const value = found === undefined ? undefined : Number(found.value);
      return value !== undefined && Number.isFinite(value) ? value : undefined;
    };
    const minimum = bound('minInclusive') ?? (bound('minExclusive') === undefined ? low : undefined);
    const maximum = bound('maxInclusive') ?? (bound('maxExclusive') === undefined ? high : undefined);
    const exclusiveMinimum = bound('minExclusive');
    const exclusiveMaximum = bound('maxExclusive');
    if (minimum !== undefined) schema['minimum'] = minimum;
    if (maximum !== undefined) schema['maximum'] = maximum;
    if (exclusiveMinimum !== undefined) schema['exclusiveMinimum'] = exclusiveMinimum;
    if (exclusiveMaximum !== undefined) schema['exclusiveMaximum'] = exclusiveMaximum;
  }
  if (kind === 'string') {
    const length = facet(chain, 'length');
    const minLength = facet(chain, 'minLength')?.value ?? length?.value;
    const maxLength = facet(chain, 'maxLength')?.value ?? length?.value;
    if (minLength !== undefined) schema['minLength'] = minLength;
    if (maxLength !== undefined) schema['maxLength'] = maxLength;
  }
  const encoding = local === undefined ? undefined : ENCODINGS[local];
  if (encoding !== undefined) {
    schema['contentEncoding'] = encoding;
  }
  return schema;
}

// ---------------------------------------------------------------------------
// JSON Schema
// ---------------------------------------------------------------------------

function arrayOf(items: JsonSchemaObject, occurs: Occurs): JsonSchemaObject {
  return {
    type: 'array',
    items,
    ...(occurs.min > 0 ? { minItems: occurs.min } : {}),
    ...(occurs.max !== 'unbounded' ? { maxItems: occurs.max } : {}),
  };
}

/** The pieces of one object schema while its members are written. */
class ObjectParts {
  readonly properties: Record<string, JsonSchemaObject> = {};
  readonly required: string[] = [];
  readonly allOf: JsonSchemaObject[] = [];

  schema(): JsonSchemaObject {
    return {
      type: 'object',
      properties: this.properties,
      ...(this.required.length > 0 ? { required: this.required } : {}),
      additionalProperties: false,
      ...(this.allOf.length > 0 ? { allOf: this.allOf } : {}),
    };
  }
}

const requiring = (keys: readonly string[]): JsonSchemaObject[] => keys.map((key) => ({ required: [key] }));

class SchemaWriter implements JsonSchemaWriter {
  private readonly found: string[] = [];
  private readonly definitions = new Map<string, JsonSchemaObject>();
  /** Clark name of a named complex type → its `$defs` key. */
  private readonly defKeys = new Map<string, string>();

  constructor(private readonly set: SchemaSet) {}

  schemaOf(target: BridgeTarget): JsonSchemaObject {
    const type = targetType(this.set, target);
    if (type === undefined) {
      this.found.push(`no element ${'element' in target ? qnameToString(target.element) : ''} in the schema`);
      return {};
    }
    return this.content(type, true, '');
  }

  defs(): JsonSchemaObject | undefined {
    return this.definitions.size === 0 ? undefined : Object.fromEntries(this.definitions);
  }

  notes(): readonly string[] {
    return this.found;
  }

  private content(type: ResolvedType, inline: boolean, where: string): JsonSchemaObject {
    switch (type.kind) {
      case 'anyType':
        return { type: 'string', description: FRAGMENT_DESCRIPTION };
      case 'soapencArray':
        this.found.push(`${where}: a SOAP-encoded array is taken as an XML fragment`);
        return { type: 'string', description: FRAGMENT_DESCRIPTION };
      case 'simple':
        return simpleSchema(this.set, type.ref, this.found, where);
      case 'complex':
        return inline || type.type.name === undefined ? this.object(type.type) : this.ref(type.type, type.type.name);
    }
  }

  private ref(type: ComplexType, name: QName): JsonSchemaObject {
    const clark = qnameToString(name);
    let key = this.defKeys.get(clark);
    if (key === undefined) {
      key = name.localName;
      for (let n = 2; this.definitions.has(key); n += 1) {
        key = `${name.localName}_${String(n)}`;
      }
      this.defKeys.set(clark, key);
      // Taken before the type is written, so a recursive reference finds it.
      this.definitions.set(key, {});
      this.definitions.set(key, this.object(type));
    }
    return { $ref: `#/$defs/${key}` };
  }

  private object(type: ComplexType): JsonSchemaObject {
    const shape = contentShape(this.set, type, this.found);
    const parts = new ObjectParts();
    for (const { key, attribute } of shape.attributes) {
      parts.properties[key] = simpleSchema(this.set, attribute.type ?? attribute.anonymousType, this.found, key);
      if (attribute.use === 'required' && attribute.fixed === undefined) {
        parts.required.push(key);
      }
    }
    if (shape.content.simpleContentBase !== undefined) {
      parts.properties['#text'] = simpleSchema(this.set, shape.content.simpleContentBase, this.found, '#text');
    } else if (shape.content.mixed) {
      parts.properties['#text'] = { type: 'string' };
    }
    for (const member of shape.members) {
      this.member(member, parts);
    }
    return parts.schema();
  }

  private member(member: Member, parts: ObjectParts): void {
    switch (member.kind) {
      case 'element': {
        const { decl } = member;
        let schema = this.content(typeOfDecl(this.set, decl), false, member.key);
        if (decl.nillable) {
          schema = { anyOf: [schema, { type: 'null' }] };
        }
        if (repeats(member.occurs)) {
          schema = arrayOf(schema, member.occurs);
        }
        if (decl.documentation !== undefined && decl.documentation.length > 0) {
          schema = { ...schema, description: decl.documentation.slice(0, MAX_PROPERTY_DESCRIPTION) };
        }
        parts.properties[member.key] = schema;
        if (!member.optional) parts.required.push(member.key);
        return;
      }
      case 'any':
        parts.properties[member.key] = { type: 'string', description: FRAGMENT_DESCRIPTION };
        if (!member.optional) parts.required.push(member.key);
        return;
      case 'group': {
        const item = new ObjectParts();
        for (const inner of member.members) {
          this.member(inner, item);
        }
        parts.properties[member.key] = arrayOf(item.schema(), member.occurs);
        if (!member.optional) parts.required.push(member.key);
        return;
      }
      case 'choice':
        this.choice(member, parts);
        return;
    }
  }

  private choice(member: Extract<Member, { kind: 'choice' }>, parts: ObjectParts): void {
    const branches = member.branches.map((branch) => {
      const inner = new ObjectParts();
      for (const child of branch) {
        this.member(child, inner);
      }
      return inner;
    });
    const keysOf = branches.map((inner) => Object.keys(inner.properties));
    const all = keysOf.flat();
    const options: JsonSchemaObject[] = branches.map((inner, index) => {
      const own = keysOf[index] ?? [];
      const others = all.filter((key) => !own.includes(key));
      return {
        ...(inner.required.length > 0 ? { required: inner.required } : own.length > 0 ? { anyOf: requiring(own) } : {}),
        ...(others.length > 0 ? { not: { anyOf: requiring(others) } } : {}),
        ...(inner.allOf.length > 0 ? { allOf: inner.allOf } : {}),
      };
    });
    const emptyLegal = member.optional || branches.some((inner) => inner.required.length === 0);
    if (emptyLegal && all.length > 0 && !keysOf.some((keys) => keys.length === 0)) {
      options.push({ not: { anyOf: requiring(all) } });
    }
    for (const inner of branches) {
      Object.assign(parts.properties, inner.properties);
    }
    if (options.length > 1) {
      parts.allOf.push({ oneOf: options });
    }
  }
}

export function createJsonSchemaWriter(schemaSet: SchemaSet): JsonSchemaWriter {
  return new SchemaWriter(schemaSet);
}

/**
 * The JSON Schema of `target`'s content: an object of its attributes (`@a`), its text (`#text`) and its
 * child elements for a complex type, the value's own schema for a simple one. Named complex types the
 * content reaches are `$defs` entries referenced with `$ref`, which also carries recursion.
 */
export function jsonSchemaOf(schemaSet: SchemaSet, target: BridgeTarget): JsonSchemaOfResult {
  const writer = createJsonSchemaWriter(schemaSet);
  const schema = writer.schemaOf(target);
  const defs = writer.defs();
  return { schema: defs === undefined ? schema : { ...schema, $defs: defs }, notes: writer.notes() };
}
