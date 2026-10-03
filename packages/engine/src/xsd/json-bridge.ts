/**
 * Between an XSD and JSON (#33 spec §3.1, §5): the JSON Schema a body element's content maps to, XML
 * written from a JSON value through the form model, and JSON read back from XML.
 *
 * All three read a complex type's content the same way, as an ordered list of {@link Member}s with
 * stable JSON keys, in the order the form model emits its nodes: so the property a value is written
 * from is the one the schema names and the one the reader fills. Pure and synchronous.
 */
import type { QName } from '../wsdl/qname.js';
import { qnameEquals, qnameToString } from '../wsdl/qname.js';
import { NS } from '../xml/namespaces.js';
import { parseXmlDetailed } from '../xml/parse.js';
import { prefixForNamespace } from '../xml/prefixes.js';
import { applyForm, buildForm, buildFormForDecl, buildFormForType, Pool } from './form-model.js';
import type { FormNode } from './form-model.js';
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
import { decodeEntities, scanXml } from './xml-scan.js';
import type { ScannedElement } from './xml-scan.js';
import { escapeAttribute, escapeText } from './xml-writer.js';

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

/** An XSD pattern's body as an ECMAScript one (XSD patterns are anchored by the caller), or undefined. */
function jsonPatternBody(pattern: string): string | undefined {
  if (XSD_ONLY_PATTERN.test(pattern)) {
    return undefined;
  }
  try {
    return new RegExp(`^(?:${pattern})$`, 'u').source.length > 0 ? pattern : undefined;
  } catch {
    return undefined;
  }
}

/** The pattern facets of the nearest restriction step that has any: alternatives of one another. */
function patternsOf(chain: readonly SimpleType[]): string[] {
  for (const simple of chain) {
    const found = simple.facets.flatMap((candidate) => (candidate.kind === 'pattern' ? [candidate.value] : []));
    if (found.length > 0) {
      return found;
    }
  }
  return [];
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
  // Several patterns in one restriction step are alternatives; a step further up is a further constraint
  // that JSON Schema's single `pattern` cannot add, so only the nearest step with patterns is used.
  const patterns = patternsOf(chain);
  if (patterns.length > 0) {
    const translated = patterns.map(jsonPatternBody);
    if (translated.some((body) => body === undefined)) {
      notes.push(
        `${where}: the XSD pattern ${patterns.join(' | ')} has no JSON Schema form; the XSD check still applies it`,
      );
    } else if (kind === 'string') {
      schema['pattern'] =
        translated.length === 1
          ? `^(?:${translated[0] ?? ''})$`
          : `^(?:${translated.map((body) => `(?:${body ?? ''})`).join('|')})$`;
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
  // On a binary type the length facets count octets, not characters: the XSD check enforces them.
  if (kind === 'string' && !(local !== undefined && Object.hasOwn(ENCODINGS, local))) {
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
  /** Anonymous complex types being written, and the `$defs` key one took when it was reached again. */
  private readonly active = new Map<ComplexType, { key: string | undefined }>();

  constructor(private readonly set: SchemaSet) {}

  schemaOf(target: BridgeTarget): JsonSchemaObject {
    const type = targetType(this.set, target);
    if (type === undefined) {
      this.found.push(`no element ${'element' in target ? qnameToString(target.element) : ''} in the schema`);
      return {};
    }
    return this.content(type, true, '', 'element' in target ? target.element.localName : target.name.localName);
  }

  defs(): JsonSchemaObject | undefined {
    return this.definitions.size === 0 ? undefined : Object.fromEntries(this.definitions);
  }

  notes(): readonly string[] {
    return this.found;
  }

  private content(type: ResolvedType, inline: boolean, where: string, label = 'Anonymous'): JsonSchemaObject {
    switch (type.kind) {
      case 'anyType':
        return { type: 'string', description: FRAGMENT_DESCRIPTION };
      case 'soapencArray':
        this.found.push(`${where}: a SOAP-encoded array is taken as an XML fragment`);
        return { type: 'string', description: FRAGMENT_DESCRIPTION };
      case 'simple':
        return simpleSchema(this.set, type.ref, this.found, where);
      case 'complex':
        if (type.type.name !== undefined) {
          return inline ? this.object(type.type) : this.ref(type.type, type.type.name);
        }
        return this.anonymous(type.type, label);
    }
  }

  /** An anonymous complex type; one that reaches itself again (through an element reference) becomes a `$defs` entry. */
  private anonymous(type: ComplexType, label: string): JsonSchemaObject {
    const active = this.active.get(type);
    if (active !== undefined) {
      active.key ??= this.freshKey(label);
      return { $ref: `#/$defs/${active.key}` };
    }
    const state: { key: string | undefined } = { key: undefined };
    this.active.set(type, state);
    const schema = this.object(type);
    this.active.delete(type);
    if (state.key === undefined) {
      return schema;
    }
    this.definitions.set(state.key, schema);
    return { $ref: `#/$defs/${state.key}` };
  }

  private freshKey(base: string): string {
    let key = base;
    for (let n = 2; this.definitions.has(key); n += 1) {
      key = `${base}_${String(n)}`;
    }
    this.definitions.set(key, {});
    return key;
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
        let schema = this.content(typeOfDecl(this.set, decl), false, member.key, decl.name.localName);
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
    if (options.length > 0) {
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

// ---------------------------------------------------------------------------
// XML from JSON
// ---------------------------------------------------------------------------

export interface XmlFromJsonOptions {
  /** The prefix already declared around the fragment, per namespace URI. */
  readonly prefixes?: Readonly<Record<string, string>>;
  /** The namespace URI per prefix declared around the fragment. */
  readonly inScope?: Readonly<Record<string, string>>;
}

export interface XmlFromJsonResult {
  readonly xml: string;
  /** What was written differently from what was asked. */
  readonly notes: readonly string[];
  /** Why the value cannot be written: a fragment that is not well formed. When any, `xml` is empty. */
  readonly problems: readonly string[];
}

/**
 * How many times one path through a value may be expanded below the form's depth cut (spec revision
 * R10), each expansion five levels deep. A value nested deeper is refused, never cut short.
 */
export const MAX_FILL_ROUNDS = 64;

type JsonObject = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A JSON scalar as text: strings as they are, numbers and booleans with `String`, anything else as
 * its JSON. The XML bridge writes element text with it; a REST tool argument's rows use it too.
 */
export function lexical(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? '';
}

/** A value's items: an array as it is, one value as a list of one, nothing as none. */
const itemsOf = (value: unknown): readonly unknown[] =>
  value === undefined ? [] : Array.isArray(value) ? (value as unknown[]) : [value];

/** A synthetic node `applyForm` writes verbatim: a mixed text run (escaped), or an XML fragment. */
function verbatim(id: string, raw: string): FormNode {
  return {
    id,
    kind: 'any',
    name: { namespaceUri: '', localName: '#text' },
    label: '',
    required: false,
    occurs: ONCE,
    present: true,
    raw,
    children: [],
  };
}

/** A node, and everything under it, left out of the document. */
function absent(node: FormNode): FormNode {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    label: node.label,
    required: node.required,
    occurs: node.occurs,
    present: false,
    ...(node.type !== undefined ? { type: node.type } : {}),
    ...(node.kind === 'field' || node.kind === 'attribute' ? { value: node.value ?? '' } : {}),
    children: node.children.map(absent),
    ...(node.choice !== undefined ? { choice: {} } : {}),
    ...(node.repeat !== undefined ? { repeat: { ...node.repeat, instances: [] } } : {}),
  };
}

/** The element a target's root is: its global declaration (an abstract head replaced), or a synthetic one. */
function rootDecl(set: SchemaSet, target: BridgeTarget): ElementDecl | undefined {
  if (!('element' in target)) {
    return {
      kind: 'element',
      name: target.name,
      type: target.type,
      nillable: false,
      abstract: false,
      source: { location: '<synthetic>' },
    };
  }
  const decl = set.lookupElement(target.element);
  if (decl === undefined || !decl.abstract) {
    return decl;
  }
  return set.substitutionsFor(decl.name).find((candidate) => !candidate.abstract) ?? decl;
}

const ENTITY_OR_REFERENCE = /^&(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);/;
const MARKUP_START = /^<[A-Za-z_:/!?]/;

/**
 * What the parser lets through that is not well formed: a `&` that starts no predefined entity or
 * character reference, and a `<` that starts no markup. CDATA sections, comments and processing
 * instructions are skipped, since both are literal there.
 */
function fragmentLexicalProblem(text: string): string | undefined {
  const outside = text.replace(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g, '');
  for (let at = outside.indexOf('&'); at !== -1; at = outside.indexOf('&', at + 1)) {
    if (!ENTITY_OR_REFERENCE.test(outside.slice(at))) {
      return `an unescaped "&" (write &amp;) at "${outside.slice(at, at + 12)}"`;
    }
  }
  for (let at = outside.indexOf('<'); at !== -1; at = outside.indexOf('<', at + 1)) {
    if (!MARKUP_START.test(outside.slice(at))) {
      return `an unescaped "<" (write &lt;) at "${outside.slice(at, at + 12)}"`;
    }
  }
  return undefined;
}

/** Fills one form tree from a JSON value, as the desktop's form edits would. */
class Filler {
  readonly notes: string[] = [];
  readonly problems: string[] = [];
  /** Namespace URI → prefix bound at the root: around the fragment, or declared on the root. */
  private readonly known: Record<string, string>;
  /** Prefix → namespace URI an expansion had to declare; hoisted to the root. */
  readonly declared: Record<string, string> = {};
  /** Expansions below the depth cut on the path being filled. */
  private expansions = 0;

  constructor(
    private readonly set: SchemaSet,
    private readonly inScope: Readonly<Record<string, string>>,
    prefixes: Readonly<Record<string, string>>,
    rootNamespaces: Readonly<Record<string, string>>,
  ) {
    this.known = { ...prefixes };
    for (const [prefix, uri] of Object.entries(rootNamespaces)) {
      this.known[uri] ??= prefix;
    }
  }

  element(node: FormNode, decl: ElementDecl, value: unknown, where: string): FormNode {
    if (value === undefined) {
      return node.kind === 'field' && node.fixed !== undefined && node.required
        ? { ...node, present: true, value: node.fixed }
        : absent(node);
    }
    if (value === null) {
      return this.nil(node, decl, where);
    }
    const resolved = typeOfDecl(this.set, decl);
    if (resolved.kind === 'anyType' || resolved.kind === 'soapencArray') {
      return this.fragment(node, lexical(value), where);
    }
    if (resolved.kind === 'simple') {
      const scalar = isObject(value) && '#text' in value ? value['#text'] : value;
      return { ...node, present: true, value: lexical(scalar) };
    }
    if (!isObject(value)) {
      this.notes.push(`${where}: expected an object; written empty`);
    }
    const fields: JsonObject = isObject(value) ? value : {};
    const shape = contentShape(this.set, resolved.type, []);
    const attributes = node.children
      .filter((child) => child.kind === 'attribute')
      .map((child) => this.attribute(child, shape, fields));
    if (node.kind === 'field') {
      // Simple content: the text beside the attributes.
      const text = fields['#text'];
      return {
        ...node,
        present: true,
        value: text === undefined ? (node.fixed ?? '') : lexical(text),
        children: attributes,
      };
    }
    if (node.truncated === true) {
      return this.expand(node, decl, value, where);
    }
    const particles = node.children.filter((child) => child.kind !== 'attribute');
    const text =
      shape.content.mixed && fields['#text'] !== undefined
        ? [verbatim(`${node.id}/t`, escapeText(lexical(fields['#text'])))]
        : [];
    return {
      ...node,
      present: true,
      children: [...attributes, ...text, ...this.members(particles, shape.members, fields, where)],
    };
  }

  /**
   * An element the form cut at its depth limit, built again from its declaration with the same
   * prefixes, so the value reaches as deep as it goes. Each item of a repeat, and each branch of a
   * repeating choice, is expanded on its own.
   */
  private expand(node: FormNode, decl: ElementDecl, value: unknown, where: string): FormNode {
    if (this.expansions >= MAX_FILL_ROUNDS) {
      this.problems.push(
        `${where}: nested more than ${String(MAX_FILL_ROUNDS)} times the form's depth limit (5 levels); it cannot be written`,
      );
      return absent(node);
    }
    const fresh = buildFormForDecl(this.set, decl, undefined, { prefixes: this.known });
    const { namespaces, ...rest } = fresh;
    for (const [prefix, uri] of Object.entries(namespaces ?? {})) {
      this.declared[prefix] = uri;
      this.known[uri] = prefix;
    }
    this.expansions += 1;
    try {
      return this.element({ ...rest, id: node.id }, decl, value, where);
    } finally {
      this.expansions -= 1;
    }
  }

  /** An `anyType` element's content: text alone as its text, markup inserted as written. */
  private fragment(node: FormNode, text: string, where: string): FormNode {
    if (!this.wellFormed(text, where)) {
      return absent(node);
    }
    if (!text.includes('<')) {
      // Written as the element's text, so no line breaks are added around it; the writer escapes it again.
      return { ...node, kind: 'field', present: true, value: decodeEntities(text), children: [] };
    }
    return { ...node, kind: 'group', present: true, children: [verbatim(`${node.id}/x`, text)] };
  }

  private nil(node: FormNode, decl: ElementDecl, where: string): FormNode {
    if (!decl.nillable) {
      this.notes.push(`${where}: null for an element that is not nillable; left out`);
      return absent(node);
    }
    const kept = (node.extraAttributes ?? []).filter((extra) => extra.name !== 'xsi:nil' && extra.name !== 'xmlns:xsi');
    return {
      ...node,
      kind: 'field',
      present: true,
      value: '',
      children: [],
      extraAttributes: [...kept, { name: 'xmlns:xsi', value: NS.XSI }, { name: 'xsi:nil', value: 'true' }],
    };
  }

  private attribute(node: FormNode, shape: ContentShape, fields: JsonObject): FormNode {
    const match = shape.attributes.find((candidate) => qnameEquals(candidate.attribute.name, node.name));
    const value = match === undefined ? undefined : fields[match.key];
    if (value === undefined) {
      return node.fixed !== undefined && node.required ? { ...node, present: true, value: node.fixed } : absent(node);
    }
    return { ...node, present: true, value: lexical(value) };
  }

  /** The particle nodes of one element (or one repeat occurrence), filled member by member. */
  private members(
    nodes: readonly FormNode[],
    members: readonly Member[],
    fields: JsonObject,
    where: string,
  ): FormNode[] {
    if (nodes.length !== members.length) {
      this.notes.push(`${where}: the form and the schema disagree on this content; it is left out`);
      return nodes.map(absent);
    }
    return members.map((member, index) => this.member(nodes[index] as FormNode, member, fields, where));
  }

  private member(node: FormNode, member: Member, fields: JsonObject, where: string): FormNode {
    switch (member.kind) {
      case 'element': {
        const value = fields[member.key];
        const at = `${where}/${member.key}`;
        if (!repeats(member.occurs)) {
          return this.element(node, member.decl, value, at);
        }
        return this.repeat(node, itemsOf(value), (slot, item, index) =>
          this.element(slot, member.decl, item, `${at}/${String(index)}`),
        );
      }
      case 'any': {
        const value = fields[member.key];
        if (value === undefined) {
          return absent(node);
        }
        const text = lexical(value);
        return this.wellFormed(text, `${where}/${member.key}`) ? { ...node, present: true, raw: text } : absent(node);
      }
      case 'choice':
        return this.choice(node, member, fields, where);
      case 'group': {
        const items = itemsOf(fields[member.key]);
        const at = `${where}/${member.key}`;
        if (member.compositor === 'choice') {
          // The form models a repeating choice as one choice node: one copy of it per item.
          const inner = member.members[0];
          if (inner?.kind !== 'choice') {
            return absent(node);
          }
          const instances = items.map((item, index) =>
            this.choice(node, inner, isObject(item) ? item : {}, `${at}/${String(index)}`),
          );
          return {
            id: node.id,
            kind: 'repeat',
            name: node.name,
            label: node.label,
            required: node.required,
            occurs: member.occurs,
            present: instances.length > 0,
            children: [],
            repeat: { instances, template: node, canAdd: true, canRemove: true },
          };
        }
        return this.repeat(node, items, (slot, item, index) => ({
          ...slot,
          present: true,
          children: this.members(slot.children, member.members, isObject(item) ? item : {}, `${at}/${String(index)}`),
        }));
      }
    }
  }

  private repeat(
    node: FormNode,
    items: readonly unknown[],
    fill: (slot: FormNode, item: unknown, index: number) => FormNode,
  ): FormNode {
    const slots = node.repeat;
    if (node.kind !== 'repeat' || slots === undefined) {
      this.notes.push(`${node.label}: the form has no repeat here; left out`);
      return absent(node);
    }
    // An occurrence an earlier round wrote is built from the XML, below the cut; a new one from the template.
    const instances = items.map((item, index) => fill(slots.instances[index] ?? slots.template, item, index));
    return { ...node, present: instances.length > 0, repeat: { ...slots, instances } };
  }

  private choice(
    node: FormNode,
    member: Extract<Member, { kind: 'choice' }>,
    fields: JsonObject,
    where: string,
  ): FormNode {
    if (node.kind !== 'choice') {
      this.notes.push(`${where}: the form has no choice here; left out`);
      return absent(node);
    }
    const chosen = member.branches.findIndex((branch) =>
      branch.flatMap(memberKeys).some((key) => fields[key] !== undefined),
    );
    const children = node.children.map((branchNode, index) => {
      const branch = member.branches[index] ?? [];
      if (index !== chosen) {
        return absent(branchNode);
      }
      const [only] = branch;
      if (branch.length === 1 && only !== undefined) {
        return this.member(branchNode, only, fields, where);
      }
      return { ...branchNode, present: true, children: this.members(branchNode.children, branch, fields, where) };
    });
    return { ...node, present: chosen !== -1, children, choice: chosen === -1 ? {} : { selected: chosen } };
  }

  /** An XML fragment is inserted as written, once it passes the lexical check and a parser reads it whole. */
  private wellFormed(text: string, where: string): boolean {
    const lexicalProblem = fragmentLexicalProblem(text);
    if (lexicalProblem !== undefined) {
      this.problems.push(`${where}: not well-formed XML: ${lexicalProblem}`);
      return false;
    }
    const declarations = Object.entries(this.inScope)
      .map(([prefix, uri]) => ` xmlns:${prefix}="${escapeAttribute(uri)}"`)
      .join('');
    try {
      const { problems } = parseXmlDetailed(`<wirebench-fragment${declarations}>${text}</wirebench-fragment>`);
      const errors = problems.filter((problem) => problem.level === 'error');
      if (errors.length === 0) {
        return true;
      }
      this.problems.push(`${where}: not well-formed XML: ${errors.map((problem) => problem.message).join('; ')}`);
    } catch (error) {
      this.problems.push(`${where}: not well-formed XML: ${error instanceof Error ? error.message : String(error)}`);
    }
    return false;
  }
}

/**
 * XML for `target` from a JSON value shaped by {@link jsonSchemaOf}: the form model is built, filled,
 * and serialised, so names, prefixes and element order are the desktop form's. Where the value reaches
 * below the form's depth cut, that element is built again from its declaration and filled in turn
 * (spec revision R10), up to {@link MAX_FILL_ROUNDS} times along one path; deeper is a problem.
 * Written with no indentation, so text values stay exact.
 */
export function xmlFromJson(
  schemaSet: SchemaSet,
  target: BridgeTarget,
  value: unknown,
  options: XmlFromJsonOptions = {},
): XmlFromJsonResult {
  const decl = rootDecl(schemaSet, target);
  if (decl === undefined) {
    const name = 'element' in target ? qnameToString(target.element) : '';
    return { xml: '', notes: [], problems: [`no element ${name} in the schema`] };
  }
  const formOptions = options.prefixes !== undefined ? { prefixes: options.prefixes } : {};
  const form =
    'element' in target
      ? buildForm(schemaSet, target.element, undefined, formOptions)
      : buildFormForType(schemaSet, target.name, target.type, undefined, formOptions);
  const filler = new Filler(schemaSet, options.inScope ?? {}, options.prefixes ?? {}, form.namespaces ?? {});
  const filled = filler.element(form, decl, value, form.label);
  if (filler.problems.length > 0) {
    return { xml: '', notes: filler.notes, problems: filler.problems };
  }
  const namespaces = { ...filled.namespaces, ...filler.declared };
  const root = Object.keys(namespaces).length > 0 ? { ...filled, namespaces } : filled;
  return { xml: applyForm(root, { indent: '' }), notes: filler.notes, problems: [] };
}

// ---------------------------------------------------------------------------
// JSON from XML
// ---------------------------------------------------------------------------

export interface JsonFromXmlResult {
  readonly value: unknown;
  /** Values that could not be typed, and elements the schema does not declare. */
  readonly notes: readonly string[];
}

/** `name`, or `name_2`, `name_3`… when `out` already has that key: where an unread child is kept. */
export function freeKey(out: Readonly<Record<string, unknown>>, name: string): string {
  let key = name;
  for (let n = 2; key in out; n += 1) {
    key = `${name}_${String(n)}`;
  }
  return key;
}

const localOf = (name: string): string => (name.includes(':') ? name.slice(name.indexOf(':') + 1) : name);

const sameName = (name: QName, el: ScannedElement): boolean =>
  name.localName === el.localName && name.namespaceUri === el.namespaceUri;

class Reader {
  readonly notes: string[] = [];

  constructor(
    private readonly set: SchemaSet,
    private readonly source: string,
  ) {}

  element(el: ScannedElement, decl: ElementDecl, where: string): unknown {
    if (
      el.attributes.some(
        (attribute) => attribute.name.endsWith(':nil') && (attribute.value === 'true' || attribute.value === '1'),
      )
    ) {
      return null;
    }
    const type = typeOfDecl(this.set, decl);
    switch (type.kind) {
      case 'anyType':
      case 'soapencArray':
        return this.inner(el);
      case 'simple':
        return this.typed(jsonKind(this.set, type.ref), el.text?.value ?? '', where);
      case 'complex':
        return this.object(el, type.type, where);
    }
  }

  private object(el: ScannedElement, type: ComplexType, where: string): Record<string, unknown> {
    const shape = contentShape(this.set, type, []);
    const out: Record<string, unknown> = {};
    for (const attribute of el.attributes) {
      if (attribute.name === 'xmlns' || attribute.name.startsWith('xmlns:')) {
        continue;
      }
      const local = localOf(attribute.name);
      const match = shape.attributes.find((candidate) => candidate.attribute.name.localName === local);
      if (match === undefined) {
        // A prefixed one (`xsi:type`, a wildcard's) is bookkeeping, not data.
        if (!attribute.name.includes(':')) {
          this.notes.push(`${where}/@${local}: not in the schema; left out`);
        }
        continue;
      }
      const ref = match.attribute.type ?? match.attribute.anonymousType;
      out[match.key] = this.typed(jsonKind(this.set, ref), attribute.value, `${where}/@${local}`);
    }
    if (shape.content.simpleContentBase !== undefined) {
      out['#text'] = this.typed(
        jsonKind(this.set, shape.content.simpleContentBase),
        el.text?.value ?? '',
        `${where}/#text`,
      );
      return out;
    }
    if (shape.content.mixed) {
      const text = this.mixedText(el);
      if (text !== '') {
        out['#text'] = text;
      }
    }
    const pool = new Pool(el.children);
    this.members(shape.members, pool, out, where);
    const leftovers = pool.leftovers();
    const wildcard = shape.members.find((member) => member.kind === 'any');
    if (leftovers.length > 0 && wildcard !== undefined) {
      out[wildcard.key] = leftovers.map((child) => this.slice(child)).join('\n');
    } else {
      for (const child of leftovers) {
        out[freeKey(out, child.localName)] = this.slice(child);
        this.notes.push(`${where}/${child.localName}: not in the schema; kept as its XML`);
      }
    }
    return out;
  }

  private members(members: readonly Member[], pool: Pool, out: Record<string, unknown>, where: string): void {
    for (const member of members) {
      switch (member.kind) {
        case 'element': {
          const at = `${where}/${member.key}`;
          if (!repeats(member.occurs)) {
            const child = pool.take(member.names);
            if (child !== undefined) {
              out[member.key] = this.element(child, this.declFor(member, child), at);
            }
            break;
          }
          const max = member.occurs.max === 'unbounded' ? Number.POSITIVE_INFINITY : member.occurs.max;
          const items: unknown[] = [];
          let child = pool.take(member.names);
          while (child !== undefined) {
            items.push(this.element(child, this.declFor(member, child), `${at}/${String(items.length)}`));
            child = items.length < max ? pool.take(member.names) : undefined;
          }
          if (items.length > 0) {
            out[member.key] = items;
          }
          break;
        }
        case 'any':
          break;
        case 'choice': {
          // The branch of the next unclaimed child, in document order, that any branch can claim.
          const next = pool
            .leftovers()
            .find((child) => namesOf(member.branches.flat()).some((name) => sameName(name, child)));
          const branch =
            next === undefined
              ? undefined
              : member.branches.find((candidate) => namesOf(candidate).some((name) => sameName(name, next)));
          if (branch !== undefined) {
            this.members(branch, pool, out, where);
          }
          break;
        }
        case 'group': {
          const names = namesOf(member.members);
          const max = member.occurs.max === 'unbounded' ? Number.POSITIVE_INFINITY : member.occurs.max;
          const items: Record<string, unknown>[] = [];
          while (items.length < max && pool.has(names)) {
            const before = pool.leftovers().length;
            const item: Record<string, unknown> = {};
            this.members(member.members, pool, item, `${where}/${member.key}/${String(items.length)}`);
            if (pool.leftovers().length === before) {
              break;
            }
            items.push(item);
          }
          if (items.length > 0) {
            out[member.key] = items;
          }
          break;
        }
      }
    }
  }

  /** The declaration for the name actually written: a substitution group member when it is one. */
  private declFor(member: Extract<Member, { kind: 'element' }>, child: ScannedElement): ElementDecl {
    const name = member.names.find((candidate) => sameName(candidate, child));
    if (name === undefined || qnameEquals(name, member.decl.name)) {
      return member.decl;
    }
    return this.set.lookupElement(name) ?? member.decl;
  }

  private typed(kind: JsonKind, text: string, where: string): unknown {
    if (kind === 'string') {
      return text;
    }
    const value = typedLexical(kind, text.trim());
    if (value === undefined) {
      this.notes.push(`${where}: "${text}" is not a valid ${kind}; kept as a string`);
      return text;
    }
    return value;
  }

  private slice(el: ScannedElement): string {
    return this.source.slice(el.range.start, el.range.end);
  }

  /** Where an element's content starts: after its start tag's `>`. */
  private contentStart(el: ScannedElement): number {
    const last = el.attributes.at(-1);
    return this.source.indexOf('>', last === undefined ? el.range.start : last.valueRange.end) + 1;
  }

  private closeStart(el: ScannedElement): number {
    return this.source.lastIndexOf('</', el.range.end);
  }

  /**
   * An `anyType` element's content as the fragment it is: its markup as written (trimmed), or its text
   * as written, entities and all, so that writing it back gives the same element.
   */
  private inner(el: ScannedElement): string {
    if (el.selfClosing) {
      return '';
    }
    const raw = this.source.slice(this.contentStart(el), this.closeStart(el));
    return el.children.length === 0 ? raw : raw.trim();
  }

  /** Mixed content's text: the runs outside the child elements, each trimmed, joined by one space. */
  private mixedText(el: ScannedElement): string {
    if (el.selfClosing) {
      return '';
    }
    if (el.children.length === 0) {
      return (el.text?.value ?? '').trim();
    }
    const bounds = [
      this.contentStart(el),
      ...el.children.flatMap((child) => [child.range.start, child.range.end]),
      this.closeStart(el),
    ];
    const runs: string[] = [];
    for (let at = 0; at + 1 < bounds.length; at += 2) {
      const raw = this.source.slice(bounds[at], bounds[at + 1]).replace(/<!--[\s\S]*?-->/g, '');
      const run = decodeEntities(raw).trim();
      if (run !== '') {
        runs.push(run);
      }
    }
    return runs.join(' ');
  }
}

/**
 * JSON for `xml` (one element, `target`'s) by the mapping of {@link jsonSchemaOf}, in reverse: arrays
 * from `maxOccurs` (one occurrence is still an array), numbers and booleans typed when lexically
 * valid, an element the schema does not declare kept as its XML text with a note.
 */
export function jsonFromXml(
  schemaSet: SchemaSet,
  target: BridgeTarget,
  xml: string,
  options: { readonly inScope?: Readonly<Record<string, string>> } = {},
): JsonFromXmlResult {
  const scanned = scanXml(xml, options.inScope ?? {});
  const root = scanned.elements[0];
  if (root === undefined) {
    return { value: undefined, notes: ['no element to read', ...scanned.problems] };
  }
  const reader = new Reader(schemaSet, xml);
  const decl = rootDecl(schemaSet, target);
  if (decl === undefined) {
    return {
      value: xml.slice(root.range.start, root.range.end),
      notes: [`${root.localName}: not in the schema; kept as its XML`],
    };
  }
  const named = schemaSet.substitutionsFor(decl.name).find((candidate) => sameName(candidate.name, root));
  const value = reader.element(root, named ?? decl, root.localName);
  return { value, notes: reader.notes };
}
