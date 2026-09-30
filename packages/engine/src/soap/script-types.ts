/**
 * SOAP script types and the XML projection they describe (spec §Types, SOAP).
 *
 * One walk over the schema serves three uses:
 * - `soapScriptTypes` declares `WbSoapRequestBody` / `WbSoapResponseBody` from the operation's input
 *   and output elements;
 * - `projectXml` turns the body element of an envelope into the object those types describe;
 * - `serializeProjection` turns such an object back into XML, in schema order.
 *
 * The mapping: an element is a field named by its local name (by `{namespace}local` when two
 * children of one parent share a local name); `maxOccurs > 1` (on it or an enclosing compositor)
 * is an array; `minOccurs="0"`, or sitting in a choice, is optional; `nillable` adds `| null`; an
 * attribute is `"@name"`; the text of a simple-content element with attributes is `"#text"`;
 * `xs:any` is not projected. `xs:boolean` is a boolean, the 32-bit and floating-point numbers are
 * numbers, and `xs:long`, `xs:integer` and `xs:decimal` stay strings, since a number would lose
 * precision. An enumeration is a union of literals. Mixed content is not projected.
 */
import type { QName } from '../wsdl/qname.js';
import { qnameToString } from '../wsdl/qname.js';
import { findBinding, findMessage, findPortType, type WsdlDefinition } from '../wsdl/model.js';
import type { ComplexType, ElementDecl, Occurs, Particle, ResolvedAttribute, SimpleType } from '../xsd/model.js';
import { resolveType } from '../xsd/sample-types.js';
import { builtinBaseOf, facetsOf } from '../xsd/sample-values.js';
import type { SchemaSet } from '../xsd/schema-set.js';
import { scanXml, type ScannedElement } from '../xsd/xml-scan.js';
import { NS } from '../xml/namespaces.js';
import { propertyKey } from '../script/types/json-schema.js';

/** Past these the projection widens to `unknown`, and the walk stops. */
const LIMITS = { depth: 32, aliases: 500 } as const;

const NUMBER_TYPES = new Set([
  'int',
  'short',
  'byte',
  'unsignedInt',
  'unsignedShort',
  'unsignedByte',
  'float',
  'double',
]);

type Scalar = 'string' | 'number' | 'boolean';

/** One child element a complex type can hold. */
export interface ElementSlot {
  /** The key it has in the projection. */
  readonly key: string;
  readonly decl: ElementDecl;
  readonly many: boolean;
  readonly optional: boolean;
}

function isMany(occurs: Occurs): boolean {
  return occurs.max === 'unbounded' || occurs.max > 1;
}

function declOf(set: SchemaSet, particle: Particle): ElementDecl | undefined {
  if (particle.kind === 'localElement') return particle.decl;
  if (particle.kind === 'elementRef') return set.lookupElement(particle.ref);
  return undefined;
}

/** The child elements a content particle allows, in schema order. */
export function elementSlots(set: SchemaSet, particle: Particle | undefined): ElementSlot[] {
  const found: { decl: ElementDecl; many: boolean; optional: boolean }[] = [];
  const walk = (p: Particle, many: boolean, optional: boolean, inChoice: boolean, depth: number): void => {
    if (depth > LIMITS.depth) return;
    const here = many || isMany(p.occurs);
    const opt = optional || p.occurs.min === 0 || inChoice;
    if (p.kind === 'sequence' || p.kind === 'all' || p.kind === 'choice') {
      for (const child of p.particles) walk(child, here, opt, p.kind === 'choice', depth + 1);
      return;
    }
    if (p.kind === 'groupRef') {
      const group = set.lookupGroup(p.ref);
      if (group !== undefined) walk(group.particle, here, opt, false, depth + 1);
      return;
    }
    const decl = declOf(set, p);
    if (decl !== undefined) found.push({ decl, many: here, optional: opt });
  };
  if (particle !== undefined) walk(particle, false, false, false, 0);

  // The same element twice in one content model (a, b, a) is one field holding every occurrence.
  const merged = new Map<string, { decl: ElementDecl; many: boolean; optional: boolean }>();
  for (const slot of found) {
    const id = qnameToString(slot.decl.name);
    const previous = merged.get(id);
    merged.set(
      id,
      previous === undefined ? slot : { decl: previous.decl, many: true, optional: previous.optional && slot.optional },
    );
  }
  const localCounts = new Map<string, number>();
  for (const { decl } of merged.values()) {
    localCounts.set(decl.name.localName, (localCounts.get(decl.name.localName) ?? 0) + 1);
  }
  return [...merged.values()].map((slot) => ({
    ...slot,
    key:
      (localCounts.get(slot.decl.name.localName) ?? 0) > 1 ? qnameToString(slot.decl.name) : slot.decl.name.localName,
  }));
}

function scalarOf(set: SchemaSet, ref: QName | SimpleType | undefined): Scalar {
  const builtin = builtinBaseOf(set, ref);
  if (builtin === undefined || builtin.name.namespaceUri !== NS.XSD) return 'string';
  if (builtin.name.localName === 'boolean') return 'boolean';
  return NUMBER_TYPES.has(builtin.name.localName) ? 'number' : 'string';
}

function scalarType(set: SchemaSet, ref: QName | SimpleType | undefined): string {
  const values = facetsOf(set, ref).enum;
  const scalar = scalarOf(set, ref);
  if (values !== undefined && values.length > 0) {
    if (scalar === 'number' && values.every((v) => Number.isFinite(Number(v)))) return values.join(' | ');
    return values.map((v) => JSON.stringify(v)).join(' | ');
  }
  return scalar;
}

function attributeKey(attribute: ResolvedAttribute): string {
  return `@${attribute.name.localName}`;
}

/** The type of an element's value, declaring an alias for each named complex type it meets. */
class XsdTypes {
  private readonly aliases = new Map<string, string>();
  private readonly declared: string[] = [];

  constructor(private readonly set: SchemaSet) {}

  element(decl: ElementDecl, depth: number): string {
    const type = this.valueOf(decl.type ?? decl.anonymousType, depth);
    return decl.nillable && type !== 'unknown' ? `${type} | null` : type;
  }

  private valueOf(ref: QName | ComplexType | SimpleType | undefined, depth: number): string {
    if (depth > LIMITS.depth) return 'unknown';
    const resolved = resolveType(this.set, ref);
    switch (resolved.kind) {
      case 'simple':
        return scalarType(this.set, resolved.ref);
      case 'complex':
        return this.complex(resolved.type, depth);
      default:
        return 'unknown';
    }
  }

  private complex(type: ComplexType, depth: number): string {
    if (type.name === undefined) return this.complexBody(type, depth);
    const id = qnameToString(type.name);
    const existing = this.aliases.get(id);
    if (existing !== undefined) return existing;
    if (this.aliases.size >= LIMITS.aliases) return 'unknown';
    const alias = `WbX_${type.name.localName.replace(/[^A-Za-z0-9_]/g, '_')}_${String(this.aliases.size + 1)}`;
    this.aliases.set(id, alias);
    this.declared.push(`/** ${id} */\ntype ${alias} = ${this.complexBody(type, depth)};\n`);
    return alias;
  }

  private complexBody(type: ComplexType, depth: number): string {
    const content = this.set.resolveContent(type);
    const lines: string[] = [];
    for (const attribute of content.attributes) {
      const optional = attribute.use === 'required' ? '' : '?';
      lines.push(
        `  ${JSON.stringify(attributeKey(attribute))}${optional}: ${scalarType(this.set, attribute.type ?? attribute.anonymousType)};\n`,
      );
    }
    if (content.simpleContentBase !== undefined) {
      const text = scalarType(this.set, content.simpleContentBase);
      if (content.attributes.length === 0) return text;
      lines.push(`  "#text": ${text};\n`);
    }
    for (const slot of elementSlots(this.set, content.particle)) {
      const value = this.element(slot.decl, depth + 1);
      const item = /^[A-Za-z0-9_$"]+$/.test(value) ? value : `(${value})`;
      lines.push(`  ${propertyKey(slot.key)}${slot.optional ? '?' : ''}: ${slot.many ? `${item}[]` : value};\n`);
    }
    return lines.length === 0 ? 'Record<string, never>' : `{\n${lines.join('')}}`;
  }

  declarations(): string {
    return this.declared.join('');
  }
}

/** `WbSoapRequestBody` and `WbSoapResponseBody` for an operation's input and output elements. */
export function soapScriptTypes(set: SchemaSet | undefined, input?: QName, output?: QName): string {
  const lines: string[] = [];
  const types = set !== undefined ? new XsdTypes(set) : undefined;
  const bodyOf = (name: QName | undefined): string => {
    const decl = name !== undefined ? set?.lookupElement(name) : undefined;
    return decl !== undefined && types !== undefined ? types.element(decl, 0) : 'unknown';
  };
  const request = bodyOf(input);
  const response = bodyOf(output);
  if (request === 'unknown' || response === 'unknown') {
    lines.push('// A body this operation does not describe with a schema element is untyped; use envelope and select.');
  }
  lines.push(
    types?.declarations() ?? '',
    `type WbSoapRequestBody = ${request};`,
    `type WbSoapResponseBody = ${response};`,
    '',
  );
  return lines.join('\n');
}

// --- The projection -----------------------------------------------------------------------------

function toScalar(text: string, scalar: Scalar): string | number | boolean {
  const trimmed = text.trim();
  if (scalar === 'boolean') return trimmed === 'true' || trimmed === '1';
  if (scalar === 'number') {
    const n = Number(trimmed);
    return trimmed !== '' && Number.isFinite(n) ? n : text;
  }
  return text;
}

function isNil(element: ScannedElement): boolean {
  return element.attributes.some(
    (a) => (a.name === 'xsi:nil' || a.name.endsWith(':nil')) && (a.value === 'true' || a.value === '1'),
  );
}

/** The text of an element: its own text, or empty. */
function textOf(element: ScannedElement): string {
  return element.text?.value ?? '';
}

function decodeEntities(text: string): string {
  return text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (whole, name: string) => {
    switch (name) {
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'amp':
        return '&';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        const code = name.startsWith('#x') ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
    }
  });
}

/** The value `element` holds as `decl` describes it. */
export function projectElement(set: SchemaSet, decl: ElementDecl, element: ScannedElement, depth = 0): unknown {
  if (depth > LIMITS.depth) return undefined;
  if (decl.nillable && isNil(element)) return null;
  const resolved = resolveType(set, decl.type ?? decl.anonymousType);
  if (resolved.kind === 'simple') {
    return toScalar(decodeEntities(textOf(element)), scalarOf(set, resolved.ref));
  }
  if (resolved.kind !== 'complex') return undefined;
  const content = set.resolveContent(resolved.type);
  const out: Record<string, unknown> = {};
  for (const attribute of content.attributes) {
    const found = element.attributes.find(
      (a) =>
        (a.name.includes(':') ? a.name.split(':')[1] : a.name) === attribute.name.localName &&
        !a.name.startsWith('xmlns'),
    );
    if (found !== undefined) {
      out[attributeKey(attribute)] = toScalar(
        decodeEntities(found.value),
        scalarOf(set, attribute.type ?? attribute.anonymousType),
      );
    }
  }
  if (content.simpleContentBase !== undefined) {
    const text = toScalar(decodeEntities(textOf(element)), scalarOf(set, content.simpleContentBase));
    if (content.attributes.length === 0) return text;
    out['#text'] = text;
    return out;
  }
  const slots = elementSlots(set, content.particle);
  for (const child of element.children) {
    const slot = slots.find(
      (s) => s.decl.name.localName === child.localName && s.decl.name.namespaceUri === child.namespaceUri,
    );
    if (slot === undefined) continue;
    const value = projectElement(set, slot.decl, child, depth + 1);
    if (slot.many) {
      const list = (out[slot.key] as unknown[] | undefined) ?? [];
      list.push(value);
      out[slot.key] = list;
    } else {
      out[slot.key] = value;
    }
  }
  return out;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function scalarText(value: unknown): string {
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return String(value);
  throw new TypeError(`expected a string, number or boolean, got ${value === null ? 'null' : typeof value}`);
}

/**
 * `value` as the XML for `decl`, children in schema order. A namespace is declared as the default
 * wherever it changes from the parent's, so the fragment stands on its own inside any envelope.
 *
 * @throws TypeError when `value` does not have the shape the schema needs
 */
export function serializeElement(
  set: SchemaSet,
  decl: ElementDecl,
  value: unknown,
  parentNamespace: string | undefined,
  depth = 0,
): string {
  if (depth > LIMITS.depth) throw new TypeError('the body is nested too deeply');
  const name = decl.name.localName;
  const namespace = decl.name.namespaceUri;
  const xmlns = namespace === parentNamespace ? '' : ` xmlns="${escapeXml(namespace)}"`;
  if (value === null) {
    if (!decl.nillable) throw new TypeError(`${name} cannot be null`);
    return `<${name}${xmlns} xmlns:xsi="${NS.XSI}" xsi:nil="true"/>`;
  }
  const resolved = resolveType(set, decl.type ?? decl.anonymousType);
  if (resolved.kind === 'simple') {
    return `<${name}${xmlns}>${escapeXml(scalarText(value))}</${name}>`;
  }
  if (resolved.kind !== 'complex') throw new TypeError(`${name} has no schema type a script can write`);
  const content = set.resolveContent(resolved.type);
  if (content.simpleContentBase !== undefined && content.attributes.length === 0) {
    return `<${name}${xmlns}>${escapeXml(scalarText(value))}</${name}>`;
  }
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const record = value as Record<string, unknown>;
  let attributes = '';
  for (const attribute of content.attributes) {
    const v = record[attributeKey(attribute)];
    if (v !== undefined) attributes += ` ${attribute.name.localName}="${escapeXml(scalarText(v))}"`;
  }
  if (content.simpleContentBase !== undefined) {
    const text = record['#text'];
    return `<${name}${xmlns}${attributes}>${text === undefined ? '' : escapeXml(scalarText(text))}</${name}>`;
  }
  const children: string[] = [];
  for (const slot of elementSlots(set, content.particle)) {
    const v = record[slot.key];
    if (v === undefined) continue;
    const items = slot.many ? (Array.isArray(v) ? v : [v]) : [v];
    for (const item of items) children.push(serializeElement(set, slot.decl, item, namespace, depth + 1));
  }
  return children.length === 0
    ? `<${name}${xmlns}${attributes}/>`
    : `<${name}${xmlns}${attributes}>${children.join('')}</${name}>`;
}

/** The first element inside the envelope's SOAP Body, if the envelope has one. */
export function soapBodyElement(envelope: string): ScannedElement | undefined {
  const root = scanXml(envelope).elements[0];
  if (root?.localName !== 'Envelope') return undefined;
  const body = root.children.find(
    (child) =>
      child.localName === 'Body' && (child.namespaceUri === NS.SOAP11_ENV || child.namespaceUri === NS.SOAP12_ENV),
  );
  return body?.children[0];
}

/** The projection of the envelope's body element, when `element` names its declaration. */
export function projectSoapBody(set: SchemaSet | undefined, element: QName | undefined, envelope: string): unknown {
  const decl = element !== undefined ? set?.lookupElement(element) : undefined;
  const body = soapBodyElement(envelope);
  if (set === undefined || decl === undefined || body === undefined) return undefined;
  if (body.localName !== decl.name.localName || body.namespaceUri !== decl.name.namespaceUri) return undefined;
  return projectElement(set, decl, body);
}

/**
 * The envelope with its body element replaced by `value` written as `element`. Everything outside
 * the body element is kept byte for byte.
 *
 * @throws TypeError when the envelope has no body element or `value` does not fit the schema
 */
export function replaceSoapBody(set: SchemaSet, element: QName, envelope: string, value: unknown): string {
  const decl = set.lookupElement(element);
  const body = soapBodyElement(envelope);
  if (decl === undefined || body === undefined) throw new TypeError('the envelope has no body element to replace');
  const xml = serializeElement(set, decl, value, undefined);
  return envelope.slice(0, body.range.start) + xml + envelope.slice(body.range.end);
}

/** `{namespace}local` as a QName. */
export function qnameFromClark(clark: string): QName {
  const match = /^\{([^}]*)\}(.*)$/.exec(clark);
  return match === null ? { namespaceUri: '', localName: clark } : { namespaceUri: match[1]!, localName: match[2]! };
}

/**
 * The elements a document-style SOAP operation's input and output messages name, when each message
 * has exactly one element part — the shape a typed body needs. An RPC-style operation, or a message
 * of type parts, has none.
 */
export function soapOperationElements(
  definition: WsdlDefinition,
  bindingName: string,
  operationName: string,
): { readonly input?: QName; readonly output?: QName } {
  const binding = findBinding(definition, qnameFromClark(bindingName));
  if (binding === undefined) return {};
  const bindingOperation = binding.operations.find((op) => op.name === operationName);
  // An operation's own style overrides its binding's.
  if ((bindingOperation?.style ?? binding.style) === 'rpc') return {};
  const operation = findPortType(definition, binding.type)?.operations.find((op) => op.name === operationName);
  const elementOf = (ref: { readonly message: QName } | undefined): QName | undefined => {
    const message = ref === undefined ? undefined : findMessage(definition, ref.message);
    const elements = message?.parts.filter((part) => part.element !== undefined) ?? [];
    return elements.length === 1 ? elements[0]!.element : undefined;
  };
  const input = elementOf(operation?.input);
  const output = elementOf(operation?.output);
  return { ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}) };
}
