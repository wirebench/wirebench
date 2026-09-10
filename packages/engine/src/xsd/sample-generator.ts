import { SchemaError } from '../errors.js';
import { NS } from '../xml/namespaces.js';
import type { QName } from '../wsdl/qname.js';
import { qnameToString } from '../wsdl/qname.js';
import type { ComplexType, ElementDecl, Occurs, Particle, ResolvedAttribute } from './model.js';
import type { SchemaSet } from './schema-set.js';
import { arrayTypeOf, firstConcreteDerived, resolveType } from './sample-types.js';
import type { SimpleTypeRef } from './sample-values.js';
import { PLACEHOLDER, sampleValueFor, typeCommentFor } from './sample-values.js';
import type { XmlElementNode, XmlNode } from './xml-writer.js';
import { PrefixTable, comment, element as xmlElement, renderXml } from './xml-writer.js';

/** How a sample fragment is generated. */
export interface GenerateOptions {
  /** Emit `minOccurs="0"` elements (preceded by `<!--Optional:-->`) and optional attributes. */
  readonly includeOptional: boolean;
  /** Emit type-appropriate example values instead of the `?` placeholder. */
  readonly sampleValues: boolean;
  /** Emit `<!--type: xs:int-->` comments on simple-typed leaves. */
  readonly typeComments: boolean;
  /** Nesting depth of complex elements after which generation is cut with a comment. */
  readonly maxDepth: number;
  /** Choice strategy; only `'first'` exists today (all alternatives are shown, the first is canonical). */
  readonly choice: 'first';
  /** Indent per level; three spaces by default, matching SoapUI. */
  readonly indent?: string;
  /** Preferred prefix per namespace URI; unlisted namespaces get `ns1`, `ns2`, … in first-use order. */
  readonly prefixes?: Readonly<Record<string, string>>;
}

/** The defaults every generator entry point starts from. */
export const DEFAULT_GENERATE_OPTIONS: GenerateOptions = {
  includeOptional: false,
  sampleValues: false,
  typeComments: false,
  maxDepth: 5,
  choice: 'first',
  indent: '   ',
};

/** A generated XML fragment plus the namespaces its root declares. */
export interface GeneratedFragment {
  /** The pretty-printed fragment; no XML declaration. */
  readonly xml: string;
  /** Prefix → namespace URI for every namespace the fragment actually uses. */
  readonly namespaces: Readonly<Record<string, string>>;
}

interface Context {
  readonly set: SchemaSet;
  readonly options: GenerateOptions;
  readonly prefixes: PrefixTable;
}

/**
 * Fills `node` with the `soapenc:arrayType` attribute and a single `item`
 * child. `itemType` is the array's item type; when it is unknown (a schema that
 * declares no `wsdl:arrayType`) the array is reported as `xs:anyType[1]`.
 */
function fillSoapEncArray(ctx: Context, node: XmlElementNode, itemType: QName | undefined): void {
  const item = itemType ?? { namespaceUri: NS.XSD, localName: 'anyType' };
  const label = ctx.prefixes.qualify(item, item.namespaceUri === NS.XSD ? 'xs' : undefined);
  node.attributes.push({
    name: `${ctx.prefixes.prefixFor(NS.SOAP11_ENC, 'soapenc')}:arrayType`,
    // The declared bound is replaced by the number of items actually emitted.
    value: `${label}[1]`,
  });
  const child = xmlElement('item');
  child.text = itemType === undefined ? PLACEHOLDER : sampleValueFor(ctx.set, itemType, ctx.options);
  node.children.push(child);
}

/**
 * Interprets a `wsdl:arrayType` value such as `xs:string[]`. Only the local
 * name survives in the schema model, so a built-in name is taken to be the XSD
 * type of that name and anything else is left unresolved.
 */
function parseArrayItemType(ctx: Context, rawArrayType: string | undefined): QName | undefined {
  if (rawArrayType === undefined) {
    return undefined;
  }
  const withoutBounds = rawArrayType.replace(/\[[^\]]*\]\s*$/, '').trim();
  const local = withoutBounds.includes(':') ? withoutBounds.slice(withoutBounds.indexOf(':') + 1) : withoutBounds;
  const candidate: QName = { namespaceUri: NS.XSD, localName: local };
  return ctx.set.builtin(candidate) !== undefined ? candidate : undefined;
}

/** Sets a leaf's text (and optional type comment), honouring a `fixed`/`default` value. */
function fillLeaf(ctx: Context, node: XmlElementNode, ref: SimpleTypeRef, forced: string | undefined): void {
  node.text = forced ?? sampleValueFor(ctx.set, ref, ctx.options);
  if (ctx.options.typeComments) {
    const text = typeCommentFor(ctx.set, ref);
    if (text !== undefined) {
      node.leadingComment = text;
    }
  }
}

function attributeValue(ctx: Context, attribute: ResolvedAttribute): string {
  return (
    attribute.fixed ??
    attribute.default ??
    sampleValueFor(ctx.set, attribute.type ?? attribute.anonymousType, ctx.options)
  );
}

/** Fills a complex-typed element: attributes, then simple content or child particles. */
function fillComplex(ctx: Context, node: XmlElementNode, complexType: ComplexType, depth: number): void {
  let effective = complexType;
  if (complexType.abstract) {
    const concrete = firstConcreteDerived(ctx.set, complexType);
    if (concrete?.name !== undefined) {
      effective = concrete;
      node.attributes.push({
        name: `${ctx.prefixes.prefixFor(NS.XSI, 'xsi')}:type`,
        value: ctx.prefixes.qualify(concrete.name),
      });
    }
  }
  const resolved = ctx.set.resolveContent(effective);
  if (effective.content.kind === 'complexContent' && ctx.set.builtin(effective.content.base)?.soapEncArray === true) {
    fillSoapEncArray(ctx, node, parseArrayItemType(ctx, arrayTypeOf(resolved.attributes)));
    return;
  }
  for (const attribute of resolved.attributes) {
    if (attribute.use === 'optional' && !ctx.options.includeOptional) {
      continue;
    }
    if (attribute.name.namespaceUri === NS.SOAP11_ENC) {
      continue;
    }
    node.attributes.push({ name: ctx.prefixes.qualify(attribute.name), value: attributeValue(ctx, attribute) });
  }
  if (resolved.simpleContentBase !== undefined) {
    fillLeaf(ctx, node, resolved.simpleContentBase, undefined);
    return;
  }
  if (resolved.particle !== undefined) {
    emitParticle(ctx, resolved.particle, node.children, depth + 1);
  }
}

/** The SoapUI comment introducing a particle's occurrence constraints, if any. */
function occurrenceComment(occurs: Occurs): string | undefined {
  if (occurs.max === 'unbounded' || occurs.max > 1) {
    if (occurs.min === 0) {
      return 'Zero or more repetitions:';
    }
    return occurs.min === 1 ? '1 or more repetitions:' : `${occurs.min} or more repetitions:`;
  }
  return occurs.min === 0 ? 'Optional:' : undefined;
}

/** Builds one element instance, or the recursion-cut comment when it is too deep. */
function emitElement(ctx: Context, decl: ElementDecl, depth: number): XmlNode {
  // An abstract head element is never valid on the wire: emit the first
  // concrete member of its substitution group instead.
  let effective = decl;
  if (decl.abstract) {
    const member = ctx.set.substitutionsFor(decl.name).find((candidate) => !candidate.abstract);
    if (member !== undefined) {
      effective = member;
    }
  }
  const resolved = resolveType(ctx.set, effective.type ?? effective.anonymousType);
  if ((resolved.kind === 'complex' || resolved.kind === 'soapencArray') && depth > ctx.options.maxDepth) {
    const label =
      resolved.kind === 'complex' && resolved.type.name !== undefined
        ? ctx.prefixes.qualify(resolved.type.name)
        : ctx.prefixes.qualify(effective.name);
    return comment(`Recursion depth exceeded (${label})`);
  }
  const node = xmlElement(ctx.prefixes.qualify(effective.name));
  const forced = effective.fixed ?? effective.default;
  switch (resolved.kind) {
    case 'complex':
      fillComplex(ctx, node, resolved.type, depth);
      break;
    case 'soapencArray':
      fillSoapEncArray(ctx, node, undefined);
      break;
    case 'anyType':
      node.text = forced ?? PLACEHOLDER;
      break;
    default:
      fillLeaf(ctx, node, resolved.ref, forced);
  }
  return node;
}

/** Emits one instance of an element particle, with its occurrence comment. */
function emitElementParticle(ctx: Context, decl: ElementDecl, occurs: Occurs, out: XmlNode[], depth: number): void {
  if (occurs.min === 0 && !ctx.options.includeOptional) {
    return;
  }
  const node = emitElement(ctx, decl, depth);
  // A cut-off element is replaced by its comment, so the occurrence comment
  // that would introduce it is dropped rather than left dangling.
  if (node.kind === 'element') {
    const text = occurrenceComment(occurs);
    if (text !== undefined) {
      out.push(comment(text));
    }
  }
  out.push(node);
}

function emitParticle(ctx: Context, particle: Particle, out: XmlNode[], depth: number): void {
  switch (particle.kind) {
    case 'localElement':
      emitElementParticle(ctx, particle.decl, particle.occurs, out, depth);
      return;
    case 'elementRef': {
      const decl = ctx.set.lookupElement(particle.ref);
      if (decl !== undefined) {
        emitElementParticle(ctx, decl, particle.occurs, out, depth);
      }
      return;
    }
    case 'any':
      out.push(comment('You may enter ANY elements at this point'));
      return;
    case 'groupRef': {
      const group = ctx.set.lookupGroup(particle.ref);
      if (group !== undefined) {
        emitParticle(ctx, { ...group.particle, occurs: particle.occurs }, out, depth);
      }
      return;
    }
    default: {
      if (particle.occurs.min === 0 && !ctx.options.includeOptional) {
        return;
      }
      const text = occurrenceComment(particle.occurs);
      if (text !== undefined) {
        out.push(comment(text));
      }
      if (particle.kind === 'choice') {
        // SoapUI announces the alternatives and then emits every one of them,
        // leaving the user to delete the ones they do not want.
        out.push(comment(`You have a CHOICE of the next ${particle.particles.length} items at this level`));
      }
      for (const child of particle.particles) {
        emitParticle(ctx, child, out, depth);
      }
    }
  }
}

function createContext(set: SchemaSet, options: Partial<GenerateOptions> | undefined): Context {
  const merged: GenerateOptions = { ...DEFAULT_GENERATE_OPTIONS, ...options };
  return { set, options: merged, prefixes: new PrefixTable(merged.prefixes ?? {}) };
}

function finish(ctx: Context, node: XmlElementNode): GeneratedFragment {
  const namespaces = ctx.prefixes.namespaces();
  // Namespace declarations live on the fragment's root; the request builder
  // hoists them onto the envelope later.
  node.attributes = [
    ...Object.entries(namespaces).map(([prefix, uri]) => ({ name: `xmlns:${prefix}`, value: uri })),
    ...node.attributes,
  ];
  return { xml: renderXml(node, ctx.options.indent ?? '   '), namespaces };
}

/**
 * Generates a sample XML fragment for a global element declaration, following
 * SoapUI's conventions: `?` placeholders (or typed sample values), comment
 * markers for optional, repeating and choice particles, `xsi:type` for abstract
 * types, and a recursion cut-off at {@link GenerateOptions.maxDepth}.
 *
 * Deterministic: identical inputs always produce byte-identical output.
 *
 * @throws {SchemaError} when `element` is not a global element in `schemaSet`
 */
export function generateElement(
  schemaSet: SchemaSet,
  element: QName,
  options?: Partial<GenerateOptions>,
): GeneratedFragment {
  const decl = schemaSet.lookupElement(element);
  if (decl === undefined) {
    throw new SchemaError('schema/unknown-element', `No global element declaration for ${qnameToString(element)}`, {
      details: { element: qnameToString(element) },
    });
  }
  const ctx = createContext(schemaSet, options);
  const node = emitElement(ctx, decl, 0);
  if (node.kind !== 'element') {
    throw new SchemaError('schema/unknown-element', `Could not generate a sample for ${qnameToString(element)}`);
  }
  return finish(ctx, node);
}

/**
 * Generates a sample fragment for an element named `elementName` whose content
 * is described by `type` — the shape rpc-style message parts take, where the
 * part declares a type rather than an element.
 */
export function generateType(
  schemaSet: SchemaSet,
  elementName: QName,
  type: QName,
  options?: Partial<GenerateOptions>,
): GeneratedFragment {
  const ctx = createContext(schemaSet, options);
  const node = xmlElement(ctx.prefixes.qualify(elementName));
  const resolved = resolveType(ctx.set, type);
  switch (resolved.kind) {
    case 'complex':
      fillComplex(ctx, node, resolved.type, 0);
      break;
    case 'soapencArray':
      fillSoapEncArray(ctx, node, undefined);
      break;
    case 'anyType':
      node.text = PLACEHOLDER;
      break;
    default:
      fillLeaf(ctx, node, resolved.ref, undefined);
  }
  return finish(ctx, node);
}

/**
 * Generates the wrapper for a SOAP-encoded array (rpc/encoded), carrying a
 * `soapenc:arrayType` attribute and one `item` child:
 * `<ns1:items soapenc:arrayType="xs:string[1]"><item>?</item></ns1:items>`.
 */
export function generateSoapEncArray(
  schemaSet: SchemaSet,
  elementName: QName,
  itemType: QName,
  options?: Partial<GenerateOptions>,
): GeneratedFragment {
  const ctx = createContext(schemaSet, options);
  const node = xmlElement(ctx.prefixes.qualify(elementName));
  fillSoapEncArray(ctx, node, itemType);
  return finish(ctx, node);
}
